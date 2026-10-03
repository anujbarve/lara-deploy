/**
 * Remote script tests.
 *
 * The shell scripts are the one layer the TypeScript tests do not execute, and
 * they are the layer that actually mutates the server. These tests run them for
 * real in a temp sandbox — no mocking — so a portability or quoting regression
 * cannot reach production.
 *
 * They have already caught two real bugs: `mv -T` being GNU-only (the atomic
 * switch silently never happened), and a post-switch check that compared a
 * fully-resolved path against an unresolved one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLayout } from '../src/core/release/layout.js';

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const LAYOUT = buildLayout({ root: '/www/wwwroot/example.com', strategy: 'public' });

let sandbox: string;
let root: string;

/** A minimal but complete Laravel release tree. */
function makeApp(dir: string): void {
  for (const sub of ['app', 'public', 'bootstrap', 'config', 'routes', 'vendor']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n');
  fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
  fs.writeFileSync(path.join(dir, 'bootstrap', 'app.php'), '<?php');
  fs.writeFileSync(path.join(dir, 'public', 'index.php'), '<?php');
  fs.writeFileSync(path.join(dir, 'vendor', 'autoload.php'), '<?php');
}

function run(script: string, env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  // spawnSync (not execFileSync) so stderr is captured even on a zero exit —
  // several guards warn on stderr while still succeeding.
  const result = spawnSync('bash', [path.join(SCRIPTS_DIR, script)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

/** Build a tar.gz the way the packager does: relative to the app root. */
function packRelease(appDir: string, archivePath: string): void {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  execFileSync('tar', ['-czf', archivePath, '-C', appDir, '.'], { stdio: 'ignore' });
}

function prepareRelease(releaseId: string, appDir = path.join(sandbox, 'app')): { status: number; stdout: string; stderr: string } {
  const archive = `${root}/.deploy/incoming/${releaseId}.tar.gz`;
  packRelease(appDir, archive);
  return run('prepare-release.sh', {
    LD_ROOT: root,
    LD_RELEASE: releaseId,
    LD_ARCHIVE: archive,
    LD_STRATEGY: 'public',
    LD_MAIN_DIR: 'main',
    LD_PHP: 'php',
  });
}

function activate(releaseId: string): { status: number; stdout: string; stderr: string } {
  return run('activate-release.sh', {
    LD_ROOT: root,
    LD_RELEASE: releaseId,
    LD_STRATEGY: 'public',
    LD_MAIN_DIR: 'main',
    LD_PHP: 'php',
  });
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-scripts-'));
  root = path.join(sandbox, 'site');
  fs.mkdirSync(root, { recursive: true });
  makeApp(path.join(sandbox, 'app'));
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('prepare-release.sh', () => {
  it('extracts a release into releases/<id> and links shared storage', () => {
    const result = prepareRelease('20261003-103210');
    expect(result.status).toBe(0);

    const release = path.join(root, 'releases', '20261003-103210');
    expect(fs.existsSync(path.join(release, 'artisan'))).toBe(true);
    expect(fs.existsSync(path.join(release, 'vendor', 'autoload.php'))).toBe(true);

    // storage is a symlink into shared storage, not a copied directory.
    const link = fs.readlinkSync(path.join(release, 'storage'));
    expect(link).toBe(`${root}/shared/storage`);
  });

  it('creates the shared storage skeleton', () => {
    prepareRelease('20261003-103210');
    for (const sub of ['app/public', 'framework/views', 'framework/sessions', 'logs']) {
      expect(fs.existsSync(path.join(root, 'shared', 'storage', sub))).toBe(true);
    }
  });

  it('refuses an archive that is not a Laravel app', () => {
    const archive = `${root}/.deploy/incoming/bad.tar.gz`;
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const empty = path.join(sandbox, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'hello');
    packRelease(empty, archive);

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artisan');
  });

  it('refuses a corrupt archive', () => {
    const archive = `${root}/.deploy/incoming/bad.tar.gz`;
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, 'this is not gzip');

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/corrupt|missing or empty/);
  });

  it('refuses a malformed release id so it cannot escape the releases dir', () => {
    const archive = `${root}/.deploy/incoming/x.tar.gz`;
    packRelease(path.join(sandbox, 'app'), archive);
    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      // A traversal attempt.
      LD_RELEASE: '../../etc/evil',
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('malformed release id');
  });

  it('is idempotent: re-preparing the same id replaces it cleanly', () => {
    prepareRelease('20261003-103210');
    const release = path.join(root, 'releases', '20261003-103210');
    fs.writeFileSync(path.join(release, 'leftover.txt'), 'x');

    const second = prepareRelease('20261003-103210');
    expect(second.status).toBe(0);
    expect(fs.existsSync(path.join(release, 'artisan'))).toBe(true);
    expect(fs.existsSync(path.join(release, 'leftover.txt'))).toBe(false);
  });
});

describe('activate-release.sh', () => {
  beforeEach(() => {
    prepareRelease('20261003-103210');
    fs.writeFileSync(path.join(root, 'shared', '.env'), 'APP_KEY=x\n');
  });

  it('switches current atomically and verifies the result', () => {
    const result = activate('20261003-103210');
    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(
      `${root}/releases/20261003-103210`,
    );
  });

  it('works even when the temp path is itself a symlink (macOS /tmp)', () => {
    // Regression: comparing readlink -f output against the raw target failed
    // on macOS, where /tmp resolves to /private/tmp.
    const result = activate('20261003-103210');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Active release');
  });

  it('switches between two releases and back again', () => {
    activate('20261003-103210');
    makeApp(path.join(sandbox, 'app2'));
    const prepared = prepareRelease('20261003-104000', path.join(sandbox, 'app2'));
    expect(prepared.status).toBe(0);

    const second = activate('20261003-104000');
    expect(second.status).toBe(0);
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(`${root}/releases/20261003-104000`);

    const back = activate('20261003-103210');
    expect(back.status).toBe(0);
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(`${root}/releases/20261003-103210`);
  });

  it('refuses to activate an incomplete release and leaves current alone', () => {
    activate('20261003-103210');
    const before = fs.readlinkSync(path.join(root, 'current'));

    fs.mkdirSync(path.join(root, 'releases', '20261003-999999'), { recursive: true });
    fs.writeFileSync(path.join(root, 'releases', '20261003-999999', 'artisan'), 'x');

    const result = activate('20261003-999999');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Incomplete release');
    // The live release is untouched.
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(before);
  });

  it('refuses to activate when the server .env is missing', () => {
    fs.rmSync(path.join(root, 'shared', '.env'));
    const result = activate('20261003-103210');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('.env');
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false);
  });

  it('refuses a malformed release id', () => {
    const result = activate('../../etc');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('malformed release id');
  });

  it('is a no-op in legacy mode, where there is no symlink', () => {
    const result = run('activate-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_STRATEGY: 'legacy-root-copy',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Legacy mode');
    expect(fs.existsSync(path.join(root, 'current'))).toBe(false);
  });
});

describe('cleanup.sh', () => {
  beforeEach(() => {
    prepareRelease('20261003-103210');
    fs.writeFileSync(path.join(root, 'shared', '.env'), 'APP_KEY=x\n');
    activate('20261003-103210');
  });

  it('removes the incoming archive', () => {
    const archive = `${root}/.deploy/incoming/20261003-103210.tar.gz`;
    expect(fs.existsSync(archive)).toBe(true);
    run('cleanup.sh', { LD_ROOT: root, LD_RELEASE: '20261003-103210' });
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('refuses to delete the currently active release', () => {
    // The release must be active for the guard to have anything to protect.
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(
      `${root}/releases/20261003-103210`,
    );
    const result = run('cleanup.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_REMOVE_RELEASE: '1',
    });
    expect(fs.existsSync(path.join(root, 'releases', '20261003-103210'))).toBe(true);
    expect(result.stderr).toContain('Refusing to delete the active release');
  });

  it('deletes an inactive release when asked', () => {
    makeApp(path.join(sandbox, 'app2'));
    prepareRelease('20261003-104000', path.join(sandbox, 'app2'));
    const result = run('cleanup.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-104000',
      LD_REMOVE_RELEASE: '1',
    });
    expect(fs.existsSync(path.join(root, 'releases', '20261003-104000'))).toBe(false);
    expect(result.stdout).toContain('removed release');
  });

  it('never touches shared storage', () => {
    fs.writeFileSync(path.join(root, 'shared', 'storage', 'app', 'public', 'upload.txt'), 'keep me');
    run('cleanup.sh', { LD_ROOT: root, LD_RELEASE: '20261003-103210', LD_REMOVE_RELEASE: '1' });
    expect(
      fs.existsSync(path.join(root, 'shared', 'storage', 'app', 'public', 'upload.txt')),
    ).toBe(true);
  });

  it('refuses a malformed release id', () => {
    const result = run('cleanup.sh', { LD_ROOT: root, LD_RELEASE: '../../etc', LD_REMOVE_RELEASE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('malformed release id');
  });
});

describe('script hygiene', () => {
  const scripts = ['prepare-release.sh', 'activate-release.sh', 'permissions.sh', 'health-check.sh', 'cleanup.sh'];

  it('every script exists and parses', () => {
    for (const script of scripts) {
      const file = path.join(SCRIPTS_DIR, script);
      expect(fs.existsSync(file)).toBe(true);
      expect(() => execFileSync('bash', ['-n', file], { stdio: 'ignore' })).not.toThrow();
    }
  });

  it('every script fails fast on an unset variable', () => {
    for (const script of scripts) {
      const contents = fs.readFileSync(path.join(SCRIPTS_DIR, script), 'utf8');
      expect(contents).toContain('set -Eeuo pipefail');
    }
  });

  it('permissions.sh never chmods 777 by default', () => {
    const lines = fs
      .readFileSync(path.join(SCRIPTS_DIR, 'permissions.sh'), 'utf8')
      .split('\n');
    const chmodLines = lines.filter((line) => /\bchmod\b/.test(line) && !line.trimStart().startsWith('#'));
    const wide = chmodLines.filter((line) => line.includes('777'));
    // The only 0777 is the explicit escape hatch, guarded two lines above it.
    expect(wide).toHaveLength(1);
    expect(wide[0]).toContain('0777');
    const index = lines.indexOf(wide[0] as string);
    expect(lines.slice(Math.max(0, index - 3), index).join('\n')).toContain('LD_CHMOD777');
    // The default path is 0775, never world-writable.
    expect(chmodLines.some((line) => line.includes('0775'))).toBe(true);
  });

  it('quotes every $LD_ROOT expansion so paths cannot word-split', () => {
    for (const script of scripts) {
      const lines = fs
        .readFileSync(path.join(SCRIPTS_DIR, script), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));
      for (const line of lines) {
        for (const match of line.matchAll(/\$LD_ROOT(?!\w)/g)) {
          const index = match.index ?? 0;
          const before = line.slice(0, index);
          // Safe if brace-expanded, or if we are already inside a quoted run.
          expect(before.endsWith('{') || before.includes('"')).toBe(true);
        }
      }
    }
  });
});

describe('layout paths match what the scripts expect', () => {
  it('the layout lock and manifest live under the site root', () => {
    expect(LAYOUT.lockFile.startsWith(LAYOUT.root)).toBe(true);
    expect(LAYOUT.incomingDir.startsWith(LAYOUT.root)).toBe(true);
    expect(LAYOUT.backupsDir.startsWith(LAYOUT.root)).toBe(true);
  });
});