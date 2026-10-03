/**
 * SSH remote executor (ssh2).
 *
 * One `Client` is reused for the lifetime of the executor so that a deployment
 * opens a single connection. Connection loss is retried by the retry layer, which
 * relies on errors carrying `severity: 'transient'`.
 *
 * Host key handling: strict checking is the default. An unknown host is a fatal
 * error unless the operator opts out explicitly (SPEC §58).
 */

import { Client, type ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransportError, RemoteCommandError } from '../../core/errors/errors.js';
import { redactOutput } from '../../utils/redact.js';
import { commandLine } from '../../utils/shell.js';
import { buildHostVerifier } from '../ssh/known-hosts.js';
import { DEFAULT_TIMEOUTS, type ExecOptions, type ExecResult, type ExecutorInfo, type RemoteExecutor } from './types.js';
import type { ServerProfile } from '../../core/config/schema.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export interface SshExecutorOptions {
  profile: ServerProfile;
  logger?: Logger;
  /** Injectable for tests. */
  clientFactory?: (config: ConnectConfig) => Client;
}

export class SshExecutor implements RemoteExecutor {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly logger: Logger;
  private readonly factory: (config: ConnectConfig) => Client;

  constructor(private readonly options: SshExecutorOptions) {
    this.logger = options.logger ?? nullLogger();
    this.factory = options.clientFactory ?? ((config) => new Client());
  }

  private get profile(): ServerProfile {
    return this.options.profile;
  }

  private connectConfig(): ConnectConfig {
    const profile = this.profile;
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: DEFAULT_TIMEOUTS.ssh,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
    };

