/**
 * SSH host key verification.
 *
 * ssh2 does not read `~/.ssh/known_hosts`; its documented default is to
 * auto-accept any key when no `hostVerifier` is set. The CLI set no verifier
 * when `strictHostKeyChecking` was true — the default — so the setting did
 * nothing and the MITM protection the docs promised was absent.
 *
 * The fixtures below are real `ssh-keygen` output (including `ssh-keygen -H`
 * hashed entries), so the format handling is validated against what OpenSSH
 * actually writes rather than against invented strings.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseKnownHosts,
  matchesPattern,
  lookupHostKeys,
  loadKnownHosts,
  buildHostVerifier,
  defaultKnownHostsPath,
} from '../src/providers/ssh/known-hosts.js';
import { serverProfileSchema } from '../src/core/config/schema.js';
import { TransportError } from '../src/core/errors/errors.js';
import { SshExecutor } from '../src/providers/exec/ssh.js';
import { SftpUploader, resolveSftpClientConstructor } from '../src/providers/sftp/uploader.js';

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

// Real ed25519 public keys, generated with `ssh-keygen -t ed25519`.
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIBAz7DW86KWLXpBF2MloT9auBjwtI/drDNnmRRb1Mtt3';
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIIRZXiQqOeI8kWR7+ycM7jJ7F26OZl4AV39Rzw5+V7on';
const blobA = Buffer.from(KEY_A, 'base64');
const blobB = Buffer.from(KEY_B, 'base64');

/** A real `ssh-keygen -H` output: hashed hosts for example.com, alt.example.com and example.com:2222. */
const HASHED_KNOWN_HOSTS = [
  '|1|GV5DkQaI3OIusbBaQ/BYOUuaFD4=|Mx7nHkfHdZRRCnr6t2YNYiYOCbg= ssh-ed25519 ' + KEY_A,
  '|1|0ybm6NLoJQrQDlkOgcN5LdQEkCw=|nvbdSdcGW5AQxVWVCg8ydoFcZQs= ssh-ed25519 ' + KEY_A,
  '|1|fO0PAAikNtUwJfrpWk+VidlknhI=|wM22DUWfh7QlVibHFh0+Om03qgw= ssh-ed25519 ' + KEY_B,
].join('\n');

function tempKnownHosts(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-kh-'));
  created.push(dir);
  const file = path.join(dir, 'known_hosts');
  fs.writeFileSync(file, `${contents}\n`);
  return file;
}

function profile(overrides: Record<string, unknown> = {}) {
  return serverProfileSchema.parse({
    name: 'test',
    host: 'example.com',
    username: 'root',
    ...overrides,
  });
}

