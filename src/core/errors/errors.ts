/**
 * Typed application errors.
 *
 * Every error carries enough structure for the CLI to answer the five questions
 * a failure must always answer (see SPEC §50):
 *   what failed, why, which command, was live affected, what to do next.
 */

export type ErrorSeverity = 'transient' | 'fatal';

export interface AppErrorOptions {
  /** Underlying cause. */
  cause?: unknown;
  /** The command involved, already safe to display (never contains secrets). */
  command?: string;
  /** True when the currently-live deployment is untouched. */
  liveAffected?: boolean;
  /** Concrete next step(s) for the operator. */
  remediation?: string[];
  /** Whether a retry could plausibly succeed. */
  severity?: ErrorSeverity;
  /** Extra machine-readable context, already redacted. */
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly command?: string;
  readonly liveAffected: boolean;
  readonly remediation: string[];
  readonly severity: ErrorSeverity;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.command = options.command;
    this.liveAffected = options.liveAffected ?? false;
    this.remediation = options.remediation ?? [];
    this.severity = options.severity ?? 'fatal';
    this.details = options.details ?? {};
  }
}

/** Configuration file missing / unreadable. */
export class ConfigError extends AppError {}

/** Configuration present but invalid. Carries field paths. */
export class ConfigValidationError extends AppError {
  constructor(
    message: string,
    readonly issues: ConfigIssue[],
    options: AppErrorOptions = {},
  ) {
    super(message, options);
  }
}

export interface ConfigIssue {
  /** Dotted path, e.g. `site.domain`. */
  path: string;
  message: string;
}

/** Local project is not a usable Laravel app. */
export class ProjectError extends AppError {}

/** SSH / SFTP transport failure. */
export class ConnectionError_ extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { severity: 'transient', ...options });
  }
}
export { ConnectionError_ as TransportError };

/** aaPanel API or panel CLI failure. */
export class PanelError extends AppError {}

/** Remote command exited non-zero. */
export class RemoteCommandError extends AppError {
  constructor(
    message: string,
    readonly exitCode: number,
    options: AppErrorOptions = {},
  ) {
    super(message, options);
  }
}

/** Local build/command exited non-zero. */
export class LocalCommandError extends AppError {
  constructor(
    message: string,
    readonly exitCode: number,
    options: AppErrorOptions = {},
  ) {
    super(message, options);
  }
}

/** A health check failed. */
export class HealthCheckError extends AppError {}

/** User aborted an interactive prompt or a confirmation. */
export class UserAbortError extends AppError {
  constructor(message = 'Aborted.') {
    super(message);
  }
}

/** An operation needs confirmation the user did not give. */
export class ConfirmationRequiredError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, {
      remediation: ['Re-run with the confirmation flag, or answer the prompt.'],
      ...options,
    });
  }
}

/** Destructive operation refused by the safety layer. */
export class SafetyError extends AppError {}

/** Another deployment holds the site lock. */
export class DeploymentLockedError extends AppError {}

/** Missing credentials/configuration that a human must supply. */
export class MissingCredentialError extends AppError {}

/** Is `unknown` something we can turn into an AppError? */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Best-effort message extraction for arbitrary thrown values. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Normalise anything thrown into an AppError. */
export function toAppError(value: unknown, fallbackMessage = 'Unexpected error.'): AppError {
  if (isAppError(value)) return value;
  const err = new AppError(value ? errorMessage(value) : fallbackMessage, { cause: value });
  return err;
}