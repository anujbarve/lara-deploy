import { describe, it, expect, afterEach } from 'vitest';
import {
  inspectProject,
  detectPackageManager,
  looksLikeLaravel,
  slugify,
  readEnvFile,
} from '../src/laravel/detector.js';
import { compareVersions, parseVersionConstraint, parsePhpVersion } from '../src/utils/versions.js';
import { makeLaravelFixture, cleanupFixture } from './helpers.js';

const created: string[] = [];
function fixture(options: Parameters<typeof makeLaravelFixture>[0] = {}): string {
  const root = makeLaravelFixture(options);
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) cleanupFixture(created.pop() as string);
});

describe('Laravel project detection', () => {
  it('recognises a Laravel project by its standard files', () => {
    const root = fixture();
    expect(looksLikeLaravel(root)).toBe(true);
  });

  it('rejects a directory without artisan', () => {
    const root = fixture();
    require('node:fs').rmSync(`${root}/artisan`);
    expect(looksLikeLaravel(root)).toBe(false);
  });

  it('reads the Laravel version from composer.json', () => {
    const project = inspectProject(fixture({ laravel: '^11.0' }));
    expect(project.isLaravel).toBe(true);
    expect(project.laravelMajor).toBe(11);
    expect(project.laravelRequirement).toBe('^11.0');
  });

  it('reads the PHP requirement from composer.json', () => {
    const project = inspectProject(fixture({ php: '^8.3' }));
    expect(project.phpRequirement).toBe('^8.3');
  });

  it('detects the /up health endpoint only for Laravel 11+', () => {
    expect(inspectProject(fixture({ laravel: '^11.0' })).hasHealthEndpoint).toBe(true);
    expect(inspectProject(fixture({ laravel: '^10.0' })).hasHealthEndpoint).toBe(false);
  });

  it('detects migrations and seeders on disk', () => {
    const withBoth = inspectProject(fixture({ withMigrations: true, withSeeders: true }));
    expect(withBoth.hasMigrations).toBe(true);
    expect(withBoth.hasSeeders).toBe(true);

    const bare = inspectProject(fixture({ withMigrations: false, withSeeders: false }));
    expect(bare.hasMigrations).toBe(false);
    expect(bare.hasSeeders).toBe(false);
  });

  it('detects the queue connection from .env.example', () => {
    const project = inspectProject(fixture());
    expect(project.queueConnection).toBe('database');
    expect(project.hints.queue).toBe(true);
  });

  it('does not assume npm', () => {
    expect(detectPackageManager(fixture({ lockfile: 'package-lock.json' }))).toBe('npm');
    expect(detectPackageManager(fixture({ lockfile: 'pnpm-lock.yaml' }))).toBe('pnpm');
    expect(detectPackageManager(fixture({ lockfile: 'yarn.lock' }))).toBe('yarn');
    expect(detectPackageManager(fixture({ lockfile: 'bun.lock' }))).toBe('bun');
  });

  it('prefers bun over the other lockfiles when several are present', () => {
    const root = fixture({ lockfile: 'yarn.lock' });
    require('node:fs').writeFileSync(`${root}/bun.lock`, '');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('returns null when there is no package.json at all', () => {
    const root = fixture({ withPackageJson: false });
    expect(detectPackageManager(root)).toBe(null);
  });

  it('parses .env.example without evaluating anything', () => {
    const root = fixture({ dotEnvExample: 'APP_KEY=\nDB_PASSWORD="quoted value"\n# comment\nexport FOO=bar' });
    const env = readEnvFile(`${root}/.env.example`);
    expect(env?.APP_KEY).toBe('');
    expect(env?.DB_PASSWORD).toBe('quoted value');
    expect(env?.FOO).toBe('bar');
  });

  it('derives the project name from composer.json', () => {
    expect(inspectProject(fixture()).name).toBe('client-site');
  });

  it('slugifies names for use as database identifiers', () => {
    expect(slugify('Client Site')).toBe('client_site');
    expect(slugify('  acme/client_site  ')).toBe('acme_client_site');
    expect(slugify('---')).toBe('');
  });
});

describe('version handling', () => {
  it('extracts major.minor from a composer constraint', () => {
    expect(parseVersionConstraint('^8.3')).toBe('8.3');
    expect(parseVersionConstraint('>=8.1')).toBe('8.1');
    expect(parseVersionConstraint('^11.0 || ^12.0')).toBe('11.0');
  });

  it('compares dotted versions', () => {
    expect(compareVersions('8.3', '8.2')).toBeGreaterThan(0);
    expect(compareVersions('8.2', '8.3')).toBeLessThan(0);
    expect(compareVersions('8.2.10', '8.2.9')).toBeGreaterThan(0);
    expect(compareVersions('8.2', '8.2.0')).toBe(0);
  });

  it('parses the PHP version out of `php -v` output', () => {
    expect(parsePhpVersion('PHP 8.3.12 (cli)')).toBe('8.3.12');
    expect(parsePhpVersion('not php at all')).toBe(null);
  });
});