describe('parseKnownHosts', () => {
  it('parses a plain entry', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.keyType).toBe('ssh-ed25519');
    expect(entries[0]?.key.equals(blobA)).toBe(true);
    expect(entries[0]?.revoked).toBe(false);
  });

  it('parses a real ssh-keygen -H hashed file', () => {
    const entries = parseKnownHosts(HASHED_KNOWN_HOSTS);
    expect(entries).toHaveLength(3);
    expect(lookupHostKeys(entries, 'example.com', 22).keys[0]?.equals(blobA)).toBe(true);
    expect(lookupHostKeys(entries, 'alt.example.com', 22).keys[0]?.equals(blobA)).toBe(true);
  });

  it('parses multiple hosts and keys on one line', () => {
    const entries = parseKnownHosts(`a.example.com,b.example.com ssh-ed25519 ${KEY_A}`);
    expect(entries[0]?.patterns).toEqual(['a.example.com', 'b.example.com']);
    expect(lookupHostKeys(entries, 'b.example.com', 22).keys).toHaveLength(1);
  });

  it('reads @revoked and @cert-authority markers', () => {
    const entries = parseKnownHosts(
      [
        `@revoked example.com ssh-ed25519 ${KEY_A}`,
        `@cert-authority *.internal ssh-ed25519 ${KEY_B}`,
      ].join('\n'),
    );
    expect(entries[0]?.revoked).toBe(true);
    expect(entries[1]?.certificateAuthority).toBe(true);
    expect(lookupHostKeys(entries, 'example.com', 22).revoked).toBe(true);
  });

  it('ignores comments, blank lines and malformed entries', () => {
    // One unreadable line must not make a whole deployment undeployable.
    const entries = parseKnownHosts(
      ['# a comment', '', '   ', 'garbage', `example.com ssh-ed25519 ${KEY_A}`, 'host only-two'].join('\n'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patterns).toEqual(['example.com']);
  });

  it('handles CRLF line endings', () => {
    expect(parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}\r\n`)).toHaveLength(1);
  });
});

describe('matchesPattern', () => {
  it('matches exactly and case-insensitively', () => {
    expect(matchesPattern('example.com', 'example.com')).toBe(true);
    expect(matchesPattern('example.com', 'EXAMPLE.COM')).toBe(true);
    expect(matchesPattern('example.com', 'other.com')).toBe(false);
    expect(matchesPattern('example.com', 'example.com.evil.test')).toBe(false);
  });

  it('supports OpenSSH wildcards', () => {
    expect(matchesPattern('*.example.com', 'api.example.com')).toBe(true);
    expect(matchesPattern('*.example.com', 'example.com')).toBe(false);
    expect(matchesPattern('web?.example.com', 'web1.example.com')).toBe(true);
  });

  it('does not let a wildcard pattern escape via regex characters', () => {
    expect(matchesPattern('a.example.com', 'aXexampleYcom')).toBe(false);
    expect(matchesPattern('a+b.example.com', 'a+b.example.com')).toBe(true);
  });

  it('matches hashed entries by recomputing the HMAC', () => {
    const line = HASHED_KNOWN_HOSTS.split('\n')[0] as string;
    const pattern = line.split(' ')[0] as string;
    expect(matchesPattern(pattern, 'example.com')).toBe(true);
    expect(matchesPattern(pattern, 'attacker.example.com')).toBe(false);
  });
});

describe('lookupHostKeys', () => {
  it('returns every key recorded for a host', () => {
    const entries = parseKnownHosts(
      [`example.com ssh-ed25519 ${KEY_A}`, `example.com ssh-rsa ${KEY_B}`].join('\n'),
    );
    expect(lookupHostKeys(entries, 'example.com', 22).keys).toHaveLength(2);
  });

  it('returns nothing for an unknown host', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(lookupHostKeys(entries, 'attacker.test', 22).keys).toHaveLength(0);
  });

  it('finds the bracketed [host]:port form for a non-default port', () => {
    const entries = parseKnownHosts(`[example.com]:2222 ssh-ed25519 ${KEY_A}`);
    expect(lookupHostKeys(entries, 'example.com', 2222).keys).toHaveLength(1);
    // The same host on the default port has no entry.
    expect(lookupHostKeys(entries, 'example.com', 22).keys).toHaveLength(0);
  });

  it('honours a negated pattern on the line', () => {
    const entries = parseKnownHosts(`*.example.com,!secret.example.com ssh-ed25519 ${KEY_A}`);
    expect(lookupHostKeys(entries, 'api.example.com', 22).keys).toHaveLength(1);
    expect(lookupHostKeys(entries, 'secret.example.com', 22).keys).toHaveLength(0);
  });

  it('reports a revoked host rather than returning its keys', () => {
    const entries = parseKnownHosts(`@revoked example.com ssh-ed25519 ${KEY_A}`);
    const result = lookupHostKeys(entries, 'example.com', 22);
    expect(result.revoked).toBe(true);
    expect(result.keys).toHaveLength(0);
  });
});

describe('buildHostVerifier', () => {
  it('accepts the recorded key and rejects a different one', () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    const verify = buildHostVerifier(profile(), { knownHostsPath: file });

    expect(verify).not.toBeNull();
    expect(verify?.(blobA)).toBe(true);
    // The whole point: a substituted key must not be accepted.
    expect(verify?.(blobB)).toBe(false);
    expect(verify?.(Buffer.from('not a key'))).toBe(false);
  });

  it('verifies against a real hashed known_hosts file', () => {
    const verify = buildHostVerifier(profile(), { knownHostsPath: tempKnownHosts(HASHED_KNOWN_HOSTS) });
    expect(verify?.(blobA)).toBe(true);
    expect(verify?.(blobB)).toBe(false);
  });

  it('is fatal for a host that is not in the file', () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    try {
      buildHostVerifier(profile({ host: 'unknown.test' }), { knownHostsPath: file });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).message).toContain('cannot be verified');
      // The remediation must tell the operator what to actually run.
      expect((error as TransportError).remediation.join(' ')).toContain('ssh-keyscan');
    }
  });

  it('is fatal for a revoked host, and does not hand back a verifier', () => {
    const file = tempKnownHosts(`@revoked example.com ssh-ed25519 ${KEY_A}`);
    expect(() => buildHostVerifier(profile(), { knownHostsPath: file })).toThrow(/revoked/);
  });

  it('is fatal when the known_hosts file cannot be read', () => {
    const missing = path.join(os.tmpdir(), 'definitely-absent-known-hosts');
    expect(() => buildHostVerifier(profile(), { knownHostsPath: missing })).toThrow(TransportError);
  });

  it('returns null when strictHostKeyChecking is off, so the caller opts out explicitly', () => {
    const verify = buildHostVerifier(profile({ strictHostKeyChecking: false }));
    expect(verify).toBeNull();
  });

  it('uses the profile knownHosts path when one is configured', () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(buildHostVerifier(profile({ knownHosts: file }))?.(blobA)).toBe(true);
  });

  it('defaults to the OpenSSH location', () => {
    expect(defaultKnownHostsPath()).toBe(path.join(os.homedir(), '.ssh', 'known_hosts'));
  });
});

describe('loadKnownHosts', () => {
  it('reads a file from disk', () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY_A}`);
    expect(loadKnownHosts(file)).toHaveLength(1);
  });

  it('throws a TransportError, not a bare fs error', () => {
    expect(() => loadKnownHosts(path.join(os.tmpdir(), 'absent-kh'))).toThrow(TransportError);
  });
});
/**
 * Wiring.
 *
 * The verifier only protects anything if it actually reaches the ssh2 connect
 * config. `SshExecutor` and `SftpUploader` each build their own config, and the
 * uploader previously set no verifier at all — so these assert the verifier is
 * present on both, rather than only that the helper works in isolation.
 */
