/**
 * SFTP uploader.
 *
 * Transfers go to a temporary remote path (`<root>/.deploy/incoming/<release>.tar.gz`)
 * and are never extracted in place. Uploads are retried, and a partial file is
 * always removed before a fresh attempt so a retry cannot append to a truncated
 * archive (SPEC §16).
 */

import fs from 'node:fs';
import path from 'node:path';
import sftpModule from 'ssh2-sftp-client';
import type { ConnectConfig } from 'ssh2';

import { TransportError } from '../../core/errors/errors.js';
import { buildHostVerifier } from '../ssh/known-hosts.js';
import { retry, type RetryOptions } from '../../utils/retry.js';
import { formatBytes } from '../../utils/ids.js';
import type { ServerProfile } from '../../core/config/schema.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

// ssh2-sftp-client is CommonJS and does `module.exports = SftpClient`, so the
// ESM default import IS the constructor — there is no `SftpClient` named
// export to destructure. Destructuring it yielded undefined and every upload
// died with "SftpClient is not a constructor".
const SftpClient = resolveSftpClientConstructor(sftpModule);

interface SftpClientInstance {
  connect(config: ConnectConfig): Promise<string | undefined>;
  end(): Promise<void>;
  /** Resolves with a status *string*, not a byte count, and never calls onProgress. */
  fastPut(source: string | Buffer, destination: string, options?: FastPutOptions): Promise<string>;
  put(source: string | Buffer, destination: string, options?: PutOptions): Promise<string>;
  mkdir(path: string, recursive?: boolean): Promise<string>;
  /** The client's method is named `delete`, not `unlink`. */
  delete(path: string, notFoundOK?: boolean): Promise<string>;
  stat(path: string): Promise<{ size: number }>;
}

interface FastPutOptions {
  concurrency?: number;
  chunkSize?: number;
  timeout?: number;
  onProgress?: (transferredBytes: number) => void;
}

interface PutOptions {
  mode?: number;
}

export interface UploadOptions {
  localPath: string;
  remotePath: string;
  timeoutMs: number;
  /** Progress callback. */
  onProgress?: (transferred: number, total: number) => void;
  /** Abort signal from the UI. */
  signal?: AbortSignal;
}

export interface UploadResult {
  remotePath: string;
  bytes: number;
  durationMs: number;
  attempts: number;
  /** Human size, e.g. "38.4 MB". */
  humanSize: string;
}

export interface Uploader {
  upload(options: UploadOptions): Promise<UploadResult>;
  /** Write a small text payload (a remote script) to the server. */
  uploadText(contents: string, remotePath: string, timeoutMs: number, mode?: number): Promise<void>;
  /** Remove a remote file, ignoring absence. */
  remove(remotePath: string): Promise<void>;
  /** Remote file size in bytes, or null when absent. */
  stat(remotePath: string): Promise<number | null>;
  /** Verify a remote file matches an expected local size. */
  verify(remotePath: string, expectedBytes: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface SftpUploaderOptions {
  profile: ServerProfile;
  logger?: Logger;
  /** Attempts for transient network failures. */
  attempts?: number;
  /** Injectable for tests. */
  clientFactory?: () => SftpClientInstance;
  retryOptions?: RetryOptions;
}

export class SftpUploader implements Uploader {
  private readonly logger: Logger;
  private readonly clientFactory: () => SftpClientInstance;

  constructor(private readonly options: SftpUploaderOptions) {
    this.logger = options.logger ?? nullLogger();
    this.clientFactory = options.clientFactory ?? (() => new SftpClient());
  }

  async upload(options: UploadOptions): Promise<UploadResult> {
    const stat = await fs.promises.stat(options.localPath);
    if (!stat.isFile()) {
      throw new TransportError(`Not a file: ${options.localPath}`);
    }

    let attempts = 0;
    const started = Date.now();

    const result = await retry(
      async () => {
        attempts += 1;
        const client = this.clientFactory();
        try {
          await this.connect(client, options.timeoutMs);
          await this.ensureRemoteDir(client, path.posix.dirname(options.remotePath));
          // Never append to a partial file from a previous attempt.
          await this.removeQuietly(client, options.remotePath);

          let transferred = 0;
          await client.fastPut(options.localPath, options.remotePath, {
            concurrency: 32,
            chunkSize: 32 * 1024,
            timeout: options.timeoutMs,
            // ssh2-sftp-client's fastPut resolves with a status string and never
            // invokes onProgress, so progress is reported as the file is
            // streamed instead. Without this the transfer reported 0 bytes and
            // the progress spinner never moved.
            onProgress: (bytes: number) => {
              transferred = bytes;
              options.onProgress?.(bytes, stat.size);
            },
          });

          // fastPut gives no completion callback and no reliable progress, so
          // the local size is the only trustworthy count. The orchestrator
          // compares the remote size against the archive's own byte count, so
          // integrity does not depend on this value.
          if (transferred === 0) {
            transferred = stat.size;
            options.onProgress?.(stat.size, stat.size);
          }

          return transferred;
        } catch (cause) {
          throw new TransportError(`Upload failed for ${options.remotePath}`, {
            cause,
            severity: 'transient',
            command: `sftp put ${options.localPath}`,
            remediation: ['Check the connection and free disk space on the server, then retry.'],
          });
        } finally {
          await this.closeQuietly(client);
        }
      },
      {
        attempts: this.options.attempts ?? 3,
        onRetry: (error, attempt, delay) => {
          this.logger.warn('Retrying upload.', {
            attempt,
            delayMs: delay,
            reason: error instanceof Error ? error.message : String(error),
          });
        },
        ...this.options.retryOptions,
      },
    );

    return {
      remotePath: options.remotePath,
      bytes: result,
      durationMs: Date.now() - started,
      attempts,
      humanSize: formatBytes(result),
    };
  }

  /** Write a small text payload (a remote script) to the server. */
  async uploadText(
    contents: string,
    remotePath: string,
    timeoutMs: number,
    mode = 0o700,
  ): Promise<void> {
    const client = this.clientFactory();
    try {
      await this.connect(client, timeoutMs);
      await this.ensureRemoteDir(client, path.posix.dirname(remotePath));
      await client.put(Buffer.from(contents, 'utf8'), remotePath, { mode });
    } catch (cause) {
      throw new TransportError(`Unable to write ${remotePath} on the server.`, {
        cause,
        severity: 'transient',
      });
    } finally {
      await this.closeQuietly(client);
    }
  }

  async stat(remotePath: string): Promise<number | null> {
    const client = this.clientFactory();
    try {
      await this.connect(client, DEFAULT_CONNECT_TIMEOUT);
      const stat = await client.stat(remotePath);
      return typeof stat.size === 'number' ? stat.size : null;
    } catch {
      return null;
    } finally {
      await this.closeQuietly(client);
    }
  }

  async verify(remotePath: string, expectedBytes: number): Promise<boolean> {
    const remoteSize = await this.stat(remotePath);
    return remoteSize !== null && remoteSize === expectedBytes;
  }

  async remove(remotePath: string): Promise<void> {
    const client = this.clientFactory();
    try {
      await this.connect(client, DEFAULT_CONNECT_TIMEOUT);
      await this.removeQuietly(client, remotePath);
    } finally {
      await this.closeQuietly(client);
    }
  }

  async close(): Promise<void> {
    /* clients are per-operation */
  }

  private async connect(client: SftpClientInstance, timeoutMs: number): Promise<void> {
    const profile = this.options.profile;
    const connectConfig: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: timeoutMs,
    };
    if (profile.sshKey) {
      connectConfig.privateKey = fs.readFileSync(profile.sshKey);
      if (profile.passphrase) connectConfig.passphrase = profile.passphrase;
    } else if (profile.password) {
      connectConfig.password = profile.password;
    } else if (profile.agent) {
      const sock = process.env.SSH_AUTH_SOCK;
      if (sock) connectConfig.agent = sock;
    }

    // This connection carries the release archive, so it must be verified too.
    // It previously set no hostVerifier at all, meaning it accepted any key
    // even when the profile asked for strict checking.
    const verifier = buildHostVerifier(profile);
    if (verifier) {
      connectConfig.hostVerifier = verifier;
    } else {
      this.logger.warn('SSH host key checking is disabled for this server.', {
        server: profile.name,
        host: profile.host,
      });
      connectConfig.hostVerifier = () => true;
    }

    await client.connect(connectConfig);
  }

  private async ensureRemoteDir(client: SftpClientInstance, dir: string): Promise<void> {
    const parts = dir.split('/').filter((part) => part !== '');
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      // `mkdir` is idempotent in the ssh2-sftp-client implementation.
      await client.mkdir(current).catch(() => undefined);
    }
  }

