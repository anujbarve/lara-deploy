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

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function packZip(appDir: string, archivePath: string): void {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  execFileSync('zip', ['-qr', archivePath, '.'], { cwd: appDir, stdio: 'ignore' });
}

/** Build a release archive in the given format and run the real script on it. */
function prepareRelease(
  releaseId: string,
  appDir = path.join(sandbox, 'app'),
  format: 'tar.gz' | 'zip' = 'tar.gz',
): { status: number; stdout: string; stderr: string } {
  const archive = `${root}/.deploy/incoming/${releaseId}.${format}`;
  if (format === 'zip') packZip(appDir, archive);
  else packRelease(appDir, archive);
  return run('prepare-release.sh', {
    LD_ROOT: root,
    LD_RELEASE: releaseId,
    LD_ARCHIVE: archive,
    LD_FORMAT: format,
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
describe('prepare-release.sh archive formats', () => {
  it.skipIf(!hasUnzip())('extracts a zip release exactly like a tar.gz one', () => {
    const result = prepareRelease('20261003-103210', path.join(sandbox, 'app'), 'zip');
    expect(result.status).toBe(0);

    const release = path.join(root, 'releases', '20261003-103210');
    expect(fs.existsSync(path.join(release, 'artisan'))).toBe(true);
    expect(fs.existsSync(path.join(release, 'vendor', 'autoload.php'))).toBe(true);
    expect(fs.existsSync(path.join(release, 'public', 'index.php'))).toBe(true);

    // The shared-storage symlink is created the same way regardless of format.
    expect(fs.readlinkSync(path.join(release, 'storage'))).toBe(`${root}/shared/storage`);
  });

  it.skipIf(!hasUnzip())('creates the shared storage skeleton from a zip', () => {
    prepareRelease('20261003-103210', path.join(sandbox, 'app'), 'zip');
    for (const sub of ['app/public', 'framework/views', 'framework/sessions', 'logs']) {
      expect(fs.existsSync(path.join(root, 'shared', 'storage', sub))).toBe(true);
    }
  });

  it.skipIf(!hasUnzip())('refuses a zip that is not a Laravel app', () => {
    const archive = `${root}/.deploy/incoming/bad.zip`;
    const empty = path.join(sandbox, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'hello');
    packZip(empty, archive);

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_FORMAT: 'zip',
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('artisan');
  });

  it.skipIf(!hasUnzip())('refuses a corrupt zip rather than extracting it', () => {
    const archive = `${root}/.deploy/incoming/bad.zip`;
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, 'this is not a zip');

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_FORMAT: 'zip',
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/corrupt|missing or empty/);
    expect(fs.existsSync(path.join(root, 'releases', '20261003-103210'))).toBe(false);
  });

  it('rejects an unknown format before touching the archive', () => {
    // tar would otherwise report a perfectly good zip as "corrupt", which sends
    // the operator looking at the upload instead of at their config.
    const archive = `${root}/.deploy/incoming/x.7z`;
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    packRelease(path.join(sandbox, 'app'), archive);

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_FORMAT: '7z',
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported LD_FORMAT');
  });

  it('rejects a tarball announced as a zip instead of extracting it', () => {
    // Exactly the failure the format plumbing existed to prevent: a valid tar.gz
    // at a .zip path. tar -tzf would have accepted it; unzip must not.
    const archive = `${root}/.deploy/incoming/mislabelled.zip`;
    packRelease(path.join(sandbox, 'app'), archive);

    const result = run('prepare-release.sh', {
      LD_ROOT: root,
      LD_RELEASE: '20261003-103210',
      LD_ARCHIVE: archive,
      LD_FORMAT: 'zip',
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/corrupt|missing or empty/);
  });
});

/**
 * Release-id validation.
 *
 * Every deployment from a git repository produces `<stamp>-<sha7>`, because
 * buildReleaseId() appends the short SHA. All three release scripts validate
 * LD_RELEASE against a fixed shape — and that shape omitted the suffix, so every
 * git deployment was rejected at prepare time, after the build and the upload.
 *
 * The existing suite never caught it because every fixture used the no-SHA id.
 * These cases use the real shape the CLI emits.
 */
describe('cleanup.sh archive format', () => {
  const RID = '20261003-103210';

  it.skipIf(!hasUnzip())('removes a zip archive instead of a non-existent tar.gz', () => {
    prepareRelease(RID, path.join(sandbox, 'app'), 'zip');
    const archive = path.join(root, '.deploy', 'incoming', `${RID}.zip`);
    expect(fs.existsSync(archive)).toBe(true);

    const result = run('cleanup.sh', { LD_ROOT: root, LD_RELEASE: RID, LD_FORMAT: 'zip' });
    expect(result.status).toBe(0);
    // Hardcoding .tar.gz here would leave every zip release on disk forever.
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('still removes a tar.gz archive by default', () => {
    prepareRelease(RID, path.join(sandbox, 'app'), 'tar.gz');
    const archive = path.join(root, '.deploy', 'incoming', `${RID}.tar.gz`);
    expect(fs.existsSync(archive)).toBe(true);

    const result = run('cleanup.sh', { LD_ROOT: root, LD_RELEASE: RID });
    expect(result.status).toBe(0);
    expect(fs.existsSync(archive)).toBe(false);
  });
});

describe('release id validation', () => {
  const GIT_ID = '20261003-103210-a1b2c3d';
  const PLAIN_ID = '20261003-103210';

  const scripts = ['prepare-release.sh', 'activate-release.sh', 'cleanup.sh'];

  it.each(scripts)('%s accepts the git release id the CLI produces', (script) => {
    const archive = `${root}/.deploy/incoming/${GIT_ID}.tar.gz`;
    packRelease(path.join(sandbox, 'app'), archive);

    const result = run(script, {
      LD_ROOT: root,
      LD_RELEASE: GIT_ID,
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
      LD_PHP: 'php',
    });

    // A rejection of the id itself is the failure mode being guarded against;
    // prepare-release legitimately has nothing to activate afterwards.
    expect(result.stderr).not.toContain('malformed release id');
    expect(result.status).not.toBe(2);
  });

  it.each(scripts)('%s still accepts the no-SHA release id', (script) => {
    const archive = `${root}/.deploy/incoming/${PLAIN_ID}.tar.gz`;
    packRelease(path.join(sandbox, 'app'), archive);

    const result = run(script, {
      LD_ROOT: root,
      LD_RELEASE: PLAIN_ID,
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
      LD_PHP: 'php',
    });
    expect(result.stderr).not.toContain('malformed release id');
    expect(result.status).not.toBe(2);
  });

  it.each(scripts)('%s rejects a traversal id that merely looks git-shaped', (script) => {
    const archive = `${root}/.deploy/incoming/evil.tar.gz`;
    packRelease(path.join(sandbox, 'app'), archive);

    const result = run(script, {
      LD_ROOT: root,
      // Valid prefix, but the suffix carries a path separator.
      LD_RELEASE: `${PLAIN_ID}-../../etc/evil`,
      LD_ARCHIVE: archive,
      LD_STRATEGY: 'public',
      LD_MAIN_DIR: 'main',
      LD_PHP: 'php',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('malformed release id');
  });

  it('prepares and then activates a full git-shaped release', () => {
    // The end-to-end shape of a real deployment from a repository.
    const prepared = prepareRelease(GIT_ID, path.join(sandbox, 'app'), 'tar.gz');
    expect(prepared.status).toBe(0);
    expect(fs.existsSync(path.join(root, 'releases', GIT_ID, 'artisan'))).toBe(true);

    // activate refuses to switch without a server .env, by design.
    fs.writeFileSync(path.join(root, 'shared', '.env'), 'APP_KEY=x\n');
    const activated = activate(GIT_ID);
    expect(activated.status).toBe(0);
    expect(fs.readlinkSync(path.join(root, 'current')).endsWith(GIT_ID)).toBe(true);
  });
});
