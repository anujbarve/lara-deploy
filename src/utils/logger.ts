/**
 * Structured logger.
 *
 * Two sinks:
 *  - the terminal, which the UI layer owns exclusively (the logger never paints
 *    spinner output — that would corrupt the UI);
 *  - a rotating JSON-lines file under the global config dir, always redacted.
 *
 * Pino is used for the file sink; the terminal is the UI layer's business.
 */

import { mkdirSync, createWriteStream, existsSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pino, type Logger as PinoLogger } from 'pino';
import { redact } from './redact.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
  /** Returns a logger that merges `bindings` into every record. */
  child(bindings: Record<string, unknown>): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Directory for the debug log file. Omit to disable file logging. */
  logDir?: string;
  /** Deployment id stamped on every record. */
  deploymentId?: string;
  /** Mirror error records to stderr. */
  mirrorToStderr?: boolean;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface Internal extends LoggerOptions {
  bindings?: Record<string, unknown>;
}

export function createLogger(options: Internal = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const bindings = options.bindings ?? {};

  const wantsFile = level !== 'silent' && LEVEL_ORDER[level] >= LEVEL_ORDER.debug && !!options.logDir;

  let sink: PinoLogger | null = null;
  if (wantsFile && options.logDir) {
    try {
      mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
      const file = path.join(options.logDir, 'laravel-deploy.log');
      rotateIfNeeded(file);
      const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
      sink = pino({ level, base: {} }, stream);
    } catch {
      sink = null;
    }
  }

  const emit = (
    lvl: Exclude<LogLevel, 'silent'>,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[lvl]) return;

    const payload: Record<string, unknown> = {
      ...bindings,
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    };
    if (sink) {
      const record = { ...payload, msg: message };
      (sink[lvl] as (o: unknown, m?: string) => void)(record, message);
    }
    if (options.mirrorToStderr && lvl === 'error') {
      process.stderr.write(`[error] ${message}\n`);
    }
  };

  return {
    level,
    error: (m, c) => emit('error', m, c),
    warn: (m, c) => emit('warn', m, c),
    info: (m, c) => emit('info', m, c),
    debug: (m, c) => emit('debug', m, c),
    trace: (m, c) => emit('trace', m, c),
    child: (extra) => createLogger({ ...options, level, bindings: { ...bindings, ...extra } }),
  };
}

/** A logger that discards everything — default in tests and in `--json` mode. */
export function nullLogger(): Logger {
  return createLogger({ level: 'silent' });
}

function rotateIfNeeded(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best effort */
  }
}