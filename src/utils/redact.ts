/**
 * Redaction helpers.
 *
 * Nothing in this CLI may print a secret. Every value that flows to stdout,
 * a log line, a JSON payload or a remote command line passes through here or
 * through the shell-quoting helpers in `shell.ts`.
 */

const REDACTED = '[redacted]';

/** Key names whose values must never be shown. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|authorization|auth|app_key|access[_-]?key|session)/i;

/** Values that look like credentials even under an innocuous key. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^base64:[A-Za-z0-9+/=]{16,}$/,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

/** Environment variable names treated as secret. */
const SECRET_ENV_NAMES = new Set([
  'APP_KEY',
  'DB_PASSWORD',
  'MAIL_PASSWORD',
  'REDIS_PASSWORD',
  'PUSHER_APP_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'DEPLOY_SSH_KEY_PASSPHRASE',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function isSensitiveEnvName(name: string): boolean {
  return SECRET_ENV_NAMES.has(name.toUpperCase()) || isSensitiveKey(name);
}

/**
 * Redact a single string value. Anything that looks like a private key, JWT or
 * Laravel-encrypted blob is replaced wholesale.
 */
export function redactValue(value: string): string {
  if (value.length === 0) return value;
  if (SENSITIVE_VALUE_PATTERNS.some((re) => re.test(value))) return REDACTED;
  return value;
}

/**
 * Deeply redact an arbitrary value for display. Keys matching the sensitive
 * pattern have their values replaced; nested objects and arrays are walked.
 * Cycles are tolerated.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (value instanceof Error) return redact(value.message, seen);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen);
    }
    return out;
  }
  return String(value);
}

/** Redact then JSON-stringify. Safe for `--json` output. */
export function redactJson(value: unknown, indent = 2): string {
  return JSON.stringify(redact(value), null, indent);
}

/**
 * Redact a `KEY=value` / `KEY: value` shaped line, used when echoing remote
 * output that may contain an `.env` line or a DSN.
 */
export function redactAssignmentLine(line: string): string {
  const match = /^\s*([A-Z0-9_]+)\s*[=:]\s*(.*)$/.exec(line);
  if (!match) return redactValue(line);
  const [, key, val] = match as unknown as [string, string, string];
  if (!val) return line;
  if (isSensitiveEnvName(key)) return `${key}=${REDACTED}`;
  return line;
}

/** Redact a whole block of remote output line-by-line. */
export function redactOutput(output: string): string {
  return output
    .split('\n')
    .map((line) => redactAssignmentLine(line))
    .join('\n');
}

export const REDACTION_PLACEHOLDER = REDACTED;