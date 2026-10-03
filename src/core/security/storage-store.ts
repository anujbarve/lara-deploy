/**
 * File-backed secrets store.
 *
 * Values are written to a 0600 file. When LARAVEL_DEPLOY_SECRET_PASSPHRASE is
 * set they are additionally encrypted at rest with AES-256-GCM; without it the
 * store still refuses to print values and reports `encrypted: false` so callers
 * can warn the operator.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MissingCredentialError } from '../errors/errors.js';
import { randomHexish } from '../../utils/ids.js';

const ALGO = 'aes-256-gcm';

interface Entry {
  value: string;
  iv?: string;
  tag?: string;
  updatedAt: string;
}

interface SecretsFile {
  version: 1;
  encrypted: boolean;
  entries: Record<string, Entry>;
}

export class StorageSecretsStore {
  private data: SecretsFile;
  private readonly pass: string | undefined;

  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    const pass = env.LARAVEL_DEPLOY_SECRET_PASSPHRASE;
    this.pass = pass && pass.trim() !== '' ? pass : undefined;
    this.data = this.read();
  }

  get encrypted(): boolean {
    return this.pass !== undefined;
  }

  get location(): string {
    return this.file;
  }

  private blank(): SecretsFile {
    return { version: 1, encrypted: this.encrypted, entries: {} };
  }

  private read(): SecretsFile {
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
      typeof (parsed as SecretsFile).entries !== 'object' ||
      (parsed as SecretsFile).entries === null
    ) {
      return this.blank();
    }
    const file = parsed as SecretsFile;
    return { version: 1, encrypted: file.encrypted === true, entries: { ...file.entries } };
  }

  private encrypt(plain: string): Entry {
    if (!this.pass) throw new MissingCredentialError('No encryption passphrase available.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      value: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      updatedAt: new Date().toISOString(),
    };
  }

  private decrypt(entry: Entry): string | undefined {
    // An unencrypted entry (written before a passphrase was configured).
    if (!entry.iv || !entry.tag) return entry.value;
    if (!this.pass) return undefined;
    try {
      const decipher = crypto.createDecipheriv(ALGO, this.key(), Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.value, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private key(): Buffer {
    return crypto.createHash('sha256').update(this.pass as string, 'utf8').digest();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomHexish(4)}.tmp`;
    // 0600 from creation; never widen afterwards.
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(key: string): string | undefined {
    const entry = this.data.entries[key];
    return entry ? this.decrypt(entry) : undefined;
  }

  set(key: string, value: string): void {
    const stored = this.encrypted
      ? this.encrypt(value)
      : { value, updatedAt: new Date().toISOString() };
    this.data.entries[key] = { ...stored, updatedAt: stored.updatedAt };
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