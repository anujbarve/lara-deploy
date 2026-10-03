/**
 * Client-side platform helpers.
 *
 * The CLI runs on the developer's machine — macOS, Linux or Windows — while the
 * deployment target is always a POSIX host. That boundary is where portability
 * bugs live: the local executor hands command strings to the *native* shell
 * (cmd.exe on Windows, /bin/sh elsewhere), so POSIX-only incantations such as
 * `command -v`, `uname -sr` or `2>/dev/null` silently fail there, and
 * `process.env.USER` is simply not defined.
 *
 * Every such decision is funnelled through this module so the rest of the
 * client can stay platform-agnostic and so the behaviour is testable on any
 * host by passing a synthetic environment.
 *
 * Note that `src/utils/shell.ts` is the opposite case: it quotes *remote* POSIX
 * commands and must never become platform-aware.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/** Executable extensions Windows appends when resolving a bare command name. */
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Matches an absolute Windows path, including the drive-letter form. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Read an environment variable, tolerating the case-insensitivity of Windows.
 *
 * `process.env` is case-insensitive on Windows, but a plain object (as passed to
 * execa, or built in a test) preserves whatever casing the OS supplied — which
 * is frequently `Path` rather than `PATH`.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (!IS_WINDOWS) return undefined;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered && value !== undefined) return value;
  }
  return undefined;
}

/** Split a PATH/PATHEXT-style list, honouring the platform's separator. */
function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  // A Windows PATH entry is quoted when it contains spaces, and `;` may appear
  // inside the quoted segment, so the split has to be quote-aware.
  const separator = IS_WINDOWS ? ';' : ':';
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    // Windows has no execute bit; POSIX does, and a non-executable file is not
    // something the user can run.
    if (!IS_WINDOWS) fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a bare command name to an absolute path, or null when it is not
 * installed.
 *
 * This replaces `command -v` (POSIX) and `where` (Windows). Doing the PATH walk
 * in Node rather than spawning a shell keeps the answer identical on every
 * platform, avoids a subprocess per lookup, and makes the Windows executable
 * extensions (`.CMD`, `.BAT`, …) work — which is what npm, pnpm and friends
 * actually install.
 */
export function lookupPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command === '') return null;

  const isPathLike = command.includes('/') || command.includes('\\') || WINDOWS_ABSOLUTE.test(command);
  if (isPathLike) {
    const absolute = path.resolve(command);
    return isExecutableFile(absolute) ? absolute : null;
  }

  const extensions = IS_WINDOWS ? windowsExtensions(env) : [''];

  for (const dir of splitPathList(envValue(env, 'PATH'))) {
    const base = path.join(dir, command);
    // A command given with its extension (`php.exe`) must match directly; a bare
    // name is tried bare first, then with each executable extension.
    if (isExecutableFile(base)) return base;
    for (const extension of extensions) {
      if (extension === '') continue;
      const candidate = base + extension;
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The executable extensions to try, from PATHEXT or the Windows default. */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = splitPathList(envValue(env, 'PATHEXT'));
  return fromEnv.length > 0 ? fromEnv : splitPathList(WINDOWS_DEFAULT_PATHEXT);
}

/** True when the command is installed on this machine. */
export function hasCommand(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return lookupPath(command, env) !== null;
}

/** The current user name, across the USER (POSIX) and USERNAME (Windows) vars. */
export function currentUser(env: NodeJS.ProcessEnv = process.env): string {
  // Each platform sets exactly one of these; the other is only consulted so a
  // synthesised environment (tests, CI) still resolves.
  const [native, other] = IS_WINDOWS ? ['USERNAME', 'USER'] : ['USER', 'USERNAME'];
  for (const name of [native, other]) {
    const value = envValue(env, name);
    if (value && value.trim() !== '') return value;
  }
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

/**
 * A short human description of the local OS, e.g. "Darwin 23.1.0" or
 * "Windows 10.0.19045".
 *
 * Derived from `os` rather than `uname -sr`, so it is correct on Windows and
 * needs no subprocess. The wording deliberately matches `uname -sr` so existing
 * output on macOS and Linux is unchanged.
 */
export function osDescription(): string {
  const name = os.type().replace(/_/g, ' ').trim();
  return `${name} ${os.release()}`.trim();
}

/** The local hostname, or an empty string when the OS will not say. */
export function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return '';
  }
}

/**
 * Collapse CRLF to LF.
 *
 * Local subprocesses terminate lines with `\r\n` on Windows while remote ones
 * never do. Normalising at the executor boundary means every downstream
 * `split('\n')` behaves the same on all platforms, so no UI or parser has to
 * carry its own `\r?` handling.
 */
export function normalizeOutput(value: string): string {
  return value.includes('\r\n') ? value.replace(/\r\n/g, '\n') : value;
}

/**
 * Restrict a file to its owner.
 *
 * `chmod 600` is a no-op on Windows: NTFS access is governed by ACLs, and Node
 * cannot express "only this user" through a mode bit. Reporting a success that
 * did nothing would be worse than saying nothing, so this returns false and the
 * caller tells the user what Windows does instead.
 */
export function restrictToOwner(file: string): boolean {
  if (IS_WINDOWS) return false;
  try {
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}
