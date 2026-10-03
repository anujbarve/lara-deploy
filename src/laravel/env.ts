/**
 * Environment validation and .env strategy.
 *
 * Rules enforced here (SPEC §9, §37):
 *  - the local .env NEVER overwrites the server .env;
 *  - default strategy is `preserve`;
 *  - missing required variables are reported by name only, never by value;
 *  - generated secrets are written to the server through stdin, not argv.
 */

import { generatePassword, randomHexish } from '../utils/ids.js';
import { isSensitiveEnvName } from '../utils/redact.js';
import type { EnvConfig } from '../core/config/schema.js';

export interface EnvVariablePolicy {
  required: string[];
  optional: string[];
  blockOnMissing: boolean;
}

/**
 * Variables a Laravel app effectively cannot boot without. Used when the
 * project provides no explicit policy.
 */
export const DEFAULT_REQUIRED_ENV = [
  'APP_KEY',
  'APP_URL',
  'DB_CONNECTION',
  'DB_HOST',
  'DB_DATABASE',
  'DB_USERNAME',
  'DB_PASSWORD',
] as const;

export const DEFAULT_OPTIONAL_ENV = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USERNAME', 'MAIL_PASSWORD'] as const;

export interface EnvValidationInput {
  /** The server's current .env contents (parsed). */
  remoteEnv: Record<string, string> | null;
  /** Keys available from .env.example. */
  exampleKeys: string[];
  /** Detected config/ usage, e.g. ["mail", "database"]. */
  configUsages: string[];
  policy: EnvVariablePolicy;
}

export interface EnvValidationResult {
  present: string[];
  missing: string[];
  /** Warnings: variables that .env.example defines but production lacks. */
  warnings: string[];
  /** True when `missing` contains a policy-required variable. */
  blocking: boolean;
}

export function validateEnv(input: EnvValidationInput): EnvValidationResult {
  const remote = input.remoteEnv ?? {};
  const required = new Set<string>(input.policy.required);
  const optional = new Set<string>(input.policy.optional);

  for (const key of DEFAULT_REQUIRED_ENV) {
    if (!required.has(key) && !optional.has(key)) required.add(key);
  }

  const present: string[] = [];
  const missing: string[] = [];

  for (const key of required) {
    const value = remote[key];
    if (value !== undefined && value !== '') present.push(key);
    else missing.push(key);
  }
  for (const key of optional) {
    const value = remote[key];
    if (value !== undefined && value !== '') present.push(key);
  }

  // Warnings: keys present in .env.example but not in production. Never values.
  const warnings = input.exampleKeys
    .filter((key) => remote[key] === undefined && !missing.includes(key))
    .filter((key) => !isSensitiveEnvName(key) || input.policy.optional.includes(key))
    .sort();

  const blocking = missing.length > 0 && input.policy.blockOnMissing;

  return { present: present.sort(), missing: missing.sort(), warnings, blocking };
}

// ---------------------------------------------------------------------------
// .env writing
// ---------------------------------------------------------------------------

export interface EnvWritePlan {
  /** The full file contents to write, or null when nothing should change. */
  contents: string | null;
  reason: string;
  /** Keys that will be added or changed — for display, names only. */
  changedKeys: string[];
}

/**
 * Decide what to do with the server .env for this deployment.
 *
 * - preserve: never write anything.
 * - generate:  add only the requested keys when absent.
 * - template:  first deploy only, build from a local template.
 * - upload:    explicit opt-in, uploads the configured local .env.
 */
export function planEnvWrite(input: {
  strategy: EnvConfig['strategy'];
  remoteEnv: Record<string, string> | null;
  /** First deployment to this site. */
  isFirstDeploy: boolean;
  domain: string;
  database: { name: string; username: string; password: string; host: string; port: number };
  appKey?: string;
  templateContents?: string;
  uploadContents?: string;
  generateKeys: string[];
  extraValues: Record<string, string>;
  initialiseFromExample: boolean;
  exampleContents?: string;
}): EnvWritePlan {
  const existing = input.remoteEnv;

  if (input.strategy === 'preserve') {
    if (existing && Object.keys(existing).length > 0) {
      return { contents: null, reason: 'Server .env preserved (envStrategy=preserve).', changedKeys: [] };
    }
    if (!input.isFirstDeploy) {
      return { contents: null, reason: 'Server .env preserved (envStrategy=preserve).', changedKeys: [] };
    }
    // First deploy with preserve: still create a minimal file, never from local .env.
    const seeded = baseEnv(input, existing ?? {});
    return {
      contents: renderEnv(seeded),
      reason: 'First deploy: created a minimal server .env (local .env was not uploaded).',
      changedKeys: Object.keys(seeded).filter((k) => !(existing ?? {})[k]),
    };
  }

  if (input.strategy === 'template') {
    if (!input.isFirstDeploy) {
      return { contents: null, reason: 'Server .env preserved (envStrategy=template, not first deploy).', changedKeys: [] };
    }
    const base = parseEnv(input.templateContents ?? '');
    const merged = applyDefaults({ ...base }, input, existing ?? {});
    const contents = renderEnv(merged);
    return {
      contents,
      reason: 'First deploy: .env created from the configured template.',
      changedKeys: diffKeys(existing ?? {}, merged),
    };
  }

  if (input.strategy === 'upload') {
    const contents = input.uploadContents;
    if (contents === undefined) {
      return { contents: null, reason: 'envStrategy=upload but no file content available.', changedKeys: [] };
    }
    if (!input.isFirstDeploy) {
      return { contents: null, reason: 'Server .env preserved (envStrategy=upload, not first deploy).', changedKeys: [] };
    }
    const parsed = applyDefaults(parseEnv(contents), input, existing ?? {});
    return {
      contents: renderEnv(parsed),
      reason: 'First deploy: .env uploaded from the configured file.',
      changedKeys: diffKeys(existing ?? {}, parsed),
    };
  }

  // generate
  const working = { ...(existing ?? {}) };
  const changed: string[] = [];
  for (const key of input.generateKeys) {
    const generated = generateValue(key);
    if (generated === null) continue;
    if (working[key] === undefined || working[key] === '') {
      working[key] = generated;
      changed.push(key);
    }
  }
  if (changed.length === 0 && existing) {
    return { contents: null, reason: 'envStrategy=generate: no missing keys to generate.', changedKeys: [] };
  }
  const final = applyDefaults(working, input, existing ?? {});
  return {
    contents: renderEnv(final),
    reason: `Generated ${changed.length} variable(s) on the server.`,
    changedKeys: diffKeys(existing ?? {}, final),
  };
}

