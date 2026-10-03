/**
 * Command execution abstraction.
 *
 * Every remote operation in this codebase goes through `RemoteExecutor`. That
 * is what makes the entire deployment engine testable without a VPS, and it is
 * why no SSH connection logic is scattered anywhere else (SPEC §42).
 */

export interface ExecOptions {
  /** Working directory on the remote host. */
  cwd?: string;
  /** Extra environment variables. Never used for secrets. */
  env?: Record<string, string>;
  /** Hard timeout in ms. Every operation must have one (SPEC §52). */
  timeoutMs?: number;
  /** Input written to stdin. Secrets travel this way, never via argv. */
  stdin?: string;
  /** Treat a non-zero exit as data instead of throwing. Default false. */
  allowFailure?: boolean;
  /** Bytes of stdout to retain. Default 1 MiB. */
  maxBuffer?: number;
  /** Human label used in error messages and logs. */
  label?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** The exact command line, as executed (already quoted). */
  command: string;
}

export interface RemoteExecutor {
  /** Run a shell command line. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Run a program with argv (preferred: no shell quoting involved). */
  execFile(file: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** True when the command's last component exists and is executable. */
  which(command: string): Promise<boolean>;
  /** Free-form metadata for diagnostics: OS, user, hostname. */
  info(): Promise<ExecutorInfo>;
  /** Release transport resources. Safe to call twice. */
  close(): Promise<void>;
}

export interface ExecutorInfo {
  hostname: string;
  user: string;
  os: string;
  /** e.g. "Linux" / "Darwin" */
  platform: string;
}

export const DEFAULT_TIMEOUTS = {
  ssh: 30_000,
  upload: 300_000,
  healthCheck: 30_000,
  artisan: 300_000,
  panel: 30_000,
  localBuild: 1_800_000,
  databaseBackup: 600_000,
  default: 60_000,
} as const;

export function timeoutFor(kind: keyof typeof DEFAULT_TIMEOUTS, config?: Partial<Record<string, number>>): number {
  const explicit = config?.[kind];
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return DEFAULT_TIMEOUTS[kind];
}

/** Render argv for display/logging without executing. */
export function displayCommand(file: string, args: readonly string[]): string {
  return [file, ...args].join(' ');
}