/**
 * SSH host key verification.
 *
 * `ssh2` does not read `~/.ssh/known_hosts`. Its documented default is to
 * *auto-accept* any host key when no `hostVerifier` is supplied:
 *
 *   Default: (auto-accept if `hostVerifier` is not set)
 *
 * so setting `strictHostKeyChecking: true` on its own verified nothing, and the
 * CLI silently accepted any key anyone presented. This module implements the
 * check that was always intended (SPEC §58): a fatal error for an unknown host,
 * an explicit opt-out for operators who need it.
 *
 * The file is read up front rather than inside the verifier so an unknown host
 * fails immediately, with an actionable message, instead of surfacing as a
 * generic handshake disconnect.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransportError } from '../../core/errors/errors.js';
import type { ServerProfile } from '../../core/config/schema.js';

export interface KnownHostEntry {
  /** Raw host patterns, e.g. "example.com" or "*.internal" or "|1|salt|hash". */
  patterns: string[];
  /** SSH key type, e.g. "ssh-ed25519". */
  keyType: string;
  /** Decoded public key blob. */
  key: Buffer;
  /** True when the line carried `@revoked`. */
  revoked: boolean;
  /** True when the line carried `@cert-authority`. */
  certificateAuthority: boolean;
}

const DEFAULT_PORT = 22;

/** `~/.ssh/known_hosts`, the file OpenSSH itself would use. */
export function defaultKnownHostsPath(): string {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

/**
 * Match one OpenSSH host pattern against a hostname.
 *
 * Supports `*` and `?` wildcards and is case-insensitive, as hostnames are.
 * A hashed entry (`|1|salt|hash`) is matched by recomputing its HMAC, which is
 * how OpenSSH stores a host without revealing it.
 */
export function matchesPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith('|1|')) {
    const parts = pattern.split('|');
    const salt = Buffer.from(parts[2] ?? '', 'base64');
    const expected = Buffer.from(parts[3] ?? '', 'base64');
    const actual = crypto.createHmac('sha1', salt).update(host).digest();
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(host);
}

/** True when a line's host list selects this hostname (honouring `!` negation). */
function entryMatches(entry: KnownHostEntry, host: string): boolean {
  let matched = false;
  for (const raw of entry.patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (!matchesPattern(pattern, host)) continue;
    // A negation anywhere on the line disqualifies the whole entry.
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/**
 * Parse known_hosts contents.
 *
 * Unknown line shapes are skipped rather than thrown on: OpenSSH files also
 * contain options (`@cert-authority`) and comments, and one odd line must not
 * make an entire deployment undeployable.
 */
export function parseKnownHosts(contents: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    let fields = line.split(/\s+/);
    let revoked = false;
    let certificateAuthority = false;

    while (fields.length > 0 && fields[0]!.startsWith('@')) {
      const marker = fields[0]!.toLowerCase();
      if (marker === '@revoked') revoked = true;
      if (marker === '@cert-authority') certificateAuthority = true;
      fields = fields.slice(1);
    }
    if (fields.length < 3) continue;

    const [hostList, keyType, encodedKey] = fields as [string, string, string];
    let key: Buffer;
    try {
      key = Buffer.from(encodedKey, 'base64');
    } catch {
      continue;
    }
    if (key.length === 0) continue;

    entries.push({
      patterns: hostList.split(',').filter((p) => p !== ''),
      keyType,
      key,
      revoked,
      certificateAuthority,
    });
  }

  return entries;
}

/** Every host key recorded for a host, newest matching entry set. */
export function lookupHostKeys(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number = DEFAULT_PORT,
): { keys: Buffer[]; revoked: boolean } {
  // OpenSSH records a non-default port as "[host]:port".
  const candidates = port === DEFAULT_PORT ? [host] : [host, `[${host}]:${port}`];

  const keys: Buffer[] = [];
  let revoked = false;

  for (const entry of entries) {
    if (!candidates.some((candidate) => entryMatches(entry, candidate))) continue;
    if (entry.revoked) {
      revoked = true;
      continue;
    }
    keys.push(entry.key);
  }

  return { keys, revoked };
}

/** Read and parse a known_hosts file, with a fatal error when unusable. */
export function loadKnownHosts(file: string): KnownHostEntry[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new TransportError(`Cannot read the SSH known_hosts file at ${file}.`, {
      cause,
      remediation: [
        `Add the server's key: ssh-keyscan -p ${DEFAULT_PORT} HOST >> ${file}`,
        'Or point the profile at another file with `laravel-deploy server set NAME --known-hosts <path>`.',
        'Or set strictHostKeyChecking = false to accept any key (not recommended).',
      ],
    });
  }
  return parseKnownHosts(contents);
}

/**
 * Build the `hostVerifier` for a profile, or null when checking is disabled.
 *
 * Throws before connecting when the host is unknown or explicitly revoked, so
 * the operator gets the reason rather than a handshake failure.
 */
export function buildHostVerifier(
  profile: ServerProfile,
  options: { knownHostsPath?: string } = {},
): ((key: Buffer) => boolean) | null {
  if (!profile.strictHostKeyChecking) return null;

  const file = options.knownHostsPath ?? profile.knownHosts ?? defaultKnownHostsPath();
  const entries = loadKnownHosts(file);
  const { keys, revoked } = lookupHostKeys(entries, profile.host, profile.port);

  if (revoked) {
    throw new TransportError(`The SSH host key for ${profile.host} is marked revoked in ${file}.`, {
      remediation: ['Remove the @revoked entry if this is a known-good re-provisioning of the server.'],
    });
  }

  if (keys.length === 0) {
    throw new TransportError(
      `${profile.host}:${profile.port} is not in ${file}, so its identity cannot be verified.`,
      {
        remediation: [
          `Trust it explicitly: ssh-keyscan -p ${profile.port} ${profile.host} >> ${file}`,
          'Or set strictHostKeyChecking = false to accept any key (not recommended).',
        ],
      },
    );
  }

  return (key: Buffer): boolean =>
    keys.some((expected) => expected.length === key.length && crypto.timingSafeEqual(expected, key));
}