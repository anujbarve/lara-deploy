import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isExcluded, resolveExclusions, Packager, DEFAULT_EXCLUDES } from '../src/packaging/packager.js';

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
      tempDir: root,
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
});