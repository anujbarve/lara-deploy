/**
 * Windows behaviour of the platform helpers, verified from any host.
 *
 * `src/utils/platform.ts` reads `process.platform` once at import time, so these
 * tests stub the platform and re-import the module with a cleared cache. That
 * makes the Windows branches — `;`-separated PATH entries, PATHEXT resolution,
 * case-insensitive variable lookup, `%APPDATA%` — run on macOS and Linux CI
 * instead of only on a developer's Windows machine.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-deploy-win-'));
  created.push(dir);
  return dir;
}

type PlatformModule = typeof import('../src/utils/platform.js');
type PathsModule = typeof import('../src/core/config/paths.js');

let platform: PlatformModule;
let paths: PathsModule;

/**
 * Re-import both modules with process.platform stubbed. The paths module reads
 * IS_WINDOWS at import time too, so it has to be reloaded alongside.
 */
async function loadAsWindows(): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    vi.resetModules();
    platform = await import('../src/utils/platform.js');
    paths = await import('../src/core/config/paths.js');
  } finally {
    Object.defineProperty(process, 'platform', original as PropertyDescriptor);
  }
}

beforeAll(async () => {
  await loadAsWindows();
});

describe('Windows command lookup', () => {
  it('reports itself as Windows', () => {
    expect(platform.IS_WINDOWS).toBe(true);
  });

  it('walks a semicolon-separated PATH', () => {
    const first = tempDir();
    const second = tempDir();
    fs.writeFileSync(path.join(first, 'php'), 'x');
    fs.writeFileSync(path.join(second, 'composer'), 'x');
    // The separator is ';' on Windows and ':' on POSIX, which is why the module
    // reads it from the same constant the platform is stubbed from.
    const env = { PATH: `${first};${second}` };
    expect(platform.lookupPath('php', env)).toBe(path.join(first, 'php'));
    expect(platform.lookupPath('composer', env)).toBe(path.join(second, 'composer'));
    expect(platform.lookupPath('mysql', env)).toBeNull();
  });

  it('resolves a .CMD shim through PATHEXT', () => {
    // This is the whole point: npm, pnpm, yarn and bun install on Windows as
    // .cmd shims, so a PATH scan that ignored PATHEXT would report the entire
    // Node toolchain as missing and break every local build.
    // Written uppercase to match PATHEXT; NTFS is case-insensitive so this is
    // the real-world spelling, and it keeps the assertion exact on a
    // case-sensitive development filesystem.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'npm.CMD'), '@echo off\r\n');
    expect(platform.lookupPath('npm', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toBe(
      path.join(dir, 'npm.CMD'),
    );
  });

  it('falls back to the default extensions when PATHEXT is unset', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'php.EXE'), 'x');
    expect(platform.lookupPath('php', { PATH: dir })).toBe(path.join(dir, 'php.EXE'));
  });

  it('does not append an extension to a name that already has one', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'php.exe'), 'x');
    expect(platform.lookupPath('php.exe', { PATH: dir, PATHEXT: '.CMD' })).toBe(path.join(dir, 'php.exe'));
  });

  it('ignores the POSIX execute bit', () => {
    const dir = tempDir();
    const file = path.join(dir, 'php');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o644);
    expect(platform.lookupPath('php', { PATH: dir })).toBe(file);
  });

  it('keeps a PATH entry with spaces intact', () => {
    // A PATH entry containing spaces is quoted, and `;` may appear inside the
    // quoted segment — splitting naively would break the entry in two.
    const dir = path.join(tempDir(), 'Program Files', 'nodejs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'node.EXE'), 'x');
    const env = { PATH: `"${dir}"`, PATHEXT: '.EXE' };
    expect(platform.lookupPath('node', env)).toBe(path.join(dir, 'node.EXE'));
  });

  it('does not split on a semicolon inside a quoted entry', () => {
    const dir = path.join(tempDir(), 'weird;name');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'php'), 'x');
    expect(platform.lookupPath('php', { PATH: `"${dir}"` })).toBe(path.join(dir, 'php'));
  });

  it('matches environment variable names case-insensitively', () => {
    expect(platform.envValue({ Path: 'C:\\Windows' }, 'PATH')).toBe('C:\\Windows');
    expect(platform.envValue({ path: 'C:\\Windows' }, 'Path')).toBe('C:\\Windows');
  });

  it('prefers USERNAME over USER', () => {
    expect(platform.currentUser({ USERNAME: 'ada', USER: 'ignored' })).toBe('ada');
  });

  it('refuses to claim a chmod happened', () => {
    const file = path.join(tempDir(), 'id_ed25519');
    fs.writeFileSync(file, 'secret');
    const before = fs.statSync(file).mode & 0o777;
    expect(platform.restrictToOwner(file)).toBe(false);
    // NTFS ignores the mode bit, so the file is untouched — which is exactly
    // why the caller must not report this as a success.
    expect(fs.statSync(file).mode & 0o777).toBe(before);
  });
});

describe('Windows config directory', () => {
  it('uses %APPDATA%\\laravel-deploy', () => {
    const env = { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' };
    expect(paths.globalConfigDir(env)).toBe(path.join(env.APPDATA, 'laravel-deploy'));
  });

  it('beats XDG_CONFIG_HOME, which Windows does not use', () => {
    const env = { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', XDG_CONFIG_HOME: '/xdg' };
    expect(paths.globalConfigDir(env)).toBe(path.join(env.APPDATA, 'laravel-deploy'));
  });

  it('still knows the historical ~/.config location', () => {
    const env = { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' };
    expect(paths.legacyGlobalConfigDir(env)).toBe(path.join(os.homedir(), '.config', 'laravel-deploy'));
  });

  it('migrates an existing ~/.config directory on first run', () => {
    const appData = tempDir();
    const home = tempDir();
    const legacy = path.join(home, '.config', 'laravel-deploy');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), '{"version":1,"servers":{}}\n');
    fs.writeFileSync(path.join(legacy, 'secrets.json'), '{"version":1,"encrypted":false,"entries":{}}\n');

    const originalHome = os.homedir;
    // legacyGlobalConfigDir falls back to os.homedir(), which is not overridable
    // through the env object, so redirect the lookup for the duration.
    Object.defineProperty(os, 'homedir', { value: () => home, configurable: true });
    try {
      const env = { APPDATA: appData };
      const copied = paths.migrateLegacyConfigDir(env);
      expect(copied.sort()).toEqual(['config.json', 'secrets.json']);
      expect(fs.existsSync(path.join(paths.globalConfigDir(env), 'config.json'))).toBe(true);
      // The legacy copy stays put as a backup.
      expect(fs.existsSync(path.join(legacy, 'config.json'))).toBe(true);

      // And it is idempotent: a second run has nothing left to do.
      expect(paths.migrateLegacyConfigDir(env)).toEqual([]);
    } finally {
      Object.defineProperty(os, 'homedir', { value: originalHome, configurable: true });
    }
  });
});