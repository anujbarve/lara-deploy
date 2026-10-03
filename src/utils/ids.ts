/**
 * Identifiers and clocks.
 *
 * Injected everywhere so tests can produce deterministic release names and
 * deployment IDs without mocking global time.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Fixed clock for tests. */
export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function releaseStamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/** `YYYY-MM-DD HH:MM:SS` in local time — used in locks and manifests. */
export function humanTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/** Compact random token, URL-safe. */
export function shortToken(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Cryptographically random string over an unambiguous alphabet. */
export function randomHexish(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[buf[i]! % alphabet.length];
  return out;
}

/** Cryptographically random hex string. */
export function randomHex(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build a release id.
 * With a short git SHA: `20261003-101530-a1b2c3d`.
 */
export function buildReleaseId(stamp: string, gitSha?: string | null): string {
  if (!gitSha) return stamp;
  return `${stamp}-${gitSha.slice(0, 7)}`;
}

/** `DEPLOY-20261003-103210-A1B2`. */
export function buildDeploymentId(stamp: string, token: string): string {
  return `DEPLOY-${stamp}-${token.toUpperCase()}`;
}

/** Human duration: `2m 14s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `38.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** Cryptographically strong password suitable for a DB user. */
export function generatePassword(length = 28): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+';
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}