    if (profile.sshKey) {
      const keyPath = expandHome(profile.sshKey);
      try {
        config.privateKey = fs.readFileSync(keyPath);
      } catch (cause) {
        throw new TransportError(`Unable to read SSH private key at ${keyPath}.`, {
          cause,
          remediation: [
            `Check the file exists and is readable at ${keyPath}`,
            'Alternatively configure password authentication in the server profile.',
          ],
        });
      }
      if (profile.passphrase) config.passphrase = profile.passphrase;
    } else if (profile.password) {
      config.password = profile.password;
    } else if (profile.agent) {
      // ssh2 reads the agent socket from SSH_AUTH_SOCK.
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new TransportError('agent authentication requested but SSH_AUTH_SOCK is not set.', {
          remediation: ['Start ssh-agent and add your key: eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519'],
        });
      }
      config.agent = sock;
    } else {
      throw new TransportError(
        `No SSH credential configured for server "${profile.name}".`,
        {
          remediation: [
            `Run: laravel-deploy server set ${profile.name} --ssh-key ~/.ssh/id_ed25519`,
            'Or set a password, or enable agent forwarding.',
          ],
        },
      );
    }

    // ssh2 auto-accepts any key when hostVerifier is unset, so this branch is
    // what makes strictHostKeyChecking mean anything. It also throws for an
    // unknown host, which is the behaviour SPEC §58 promises.
    const verifier = buildHostVerifier(profile);
    if (verifier) {
      config.hostVerifier = verifier;
    } else {
      this.logger.warn('SSH host key checking is disabled for this server.', {
        server: profile.name,
        host: profile.host,
      });
      config.hostVerifier = () => true;
    }
    return config;
  }

  /** Resolve the shared connection, establishing it on first use. */
  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const config = this.connectConfig();
    this.connecting = new Promise<Client>((resolve, reject) => {
      const client = this.factory(config);
      let settled = false;

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        client.off('error', onError);
        client.off('close', onClose);
        this.client = client;
        this.connecting = null;
        resolve(client);
      };

      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        client.end();
        reject(
          new TransportError(`SSH connection to ${this.profile.host}:${this.profile.port} failed: ${error.message}`, {
            cause: error,
            severity: 'transient',
            remediation: [
              'Verify the host, port and credentials in the server profile.',
              'Check the server firewall allows SSH.',
            ],
          }),
        );
      };

      const onClose = (): void => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        this.client = null;
        reject(
          new TransportError(`SSH connection to ${this.profile.host} closed during handshake.`, {
            severity: 'transient',
          }),
        );
      };

      client.once('ready', onReady);
      client.once('error', onError);
      client.once('close', onClose);
      client.connect(config);
    });

    return this.connecting;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const full = options.cwd ? `cd ${shellQuote(options.cwd)} && ${command}` : command;
    return this.run(full, options);
  }

  async execFile(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(commandLine(file, args), options);
  }

  private run(command: string, options: ExecOptions): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUTS.default;
    const label = options.label ?? 'remote command';
    const started = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      let client: Client;
      this.connection()
        .then((connected) => {
          client = connected;
          client.exec(command, { pty: false }, (error, stream) => {
            if (error) {
              reject(
                new TransportError(`Unable to start ${label} on ${this.profile.host}: ${error.message}`, {
                  cause: error,
                  severity: 'transient',
                  command,
                }),
              );
              return;
            }
            this.pump(stream, command, options, timeoutMs, started, resolve, reject);
          });
        })
        .catch(reject);
    });
  }

  private pump(
    stream: NodeJS.ReadWriteStream & { stderr?: NodeJS.ReadableStream & { on: NodeJS.EventEmitter['on'] } },
    command: string,
    options: ExecOptions,
    timeoutMs: number,
    started: number,
    resolve: (value: ExecResult) => void,
    reject: (reason: unknown) => void,
  ): void {
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SSH has no cancel API on the stream; closing the channel stops the process.
      try {
        (stream as unknown as { _close?: () => void })._close?.();
      } catch {
        /* best effort */
      }
    }, timeoutMs);

    const finish = (exitCode: number, signal?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: ExecResult = {
        stdout: stdout.slice(0, maxBuffer),
        stderr: stderr.slice(0, maxBuffer),
        exitCode,
        durationMs: Date.now() - started,
        command,
      };
      if (timedOut) {
        reject(
          new TransportError(`${options.label ?? 'Remote command'} timed out after ${timeoutMs}ms: ${command}`, {
            command,
            severity: 'transient',
            details: { stderr: redactOutput(result.stderr).slice(-2000) },
            remediation: ['Increase the timeout in the timeouts configuration section.'],
          }),
        );
        return;
      }
      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new RemoteCommandError(
            `Remote command failed with exit code ${exitCode}${signal ? ` (${signal})` : ''}: ${command}`,
            exitCode,
            {
              command,
              details: {
                stdout: redactOutput(result.stdout).slice(-4000),
                stderr: redactOutput(result.stderr).slice(-4000),
              },
            },
          ),
        );
        return;
      }
      resolve(result);
    };

    stream.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    stream.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });
    stream.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new TransportError(`Remote stream error during ${options.label ?? 'command'}: ${error.message}`, {
          cause: error,
          severity: 'transient',
          command,
        }),
      );
    });
    stream.on('close', (code: number | null, signal?: string) => {
      finish(code ?? (signal ? 137 : 1), signal);
    });

    if (options.stdin !== undefined) {
      stream.write(options.stdin);
    }
    stream.end();
  }

  async which(command: string): Promise<boolean> {
    const result = await this.exec(`command -v ${shellQuote(command)}`, { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() !== '';
  }

  async info(): Promise<ExecutorInfo> {
    const hostname = await this.exec('hostname', { allowFailure: true });
    const user = await this.exec('id -un', { allowFailure: true });
    const os = await this.exec('uname -sr', { allowFailure: true });
    return {
      hostname: hostname.stdout.trim() || this.profile.host,
      user: user.stdout.trim() || this.profile.username,
      os: os.stdout.trim(),
      platform: 'remote',
    };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (!client) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      client.once('close', finish);
      try {
        client.end();
      } catch {
        finish();
      }
      // Never hang on close.
      setTimeout(finish, 2_000).unref?.();
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Resolves on the *client*, so the result is a native path: `path.join` on
 * Windows produces a backslash path, which Node's fs accepts, rather than the
 * hand-rolled `${base}/${rest}` that mangled UNC shares and drive roots.
 */
export function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2));
  return target;
}
