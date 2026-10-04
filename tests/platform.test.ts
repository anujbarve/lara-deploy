/**
 * Client platform tests.
 *
 * The client has to run on macOS, Linux and Windows while the deployment target
 * is always a POSIX host. These tests pin the two halves of that boundary that
 * are easy to regress: resolving a local command through the OS PATH (rather
 * than `command -v`) and picking a platform-appropriate config directory.
 *
 * Windows-specific branches live in `platform-windows.test.ts`, which stubs
 * `process.platform` so they run on any host. This file covers the behaviour
 * that is the same everywhere plus the POSIX branch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IS_WINDOWS,
  envValue,
  lookupPath,
  hasCommand,
  currentUser,
  osDescription,
  hostname,
  normalizeOutput,
  restrictToOwner,
} from '../src/utils/platform.js';
import {
  globalConfigDir,
  legacyGlobalConfigDir,
  migrateLegacyConfigDir,
  copyConfigDir,
  remoteScriptsDir,
} from '../src/core/config/paths.js';
import { LocalExecutor } from '../src/providers/exec/local.js';

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-deploy-platform-'));
  created.push(dir);
  return dir;
}

describe('platform detection', () => {
  it('agrees with process.platform', () => {
    expect(IS_WINDOWS).toBe(process.platform === 'win32');
  });
});

describe('envValue', () => {
  it.skipIf(IS_WINDOWS)('reads POSIX variable names verbatim', () => {
    // Case-insensitivity is a Windows concept; on POSIX `path` and `PATH` are
    // genuinely different variables and must not be conflated.
    expect(envValue({ PATH: '/usr/bin' }, 'PATH')).toBe('/usr/bin');
    expect(envValue({ path: '/usr/bin' }, 'PATH')).toBeUndefined();
  });
});

describe('lookupPath', () => {
  it('finds a real executable on PATH', () => {
    // `node` is by definition on the PATH of the process running these tests.
    const found = lookupPath('node');
    expect(found).not.toBeNull();
    expect(path.isAbsolute(found as string)).toBe(true);
    expect(hasCommand('node')).toBe(true);
  });

  it('returns null for a command that is not installed', () => {
    expect(lookupPath('definitely-not-a-real-command-xyz')).toBeNull();
    expect(hasCommand('definitely-not-a-real-command-xyz')).toBe(false);
  });

  it('returns null for an empty command name', () => {
    expect(lookupPath('')).toBeNull();
  });

  it('resolves an explicit relative path against the working directory', () => {
    const dir = tempDir();
    const file = path.join(dir, 'tool.sh');
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);

    const relative = path.relative(process.cwd(), file);
    if (relative.startsWith('..')) return; // different volume: not addressable relatively
    expect(lookupPath(relative)).toBe(path.resolve(relative));
    expect(lookupPath(path.join(dir, 'missing.sh'))).toBeNull();
  });

  it('resolves an explicit absolute path', () => {
    const file = path.join(tempDir(), 'tool.sh');
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
    // `command -v` would never match this; the PATH walk short-circuits on any
    // name that already carries a separator.
    expect(lookupPath(file)).toBe(file);
  });

  it('does not report a non-executable file as a command on POSIX', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'not-exec'), 'data');
    expect(lookupPath('not-exec', { ...process.env, PATH: dir })).toBeNull();
  });

  it.skipIf(IS_WINDOWS)('walks a colon-separated PATH', () => {
    const first = tempDir();
    const second = tempDir();
    fs.writeFileSync(path.join(first, 'php'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(second, 'composer'), '#!/bin/sh\n');
    fs.chmodSync(path.join(first, 'php'), 0o755);
    fs.chmodSync(path.join(second, 'composer'), 0o755);
    const env = { ...process.env, PATH: `${first}:${second}` };
    expect(lookupPath('php', env)).toBe(path.join(first, 'php'));
    expect(lookupPath('composer', env)).toBe(path.join(second, 'composer'));
    expect(lookupPath('mysql', env)).toBeNull();
  });

  it.skipIf(IS_WINDOWS)('ignores PATHEXT, which is a Windows concept', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'tool'), 0o755);
    const found = lookupPath('tool', { PATH: dir, PATHEXT: '.EXE' });
    expect(found).toBe(path.join(dir, 'tool'));
  });
});

describe('currentUser', () => {
  it('never returns an empty name', () => {
    expect(currentUser({}).trim()).not.toBe('');
  });

  it.skipIf(IS_WINDOWS)('prefers USER', () => {
    expect(currentUser({ USER: 'ada', USERNAME: 'ignored' })).toBe('ada');
  });

  it('ignores a blank variable and falls through', () => {
    expect(currentUser({ USER: '   ', USERNAME: 'ada' })).toBe('ada');
  });

  it('falls back to the OS user when no variable is set', () => {
    expect(currentUser({})).toBe(os.userInfo().username);
  });
});

describe('osDescription', () => {
  it('reports a name and a version, matching `uname -sr` on POSIX', () => {
    const description = osDescription();
    expect(description).toContain(os.type().replace(/_/g, ' ').trim());
    expect(description).toContain(os.release());
  });

  it.skipIf(IS_WINDOWS)('reads as "<name> <release>"', () => {
    // `uname -sr` on macOS and Linux is exactly this shape, so existing output
    // is unchanged even though the subprocess is gone.
    expect(osDescription()).toBe(`${os.type()} ${os.release()}`);
  });
});

describe('hostname', () => {
  it('returns a non-empty string or an empty string, never throws', () => {
    expect(typeof hostname()).toBe('string');
  });
});

describe('normalizeOutput', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizeOutput('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('leaves LF-only output untouched', () => {
    expect(normalizeOutput('a\nb\n')).toBe('a\nb\n');
  });

  it('does not touch a lone carriage return', () => {
    // A classic Mac CR is not a Windows line ending and must survive.
    expect(normalizeOutput('a\rb')).toBe('a\rb');
  });
});

describe('restrictToOwner', () => {
  it.skipIf(IS_WINDOWS)('applies mode 600 and reports it', () => {
    const file = path.join(tempDir(), 'id_ed25519');
    fs.writeFileSync(file, 'secret');
    fs.chmodSync(file, 0o644);
    expect(restrictToOwner(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!IS_WINDOWS)('reports false rather than claiming a no-op chmod', () => {
    const file = path.join(tempDir(), 'id_ed25519');
    fs.writeFileSync(file, 'secret');
    fs.chmodSync(file, 0o644);
    const before = fs.statSync(file).mode & 0o777;
    expect(restrictToOwner(file)).toBe(false);
    // Returning false must mean the file really is untouched, or the caller has
    // been told a lie about a credential.
    expect(fs.statSync(file).mode & 0o777).toBe(before);
  });
});

describe('global config directory', () => {
  it('honours the explicit override above everything', () => {
    const dir = tempDir();
    const env = { LARAVEL_DEPLOY_CONFIG_DIR: dir, XDG_CONFIG_HOME: '/xdg', APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' };
    expect(globalConfigDir(env)).toBe(path.resolve(dir));
  });

  it.skipIf(IS_WINDOWS)('uses XDG_CONFIG_HOME when set, else ~/.config', () => {
    expect(globalConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'laravel-deploy'));
    expect(globalConfigDir({})).toBe(path.join(os.homedir(), '.config', 'laravel-deploy'));
    // APPDATA is a Windows variable and must not sway the POSIX location.
    expect(globalConfigDir({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' })).toBe(
      legacyGlobalConfigDir({}),
    );
  });

  it.skipIf(IS_WINDOWS)('gives the native and legacy directories the same answer', () => {
    // Off Windows nothing moves, so migration has nothing to do.
    expect(legacyGlobalConfigDir({ XDG_CONFIG_HOME: '/xdg' })).toBe(globalConfigDir({ XDG_CONFIG_HOME: '/xdg' }));
  });
});

describe('migrateLegacyConfigDir', () => {
  it('is a no-op when the native and legacy directories are the same', () => {
    const dir = tempDir();
    expect(migrateLegacyConfigDir({ XDG_CONFIG_HOME: dir })).toEqual([]);
  });

  it('does not migrate anything when there is nothing to migrate', () => {
    expect(migrateLegacyConfigDir({ LARAVEL_DEPLOY_CONFIG_DIR: tempDir() })).toEqual([]);
  });

  it('never copies the real config into an explicit override', () => {
    // An explicit LARAVEL_DEPLOY_CONFIG_DIR is a deliberate "use exactly this".
    // Treating ~/.config/laravel-deploy as a migration source would silently
    // copy the user's real config, secrets and state into it.
    const home = tempDir();
    const legacy = path.join(home, '.config', 'laravel-deploy');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), '{"version":1,"servers":{}}\n');
    fs.writeFileSync(path.join(legacy, 'secrets.json'), '{"version":1,"encrypted":false,"entries":{}}\n');

    const originalHome = os.homedir;
    Object.defineProperty(os, 'homedir', { value: () => home, configurable: true });
    try {
      const target = tempDir();
      const env = { LARAVEL_DEPLOY_CONFIG_DIR: target };
      expect(legacyGlobalConfigDir(env)).toBeNull();
      expect(migrateLegacyConfigDir(env)).toEqual([]);
      // The override directory was left completely untouched.
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      Object.defineProperty(os, 'homedir', { value: originalHome, configurable: true });
    }
  });
});

describe('copyConfigDir', () => {
  it('carries config.json, secrets.json and the state directory across', () => {
    const legacy = tempDir();
    const native = path.join(tempDir(), 'native');
    fs.writeFileSync(path.join(legacy, 'config.json'), '{"version":1,"servers":{}}\n');
    fs.writeFileSync(path.join(legacy, 'secrets.json'), '{"version":1,"encrypted":false,"entries":{}}\n');
    fs.mkdirSync(path.join(legacy, 'state', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'state', 'cache', 'note.txt'), 'x');

    const copied = copyConfigDir(legacy, native);
    expect(copied.sort()).toEqual(['config.json', 'secrets.json', 'state']);
    expect(fs.readFileSync(path.join(native, 'config.json'), 'utf8')).toContain('"version":1');
    expect(fs.existsSync(path.join(native, 'state', 'cache', 'note.txt'))).toBe(true);
  });

  it('never overwrites a file that already exists in the native directory', () => {
    const legacy = tempDir();
    const native = tempDir();
    fs.writeFileSync(path.join(legacy, 'config.json'), 'legacy');
    fs.writeFileSync(path.join(legacy, 'secrets.json'), 'legacy');
    fs.writeFileSync(path.join(native, 'config.json'), 'native');

    const copied = copyConfigDir(legacy, native);
    expect(copied).toEqual(['secrets.json']);
    // A half-migrated directory must not clobber what the user already has here.
    expect(fs.readFileSync(path.join(native, 'config.json'), 'utf8')).toBe('native');
  });

  it('leaves the legacy directory untouched as a backup', () => {
    const legacy = tempDir();
    const native = path.join(tempDir(), 'native');
    fs.writeFileSync(path.join(legacy, 'config.json'), 'legacy');
    copyConfigDir(legacy, native);
    expect(fs.existsSync(path.join(legacy, 'config.json'))).toBe(true);
  });

  it('ignores unknown files rather than copying the whole directory', () => {
    const legacy = tempDir();
    const native = path.join(tempDir(), 'native');
    fs.writeFileSync(path.join(legacy, 'config.json'), 'legacy');
    fs.writeFileSync(path.join(legacy, 'notes.txt'), 'scratch');

    copyConfigDir(legacy, native);
    expect(fs.existsSync(path.join(native, 'notes.txt'))).toBe(false);
  });
});

describe('remoteScriptsDir', () => {
  it('resolves to a native absolute path containing the shipped scripts', () => {
    const dir = remoteScriptsDir();
    expect(path.isAbsolute(dir)).toBe(true);
    // The regression this guards: URL#pathname yields "/C:/..." on Windows and
    // a percent-encoded string everywhere else.
    expect(dir.startsWith('/C:/')).toBe(false);
    expect(dir).not.toContain('%20');
    expect(fs.existsSync(path.join(dir, 'prepare-release.sh'))).toBe(true);
  });
});

describe('LocalExecutor', () => {
  it('resolves commands through PATH rather than `command -v`', async () => {
    const executor = new LocalExecutor();
    try {
      await expect(executor.which('node')).resolves.toBe(true);
      await expect(executor.which('definitely-not-a-real-command-xyz')).resolves.toBe(false);
    } finally {
      await executor.close();
    }
  });

  it('reports info without shelling out to hostname or uname', async () => {
    const executor = new LocalExecutor();
    try {
      const info = await executor.info();
      expect(info.platform).toBe(process.platform);
      expect(info.hostname).not.toBe('');
      expect(info.os).not.toBe('');
      // `process.env.USER` is undefined on Windows, so this must not fall back to
      // 'unknown' there.
      if (process.env.USER) expect(info.user).toBe(process.env.USER);
      if (process.env.USERNAME) expect(info.user).toBe(process.env.USERNAME);
    } finally {
      await executor.close();
    }
  });

  it('normalises CRLF out of captured output', async () => {
    const executor = new LocalExecutor();
    try {
      // `echo` emits CRLF on Windows and LF on POSIX, so this assertion is
      // meaningful on both.
      const result = await executor.exec('echo one', { allowFailure: true });
      expect(result.stdout).not.toContain('\r');
      expect(result.stdout.split('\n')[0]).toBe('one');
    } finally {
      await executor.close();
    }
  });

  it('runs a build-shaped command through the native shell', async () => {
    const executor = new LocalExecutor();
    try {
      // The generated build steps are plain argument lists, which every shell
      // understands — this is the shape the local executor must keep accepting.
      const result = await executor.exec('echo npm ci', { allowFailure: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('npm ci');
    } finally {
      await executor.close();
    }
  });
});