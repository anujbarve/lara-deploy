/**
 * Local process execution (execa).
 *
 * Used for the build pipeline. Secrets are passed via `env`, never argv.
 */

import { execa, type ResultPromise, type Result } from 'execa';
import { LocalCommandError } from '../../core/errors/errors.js';
import { redactOutput } from '../../utils/redact.js';
import {
  DEFAULT_TIMEOUTS,
  displayCommand,
  type ExecOptions,
  type ExecResult,
  type ExecutorInfo,
  type RemoteExecutor,
} from './types.js';

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export class LocalExecutor implements RemoteExecutor {
  constructor(private readonly cwd: string = process.cwd()) {}

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const child = execa(command, {
      shell: true,
      cwd: options.cwd ?? this.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUTS.default,
      reject: false,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      input: options.stdin,
    }) as unknown as ResultPromise;

    const result = await child;
    return this.toExecResult(result, command, started);
  }

  async execFile(file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    let child: ResultPromise;
    try {
      child = execa(file, args as string[], {
        shell: false,
        cwd: options.cwd ?? this.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUTS.default,
        reject: false,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      });
    } catch (cause) {
      throw new LocalCommandError(`Command failed: ${displayCommand(file, args)}`, 127, {
        cause,
        command: displayCommand(file, args),
      });
    }

    if (options.stdin !== undefined) {
      // execa v9 feeds stdin through `input`; doing it here keeps the API in
      // ExecOptions uniform with the SSH executor.
      void child;
      const withInput = execa(file, args as string[], {
        shell: false,
        cwd: options.cwd ?? this.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUTS.default,
        reject: false,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        input: options.stdin,
      });
      return this.finish(withInput, file, args, started, options);
    }

    return this.finish(child, file, args, started, options);
  }

  private async finish(
    child: ResultPromise,
    file: string,
    args: readonly string[],
    started: number,
    options: ExecOptions,
  ): Promise<ExecResult> {
    const result = await child;
    const execResult = this.toExecResult(result, displayCommand(file, args), started);

    if (execResult.exitCode !== 0 && !options.allowFailure) {
      throw new LocalCommandError(
        `Command failed with exit code ${execResult.exitCode}: ${execResult.command}`,
        execResult.exitCode,
        {
          command: execResult.command,
          liveAffected: false,
          details: {
            stdout: redactOutput(execResult.stdout).slice(-4000),
            stderr: redactOutput(execResult.stderr).slice(-4000),
          },
          remediation: ['Fix the failing step locally, then re-run the deploy.'],
        },
      );
    }
    return execResult;
  }

  private toExecResult(result: Result, command: string, started: number): ExecResult {
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : result.failed ? 1 : 0,
      durationMs: Date.now() - started,
      command,
    };
  }

  async which(command: string): Promise<boolean> {
    const result = await this.exec(`command -v ${command}`, { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() !== '';
  }

  async info(): Promise<ExecutorInfo> {
    const hostname = (await this.exec('hostname', { allowFailure: true })).stdout.trim();
    const os = (await this.exec('uname -sr', { allowFailure: true })).stdout.trim();
    return {
      hostname: hostname || 'localhost',
      user: process.env.USER ?? 'unknown',
      os,
      platform: process.platform,
    };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}