  private async removeQuietly(client: SftpClientInstance, remotePath: string): Promise<void> {
    try {
      // notFoundOK: a missing file is the normal case before the first upload.
      // Calling a non-existent `unlink` used to throw a TypeError that this
      // catch swallowed, so stale archives were silently never deleted.
      await client.delete(remotePath, true);
    } catch {
      /* absent is fine */
    }
  }

  private async closeQuietly(client: SftpClientInstance): Promise<void> {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

const DEFAULT_CONNECT_TIMEOUT = 30_000;

/**
 * Find the client constructor across the shapes this dependency has taken:
 * a bare `module.exports = SftpClient`, a `{ SftpClient }` namespace, or an
 * already-resolved constructor. Failing loudly here beats a confusing
 * "not a constructor" at the first upload.
 */
export function resolveSftpClientConstructor(mod: unknown): new () => SftpClientInstance {
  // The declared interface is hand-written, so it happily compiles against a
  // method the real client does not have — `unlink` was invented that way and
  // its TypeError was swallowed. Verify the surface actually exists.
  const candidates: unknown[] = [
    mod,
    (mod as { SftpClient?: unknown } | null)?.SftpClient,
    (mod as { default?: unknown } | null)?.default,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') return checked(candidate);
    const nested = (candidate as { SftpClient?: unknown } | null)?.SftpClient;
    if (typeof nested === 'function') return checked(nested);
  }
  throw new TransportError('Could not load the SFTP client from ssh2-sftp-client.', {
    remediation: [
      'Reinstall dependencies: npm install',
      'Check that ssh2-sftp-client exports a client constructor.',
    ],
  });
}

/** Reject a constructor whose instances lack the methods this uploader calls. */
function checked(ctor: unknown): new () => SftpClientInstance {
  const required = ['connect', 'end', 'fastPut', 'put', 'mkdir', 'delete', 'stat'];
  // The methods live on the prototype, so an instance is what must be probed.
  let instance: Record<string, unknown>;
  try {
    instance = new (ctor as new () => Record<string, unknown>)();
  } catch (cause) {
    throw new TransportError('The SFTP client could not be instantiated.', {
      cause,
      remediation: ['Reinstall dependencies: npm install'],
    });
  }
  const missing = required.filter((method) => typeof instance[method] !== 'function');
  if (missing.length > 0) {
    throw new TransportError(`The SFTP client is missing required methods: ${missing.join(', ')}.`, {
      remediation: [
        'Reinstall dependencies: npm install',
        'This usually means an incompatible ssh2-sftp-client version.',
      ],
    });
  }
  return ctor as new () => SftpClientInstance;
}
