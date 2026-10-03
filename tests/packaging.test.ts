import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isExcluded, resolveExclusions, Packager, DEFAULT_EXCLUDES } from '../src/packaging/packager.js';

/** Some assertions read the archive back with a real tool; skip when absent. */
function hasUnzip(): boolean {
  try {
    return execFileSync('unzip', ['-v'], { stdio: 'ignore' }) !== undefined || true;
  } catch {
    return false;
  }
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

function patterns(extra: string[] = [], include: string[] = []) {
  return resolveExclusions({ exclude: extra, include, format: 'tar.gz', level: 6 });
}

describe('archive exclusions', () => {
  it('excludes VCS metadata and dependencies', () => {
    const p = patterns();
    expect(isExcluded('.git', p)).toBe(true);
    expect(isExcluded('.git/config', p)).toBe(true);
    expect(isExcluded('node_modules', p)).toBe(true);
    expect(isExcluded('node_modules/vue/index.js', p)).toBe(true);
  });

  it('excludes every flavour of .env', () => {
    const p = patterns();
    expect(isExcluded('.env', p)).toBe(true);
    expect(isExcluded('.env.production', p)).toBe(true);
    expect(isExcluded('.env.staging', p)).toBe(true);
  });

  it('keeps .env.example', () => {
    expect(DEFAULT_EXCLUDES).toContain('!.env.example');
    expect(isExcluded('.env.example', patterns())).toBe(false);
    expect(isExcluded('.env.production', patterns())).toBe(true);
  });

  it('excludes generated storage contents', () => {
    const p = patterns();
    expect(isExcluded('storage/logs/laravel.log', p)).toBe(true);
    expect(isExcluded('storage/framework/views/abc.php', p)).toBe(true);
    expect(isExcluded('storage/framework/sessions/x', p)).toBe(true);
  });

  it('does NOT exclude vendor, public/build or lockfiles', () => {
    const p = patterns();
    expect(isExcluded('vendor', p)).toBe(false);
    expect(isExcluded('vendor/autoload.php', p)).toBe(false);
    expect(isExcluded('public/build', p)).toBe(false);
    expect(isExcluded('public/build/manifest.json', p)).toBe(false);
    expect(isExcluded('composer.lock', p)).toBe(false);
    expect(isExcluded('package-lock.json', p)).toBe(false);
    expect(isExcluded('pnpm-lock.yaml', p)).toBe(false);
  });

  it('ships application code', () => {
    const p = patterns();
    expect(isExcluded('app/Models/User.php', p)).toBe(false);
    expect(isExcluded('artisan', p)).toBe(false);
    expect(isExcluded('public/index.php', p)).toBe(false);
    expect(isExcluded('bootstrap/app.php', p)).toBe(false);
  });

  it('honours additional user exclusions', () => {
    const p = patterns(['docs/**', '*.md']);
    expect(isExcluded('docs/index.md', p)).toBe(true);
    expect(isExcluded('README.md', p)).toBe(true);
  });

  it('lets an explicit include override a default exclusion', () => {
    const p = patterns([], ['storage/logs/**']);
    expect(isExcluded('storage/logs/laravel.log', p)).toBe(false);
    // The override is narrow: sibling paths stay excluded.
    expect(isExcluded('storage/framework/views/x.php', p)).toBe(true);
  });

  it('excludes the tests directory by default', () => {
    expect(isExcluded('tests/Feature/ExampleTest.php', patterns())).toBe(true);
  });
});

describe('packager', () => {
  it('creates a tar.gz containing the app but not .env', async () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pack-'));
    created.push(root);
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artisan'), 'x');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'app', 'User.php'), 'x');
    fs.writeFileSync(path.join(root, 'node_modules', 'big.js'), 'x');
    fs.writeFileSync(path.join(root, 'composer.lock'), '{}');

    const packager = new Packager({
      projectRoot: root,
      config: { exclude: [], include: [], format: 'tar.gz', level: 1 },
      tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'packout-')),
    });

    const result = await packager.create('20261003-101500');
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.format).toBe('tar.gz');

    // Read the archive back with tar to assert on the entries.
    const { execa } = await import('execa');
    const listing = await execa('tar', ['-tzf', result.archivePath]);
    const entries = listing.stdout.split('\n');
    expect(entries.some((e) => e.endsWith('artisan'))).toBe(true);
    expect(entries.some((e) => e.includes('app/User.php'))).toBe(true);
    expect(entries.some((e) => e.includes('composer.lock'))).toBe(true);
    expect(entries.some((e) => e.endsWith('.env'))).toBe(false);
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false);
  });

  it('removes a stale archive before writing a new one', async () => {
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pack-'));
    created.push(root);
    fs.writeFileSync(path.join(root, 'artisan'), 'x');
    const tempDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'packout-'));
    created.push(tempDir);

    const packager = new Packager({
      projectRoot: root,
      config: { exclude: [], include: [], format: 'tar.gz', level: 1 },
      tempDir,
    });

    const first = await packager.create('20261003-101500');
    // Overwrite the archive with garbage; the packager must not append to it.
    fs.writeFileSync(first.archivePath, 'GARBAGE'.repeat(5000));
    const second = await packager.create('20261003-101500');
    expect(second.bytes).toBeGreaterThan(0);

    const { execa } = await import('execa');
    const listing = await execa('tar', ['-tzf', second.archivePath]);
    expect(listing.stdout).toContain('artisan');
  });

  it('never archives the file it is writing, even when tempDir is inside the project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
    created.push(root);
    fs.writeFileSync(path.join(root, 'artisan'), 'x');
    fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(512 * 1024, 7));

    // A nested tempDir guarantees the walker sees the archive file: the mkdir
    // happens before the walk, and the write stream has opened by the time the
    // walker descends. Packaging it once was the intermittent "Size mismatch"
    // flake — the entry grows between tar-stream's stat and its read.
    const tempDir = path.join(root, 'build-output');
    const result = await new Packager({
      projectRoot: root,
      config: { exclude: [], include: [], format: 'tar.gz', level: 1 },
      tempDir,
    }).create('20261003-101500');

    expect(result.fileCount).toBe(2);

    const { execa } = await import('execa');
    const entries = (await execa('tar', ['-tzf', result.archivePath])).stdout.split('\n');
    expect(entries.some((e) => e.includes('20261003-101500.tar.gz'))).toBe(false);
    expect(entries.some((e) => e.includes('artisan'))).toBe(true);
    expect(entries.some((e) => e.includes('big.bin'))).toBe(true);
  });
});
/**
 * The archive format must match the bytes on disk.
 *
 * `prepare-release.sh` picks tar or unzip from the format the CLI reports, and
 * the orchestrator names the remote file after it, so a mismatch does not fail
 * at package time — it fails on the server, after the build and the upload.
 */
