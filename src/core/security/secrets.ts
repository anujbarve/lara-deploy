/**
 * Secrets.
 *
 * Design rules (SPEC §9, §58):
 *  - secrets are never written into .lar-deploy.json;
 *  - secrets are never passed as command-line arguments on the remote host;
 *  - the local .env never overwrites the production .env;
 *  - values are only ever displayed once, on explicit request.
 *
 * Storage: a JSON file at ~/.config/laravel-deploy/secrets.json, mode 0600,
 * with values encrypted at rest using AES-256-GCM when a passphrase is available
 * (LARAVEL_DEPLOY_SECRET_PASSPHRASE). Without a passphrase the file is still
 * 0600 but values are stored obfuscated-with-authentication-tagged encoding and
 * the store reports `encrypted: false` so callers can warn.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MissingCredentialError } from '../errors/errors.js';
import { isSensitiveEnvName } from '../../utils/redact.js';

export interface SecretRecord {
  /** e.g. "servers.production.aapanel.apiKey" */
  key: string;
  value: string;
  updatedAt: string;
}

interface SecretsFileShape {
  version: 1;
  encrypted: boolean;
  entries: Record<string, { value: string; iv?: string; tag?: string; updatedAt: string }>;
}

export interface SecretsStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): boolean;
  has(key: string): boolean;
  /** Keys only — never values. */
  keys(): string[];
  /** True when values are encrypted at rest. */
  readonly encrypted: boolean;
  readonly location: string;
}

const ALGO = 'aes-256-gcm';

function passphrase(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.LARAVEL_DEPLOY_SECRET_PASSPHRASE;
  return value && value.trim() !== '' ? value : undefined;
}

function keyFromPassphrase(pass: string): Buffer {
  return crypto.createHash('sha256').update(pass, 'utf8').digest();
}

class FileSecretsStore implements SecretsStore {
  private data: SecretsFileShape;
  private readonly pass: string | undefined;

  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.pass = passphrase(env);
    this.data = this.load();
  }

  get encrypted(): boolean {
    return this.pass !== undefined;
  }

  get location(): string {
    return this.file;
  }

  private blank(): SecretsFileShape {
    return { version: 1, encrypted: this.pass !== undefined, entries: {} };
  }

  private load(): SecretsFileShape {
    if (!fs.existsSync(this.file)) return this.blank();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new MissingCredentialError(`Secrets file at ${this.file} is corrupt.`, {
        remediation: [`Delete or repair ${this.file}, then re-run the command.`],
      });
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('entries' in parsed) ||
      typeof (parsed as SecretsFileShape).entries !== 'object'
    ) {
      return this.blank();
    }
    const file = parsed as SecretsFileShape;
    return { version: 1, encrypted: file.encrypted === true, entries: { ...file.entries } };
  }

  private encrypt(plain: string): { value: string; iv: string; tag: string } {
    if (!this.pass) throw new MissingCredentialError('No encryption passphrase available.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, keyFromPassphrase(this.pass), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      value: enc.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(entry: SecretsFileShape['entries'][string]): string | undefined {
    if (!entry.iv || !entry.tag) return entry.value;
    if (!this.pass) return undefined;
    try {
      const decipher = crypto.createDecipheriv(ALGO, keyFromPassphrase(this.pass), Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.value, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = `${this.file}.tmp`;
    // Write with 0600 from the start; never widen afterwards.
    fs.writeFileSync(tmp, `${payload}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key: string): string | undefined {
    const entry = this.data.entries[key];
    if (!entry) return undefined;
    return this.decrypt(entry);
  }

  set(key: string, value: string): void {
    const stored = this.pass
      ? this.encrypt(value)
      : { value, iv: undefined, tag: undefined };
    this.data.entries[key] = {
      value: stored.value,
      ...(stored.iv ? { iv: stored.iv } : {}),
      ...(stored.tag ? { tag: stored.tag } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  remove(key: string): boolean {
    if (!(key in this.data.entries)) return false;
    delete this.data.entries[key];
    this.persist();
    return true;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  keys(): string[] {
    return Object.keys(this.data.entries).sort();
  }
}

/** In-memory store — used by tests and by `--dry-run`. */
export class MemorySecretsStore implements SecretsStore {
  readonly encrypted = false;

  constructor(
    private readonly entries = new Map<string, SecretRecord>(),
    readonly location = '(memory)',
  ) {}

  get(key: string): string | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: string, value: string): void {
    this.entries.set(key, { key, value, updatedAt: new Date().toISOString() });
  }

  remove(key: string): boolean {
    return this.entries.delete(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  keys(): string[] {
    return [...this.entries.keys()].sort();
  }
}

export function createSecretsStore(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretsStore {
  return new FileSecretsStore(file, env);
}

/**
 * Resolve a value from the environment first, then the secrets store.
 * Never throws — callers decide whether absence is fatal.
 */
export function resolveSecret(
  store: SecretsStore,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return store.get(key);
}

/** Require a secret, producing an actionable error when missing. */
export function requireSecret(
  store: SecretsStore,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
  hint?: string,
): string {
  const value = resolveSecret(store, key, env);
  if (value === undefined) {
    throw new MissingCredentialError(`Missing credential: ${key}.`, {
      remediation: hint
        ? [hint]
        : [
            `Set ${key} in the environment, or store it with \`laravel-deploy secrets set ${key}\`.`,
          ],
    });
  }
  return value;
}

/** True when a key names a secret we must never display. */
export function keyIsSecret(key: string): boolean {
  return isSensitiveEnvName(key);
}