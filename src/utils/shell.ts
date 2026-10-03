/**
 * Shell safety.
 *
 * Remote commands are assembled as strings because we are talking to a POSIX
 * shell over SSH. That makes quoting the single most important security
 * primitive in this codebase (SPEC §58): no untrusted value may ever be
 * concatenated into a command without going through `q()`.
 */

import { AppError, SafetyError } from '../core/errors/errors.js';

/**
 * POSIX single-quote a value.
 *
 * Wraps in single quotes and escapes embedded single quotes as `'\''`.
 * The result is safe to interpolate into any POSIX shell command.
 */
export function q(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "''";
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Quote each argument and join with spaces. */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args.map((a) => q(a))].join(' ');
}

/**
 * Escape a value for embedding inside a double-quoted shell word.
 * Still prefer `q()`; this exists for constructing heredoc/JSON payloads.
 */
export function doubleQuoted(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Guard against newline/control-character injection. A value containing a
 * newline can silently start a second command even when quoted on some
 * exec implementations, so we reject it outright for identifiers and paths.
 */
export function assertNoControlChars(value: string, label: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\0]/.test(value)) {
    throw new SafetyError(`Refusing to use ${label} containing a newline or null byte.`, {
      remediation: [`Remove line breaks from ${label} and try again.`],
    });
  }
}

/**
 * Validate a remote absolute path: must be absolute, POSIX-ish, no traversal
 * segments, no control characters.
 */
export function assertRemotePath(value: string, label = 'path'): string {
  assertNoControlChars(value, label);
  if (!value.startsWith('/')) {
    throw new SafetyError(`Refusing to use ${label} "${value}": an absolute path is required.`);
  }
  if (value.split('/').includes('..')) {
    throw new SafetyError(`Refusing to use ${label} "${value}" containing a traversal segment.`);
  }
  return value;
}

/** Validate a hostname (or bare IPv4/IPv6 literal). */
export function assertHostname(value: string): string {
  assertNoControlChars(value, 'hostname');
  const host = value.trim();
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIpv4 && host.split('.').every((o) => Number(o) <= 255)) return host;
  if (host.includes(':')) return host; // IPv6 literal
  if (/^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/.test(host)) {
    return host;
  }
  throw new SafetyError(`"${value}" is not a valid hostname.`, {
    remediation: ['Use a domain such as example.com or an IP address.'],
  });
}

/** Validate a MySQL/database identifier (letters, digits, underscore, dash). */
export function assertIdentifier(value: string, label = 'identifier'): string {
  assertNoControlChars(value, label);
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(value)) {
    throw new SafetyError(`Invalid ${label} "${value}".`, {
      remediation: ['Use only letters, digits, underscore or dash (max 64 characters).'],
    });
  }
  return value;
}

/**
 * Validate a supervisor program name.
 *
 * Program names reach the remote shell through `supervisorctl restart <name>`
 * and become a path under the supervisor config directory, so they must not be
 * able to carry shell metacharacters (`;` `|` `&` `$` backtick, whitespace) or
 * `..`. The first character is restricted to a letter or digit so a name can
 * never be mistaken for a `supervisorctl` flag.
 *
 * `assertIdentifier` is not enough: it permits a leading `-`, which would let a
 * configured name inject an option into supervisorctl.
 */
export function assertProgramName(value: string, label = 'supervisor program name'): string {
  assertNoControlChars(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new SafetyError(`Invalid ${label} "${value}".`, {
      remediation: [
        'Use only letters, digits, dot, underscore or dash, starting with a letter or digit.',
        'This name is passed to supervisorctl on the server, so it cannot contain shell characters.',
      ],
    });
  }
  return value;
}

/**
 * Wrap a body so the shell reports failures with context.
 * Prepended to every generated remote script.
 */
export function shellPreamble(): string {
  return 'set -Eeuo pipefail\ntrap \'echo "remote script failed at line $LINENO" >&2\' ERR\n';
}

/** Build a heredoc that safely transports a script body. */
export function heredoc(tag: string, body: string): string {
  // A heredoc tag must be alphanumeric, so punctuation is stripped.
  const safeTag = tag.replace(/[^A-Za-z0-9]/g, '') || 'EOF';
  return `${safeTag} <<'${safeTag}'\n${body.replace(/\n?$/, '')}\n${safeTag}`;
}

/** Convenience for "value must be non-empty". */
export function requireValue(value: string | undefined | null, label: string): string {
  if (value === undefined || value === null || value.trim() === '') {
    throw new AppError(`Missing required value: ${label}.`);
  }
  return value;
}