describe('archive format', () => {
  function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-'));
    created.push(root);
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'vendor', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artisan'), '#!/usr/bin/env php', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'app', 'User.php'), '<?php');
    fs.writeFileSync(path.join(root, 'vendor', 'bin', 'phpstan'), '#!/usr/bin/env php', { mode: 0o755 });
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    return root;
  }

  function pack(root: string, format: 'tar.gz' | 'zip') {
    return new Packager({
      projectRoot: root,
      config: { exclude: [], include: [], format, level: 1 },
      tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fmtout-')),
    }).create('20261003-101500');
  }

  it('writes real gzip bytes for tar.gz, with a .tar.gz name', async () => {
    const result = await pack(fixture(), 'tar.gz');
    expect(result.format).toBe('tar.gz');
    expect(result.archivePath.endsWith('.tar.gz')).toBe(true);

    const head = fs.readFileSync(result.archivePath).subarray(0, 2);
    expect([...head]).toEqual([0x1f, 0x8b]);
  });

  it('writes real zip bytes for zip, with a .zip name', async () => {
    const result = await pack(fixture(), 'zip');
    expect(result.format).toBe('zip');
    expect(result.archivePath.endsWith('.zip')).toBe(true);

    // 'PK\3\4' — the local file header of a real zip, not a renamed tarball.
    const head = fs.readFileSync(result.archivePath).subarray(0, 4);
    expect([...head]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it.skipIf(!hasUnzip())('produces a zip that unzip can list, with the same entries as tar', async () => {
    const { execa } = await import('execa');

    const root = fixture();
    const tar = await pack(root, 'tar.gz');
    const zip = await pack(root, 'zip');

    const tarEntries = (await execa('tar', ['-tzf', tar.archivePath])).stdout.split('\n').sort();
    const zipEntries = (await execa('unzip', ['-Z1', zip.archivePath])).stdout.split('\n').sort();

    for (const entry of ['artisan', 'app/User.php', 'vendor/bin/phpstan']) {
      expect(tarEntries.some((e) => e.replace(/^\.\//, '').endsWith(entry))).toBe(true);
      expect(zipEntries.some((e) => e.replace(/^\.\//, '').endsWith(entry))).toBe(true);
    }
    // The exclusion rules apply identically regardless of format.
    expect(zipEntries.some((e) => e.endsWith('.env'))).toBe(false);
  });

  it.skipIf(!hasUnzip())('preserves the executable bit in both formats', async () => {
    const { execa } = await import('execa');
    const root = fixture();

    const tar = await pack(root, 'tar.gz');
    const tarListing = await execa('tar', ['-tzvf', tar.archivePath]);
    expect(tarListing.stdout).toMatch(/artisan/);

    const zip = await pack(root, 'zip');
    // zip -Z shows the unix mode; a stripped executable bit breaks vendor/bin.
    const zipListing = await execa('unzip', ['-Z', zip.archivePath]);
    const artisanLine = zipListing.stdout.split('\n').find((l) => l.includes('artisan')) as string;
    expect(artisanLine).toBeDefined();
    expect(artisanLine).toMatch(/^-rwxr-xr-x|rwxr-xr-x/);
  });

  it('stores a symlink under its own path, pointing at its target', async () => {
    const { execa } = await import('execa');
    const root = fixture();
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.symlinkSync('shared', path.join(root, 'linked'));

    const tar = await pack(root, 'tar.gz');
    const listing = await execa('tar', ['-tzvf', tar.archivePath]);
    const line = listing.stdout.split('\n').find((l) => l.includes('linked')) as string;

    // Argument order is (entry path, link target). Getting this backwards puts an
    // entry named after the target, so `linked` would never appear.
    expect(line).toMatch(/ linked -> shared$/);
  });
});