function baseEnv(
  input: Parameters<typeof planEnvWrite>[0],
  existing: Record<string, string>,
): Record<string, string> {
  const source =
    input.initialiseFromExample && input.exampleContents
      ? parseEnv(input.exampleContents)
      : {};
  const merged: Record<string, string> = { ...source };
  for (const [key, value] of Object.entries(input.extraValues)) merged[key] = value;
  merged.APP_URL = merged.APP_URL || `https://${input.domain}`;
  merged.DB_CONNECTION = merged.DB_CONNECTION || 'mysql';
  merged.DB_HOST = merged.DB_HOST || input.database.host;
  merged.DB_PORT = merged.DB_PORT || String(input.database.port);
  merged.DB_DATABASE = merged.DB_DATABASE || input.database.name;
  merged.DB_USERNAME = merged.DB_USERNAME || input.database.username;
  if (!merged.DB_PASSWORD) merged.DB_PASSWORD = input.database.password;
  if (!merged.APP_KEY) merged.APP_KEY = input.appKey ?? '';

  // These are production invariants, not preferences. A .env.example copied in
  // from development must never carry APP_ENV=local or APP_DEBUG=true to a live
  // site, so they are forced rather than defaulted.
  merged.APP_ENV = 'production';
  merged.APP_DEBUG = 'false';
  merged.LOG_CHANNEL = merged.LOG_CHANNEL || 'stack';
  merged.SESSION_DRIVER = merged.SESSION_DRIVER || 'file';
  merged.CACHE_STORE = merged.CACHE_STORE || merged.CACHE_DRIVER || 'file';
  merged.QUEUE_CONNECTION = merged.QUEUE_CONNECTION || 'database';
  merged.FILESYSTEM_DISK = merged.FILESYSTEM_DISK || 'local';
  // Existing server values always win — but an empty value is not a value, so
  // it must not clobber a generated secret.
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

function applyDefaults(
  working: Record<string, string>,
  input: Parameters<typeof planEnvWrite>[0],
  existing: Record<string, string>,
): Record<string, string> {
  // Fill gaps in `working` from the defaults, but never overwrite a key that
  // `working` already resolved (a generated value must survive).
  const defaults = baseEnv(input, existing);
  const merged: Record<string, string> = { ...defaults };
  for (const [key, value] of Object.entries(working)) {
    merged[key] = value;
  }
  return merged;
}

function generateValue(key: string): string | null {
  if (key === 'APP_KEY') return `base64:${randomBase64(32)}`;
  if (key === 'DB_PASSWORD' || key.endsWith('_PASSWORD')) return generatePassword();
  if (key.endsWith('_KEY')) return randomHexish(48);
  if (key.endsWith('_SECRET')) return randomHexish(48);
  if (key.endsWith('_TOKEN')) return randomHexish(32);
  return null;
}

function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      // Double-quoted values carry renderEnv's escapes.
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Render env contents with every value quoted, so shell/`env` parsing is safe. */
export function renderEnv(values: Record<string, string>): string {
  const lines: string[] = ['# Managed by laravel-deploy. Values are not printed by the CLI.'];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function diffKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

/**
 * The env file content is passed to the remote shell via stdin heredoc, never
 * as an argument. Returns the shell snippet that writes the file.
 */
export function envWriteScript(envPath: string, contents: string, mode = '0640'): string {
  const tag = `LARAVELDEPLOYENV${randomHexish(8).toUpperCase()}`;
  const target = shellQuote(envPath);
  return [
    'umask 077',
    `cat > ${target} <<'${tag}'`,
    contents.replace(/\n?$/, ''),
    `${tag}`,
    `chmod ${mode} ${target}`,
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Display lines for `laravel-deploy doctor` env section — names only. */
export function describeEnv(result: EnvValidationResult): string[] {
  const lines: string[] = [];
  for (const key of result.present) lines.push(`  ok   ${key}`);
  for (const key of result.missing) lines.push(`  MISS ${key}`);
  for (const key of result.warnings) lines.push(`  warn ${key} (in .env.example, absent on server)`);
  return lines;
}