describe('host verifier reaches the connection', () => {
  const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBAz7DW86KWLXpBF2MloT9auBjwtI/drDNnmRRb1Mtt3';
  const OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIIRZXiQqOeI8kWR7+ycM7jJ7F26OZl4AV39Rzw5+V7on';

  /** connectConfig needs a credential before it reaches the verifier. */
  function withCredentials(overrides: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-key-'));
    created.push(dir);
    const keyFile = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    return profile({ sshKey: keyFile, ...overrides });
  }

  it('SshExecutor attaches a verifier that rejects a substituted key', async () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY}`);
    let captured: Record<string, unknown> | null = null;

    const executor = new SshExecutor({
      profile: withCredentials({ knownHosts: file }),
      clientFactory: (config) => {
        captured = config as unknown as Record<string, unknown>;
        // Never completes: the config is what is under test.
        return { on: () => undefined, once: () => undefined, end: () => undefined } as never;
      },
    });

    void executor.exec('true', { allowFailure: true }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const verifier = captured?.['hostVerifier'] as ((k: Buffer) => boolean) | undefined;
    expect(verifier).toBeTypeOf('function');
    expect(verifier?.(Buffer.from(KEY, 'base64'))).toBe(true);
    expect(verifier?.(Buffer.from(OTHER, 'base64'))).toBe(false);
    await executor.close();
  });

  it('SshExecutor refuses to connect to a host it cannot verify', async () => {
    const file = tempKnownHosts(`other.example.com ssh-ed25519 ${KEY}`);
    const executor = new SshExecutor({
      profile: withCredentials({ knownHosts: file }),
      clientFactory: () => ({ on: () => undefined, once: () => undefined, end: () => undefined }) as never,
    });

    // Fails before any socket is opened, with an actionable message.
    await expect(executor.exec('true', { allowFailure: true })).rejects.toThrow(/cannot be verified/);
    await executor.close();
  });

  it('SftpUploader attaches a verifier too', async () => {
    const file = tempKnownHosts(`example.com ssh-ed25519 ${KEY}`);
    let captured: Record<string, unknown> | null = null;

    const uploader = new SftpUploader({
      profile: withCredentials({ knownHosts: file }),
      clientFactory: () =>
        ({
          connect: async (config: Record<string, unknown>) => {
            captured = config;
            return undefined;
          },
          end: async () => undefined,
          mkdir: async () => '',
        }) as never,
    });

    await uploader.stat('/nothing');
    const verifier = captured?.['hostVerifier'] as ((k: Buffer) => boolean) | undefined;
    expect(verifier).toBeTypeOf('function');
    expect(verifier?.(Buffer.from(KEY, 'base64'))).toBe(true);
    expect(verifier?.(Buffer.from(OTHER, 'base64'))).toBe(false);
    await uploader.close();
  });
});

describe('SFTP client construction', () => {
  const profile = serverProfileSchema.parse({
    name: 'test',
    host: '10.0.0.1',
    username: 'root',
    siteRoot: '/www/wwwroot',
  });

  it('builds a real client when none is injected', () => {
    // Every other test injects a clientFactory, which is why the real
    // construction path shipped broken: ssh2-sftp-client does
    // `module.exports = SftpClient`, so destructuring { SftpClient } from the
    // default import is undefined and every upload threw
    // "SftpClient is not a constructor".
    expect(() => new SftpUploader({ profile })).not.toThrow();
  });

  it('resolves the constructor from every shape the dependency uses', () => {
    class Full {
      connect(): Promise<string> {
        return Promise.resolve('');
      }
      end(): Promise<void> {
        return Promise.resolve();
      }
      fastPut(): Promise<string> {
        return Promise.resolve('');
      }
      put(): Promise<string> {
        return Promise.resolve('');
      }
      mkdir(): Promise<string> {
        return Promise.resolve('');
      }
      // The real client spells this `delete`; `unlink` never existed.
      delete(): Promise<string> {
        return Promise.resolve('');
      }
      stat(): Promise<{ size: number }> {
        return Promise.resolve({ size: 0 });
      }
    }
    expect(resolveSftpClientConstructor(Full)).toBe(Full);
    expect(resolveSftpClientConstructor({ SftpClient: Full })).toBe(Full);
    expect(resolveSftpClientConstructor({ default: { SftpClient: Full } })).toBe(Full);
    expect(resolveSftpClientConstructor({ default: Full })).toBe(Full);
  });

  it('rejects a client missing methods the uploader calls', () => {
    // A hand-written interface compiles happily against a method the real
    // client lacks, which is how `unlink` shipped and its TypeError was
    // swallowed, leaving stale archives on the server forever.
    class Partial {
      connect(): Promise<string> {
        return Promise.resolve('');
      }
    }
    expect(() => resolveSftpClientConstructor(Partial)).toThrow(/missing required methods/);
    try {
      resolveSftpClientConstructor(Partial);
    } catch (error) {
      expect((error as TransportError).message).toContain('delete');
      expect((error as TransportError).remediation.join(' ')).toContain('npm install');
    }
  });

  it('fails with actionable advice when no constructor is present', () => {
    expect(() => resolveSftpClientConstructor({})).toThrow(/Could not load the SFTP client/);
    try {
      resolveSftpClientConstructor({});
    } catch (error) {
      expect((error as TransportError).remediation.join(' ')).toContain('npm install');
    }
  });
});
