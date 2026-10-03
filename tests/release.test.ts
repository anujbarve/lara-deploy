import { describe, it, expect } from 'vitest';
import { buildReleaseId, buildDeploymentId, releaseStamp, formatBytes, formatDuration, generatePassword } from '../src/utils/ids.js';
import { buildLayout, legacyIndexPhp, releasePath, incomingArchivePath } from '../src/core/release/layout.js';
import { planRetention } from '../src/core/release/retention.js';
import { legacyPreservedEntries, LEGACY_PUBLIC_ENTRIES } from '../src/core/release/layout.js';

describe('release naming', () => {
  it('formats a UTC release stamp as YYYYMMDD-HHMMSS', () => {
    expect(releaseStamp(new Date('2026-10-03T10:32:10Z'))).toBe('20261003-103210');
  });

  it('appends the git sha when present', () => {
    expect(buildReleaseId('20261003-103210', 'a1b2c3d4e5f')).toBe('20261003-103210-a1b2c3d');
    expect(buildReleaseId('20261003-103210', null)).toBe('20261003-103210');
  });

  it('truncates the sha to seven characters', () => {
    expect(buildReleaseId('20261003-103210', 'a1b2c3d4e5f6g7h8')).toBe('20261003-103210-a1b2c3d');
  });

  it('builds a deployment id', () => {
    expect(buildDeploymentId('20261003-103210', 'a1b2')).toBe('DEPLOY-20261003-103210-A1B2');
  });
});

describe('formatting', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(38.4 * 1024 * 1024)).toBe('38.4 MB');
  });

  it('formats durations', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(134_000)).toBe('2m 14s');
    expect(formatDuration(7_500_000)).toBe('2h 5m 0s');
  });

  it('generates passwords of the requested length from a broad alphabet', () => {
    const password = generatePassword(28);
    expect(password).toHaveLength(28);
    expect(new Set(password).size).toBeGreaterThan(10);
  });
});

describe('site layout', () => {
  it('builds the modern release layout', () => {
    const layout = buildLayout({ root: '/www/wwwroot/example.com', strategy: 'public' });
    expect(layout.appDir).toBe('/www/wwwroot/example.com/current');
    expect(layout.documentRoot).toBe('/www/wwwroot/example.com/current/public');
    expect(layout.releasesDir).toBe('/www/wwwroot/example.com/releases');
    expect(layout.sharedStorageDir).toBe('/www/wwwroot/example.com/shared/storage');
    expect(layout.envPath).toBe('/www/wwwroot/example.com/shared/.env');
    expect(layout.lockFile).toBe('/www/wwwroot/example.com/.deploy/deployment.lock');
  });

  it('normalises a trailing slash on the root', () => {
    const layout = buildLayout({ root: '/www/wwwroot/example.com/', strategy: 'public' });
    expect(layout.root).toBe('/www/wwwroot/example.com');
    expect(layout.releasesDir).toBe('/www/wwwroot/example.com/releases');
  });

  it('builds the legacy layout', () => {
    const layout = buildLayout({
      root: '/www/wwwroot/example.com',
      strategy: 'legacy-root-copy',
      legacyMainDir: 'main',
    });
    expect(layout.appDir).toBe('/www/wwwroot/example.com/main');
    expect(layout.documentRoot).toBe('/www/wwwroot/example.com');
    expect(layout.legacyPublicTarget).toBe('/www/wwwroot/example.com');
  });

  it('rejects a traversing root', () => {
    expect(() => buildLayout({ root: '/www/../etc', strategy: 'public' })).toThrow(/traversal/);
  });

  it('derives release and archive paths', () => {
    const layout = buildLayout({ root: '/www/wwwroot/example.com', strategy: 'public' });
    expect(releasePath(layout, '20261003-101500')).toBe(
      '/www/wwwroot/example.com/releases/20261003-101500',
    );
    expect(incomingArchivePath(layout, '20261003-101500')).toBe(
      '/www/wwwroot/example.com/.deploy/incoming/20261003-101500.tar.gz',
    );
  });
});

describe('legacy index.php generation', () => {
  it('points at main/vendor and main/bootstrap', () => {
    const php = legacyIndexPhp({ mainDir: 'main' });
    expect(php).toContain("require main/vendor/autoload.php");
    expect(php).toContain("require_once main/bootstrap/app.php");
    expect(php).toContain('laravel-deploy');
    expect(php).toContain('$app->handleRequest');
  });

  it('handles a nested public prefix', () => {
    const php = legacyIndexPhp({ mainDir: 'main', prefix: '/sub/dir' });
    expect(php).toContain("require sub/dir/main/vendor/autoload.php");
  });

  it('preserves root files that must never be clobbered', () => {
    const preserved = legacyPreservedEntries(['custom.conf']);
    expect(preserved).toContain('.user.ini');
    expect(preserved).toContain('index.php');
    expect(preserved).toContain('custom.conf');
    expect(preserved).not.toContain('assets');
  });

  it('knows which public entries are copied in legacy mode', () => {
    expect(LEGACY_PUBLIC_ENTRIES).toContain('build');
    expect(LEGACY_PUBLIC_ENTRIES).toContain('assets');
  });
});

describe('release retention', () => {
  const releases = [
    '20260930-091200',
    '20261002-180300',
    '20261003-101500',
    '20261003-102500',
    '20261003-103500',
    '20261003-104500',
  ];

  it('never deletes the current release', () => {
    const plan = planRetention({
      releases,
      currentRelease: '20261003-104500',
      keepReleases: 2,
    });
    expect(plan.delete).not.toContain('20261003-104500');
    expect(plan.keep).toContain('20261003-104500');
  });

  it('always keeps the previous release for rollback', () => {
    const plan = planRetention({
      releases,
      currentRelease: '20261003-104500',
      keepReleases: 1,
    });
    expect(plan.keep).toContain('20261003-103500');
    expect(plan.delete).not.toContain('20261003-103500');
  });

  it('deletes the oldest releases beyond the retention count', () => {
    const plan = planRetention({
      releases,
      currentRelease: '20261003-104500',
      keepReleases: 3,
    });
    expect(plan.keep).toHaveLength(3);
    expect(plan.delete).toHaveLength(3);
    expect(plan.delete).toContain('20260930-091200');
  });

  it('keeps at least the current release when there is only one', () => {
    const plan = planRetention({ releases: ['20261003-101500'], currentRelease: '20261003-101500', keepReleases: 5 });
    expect(plan.delete).toHaveLength(0);
  });

  it('deletes everything stale when there is no current release', () => {
    const plan = planRetention({ releases, currentRelease: null, keepReleases: 2 });
    expect(plan.keep).toHaveLength(2);
    expect(plan.keep[0]).toBe('20261003-104500');
  });

  it('always keeps at least one release', () => {
    const plan = planRetention({ releases, currentRelease: null, keepReleases: 0 });
    expect(plan.keep.length).toBeGreaterThanOrEqual(1);
  });
});