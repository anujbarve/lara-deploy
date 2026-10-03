import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateAppConfig,
  stripJsonComments,
  formatConfigIssues,
  loadProjectConfig,
} from '../src/core/config/loader.js';
import { ConfigValidationError, ConfigError } from '../src/core/errors/errors.js';
import { cleanupFixture, makeLaravelFixture, appConfigFixture } from './helpers.js';

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupFixture(created.pop() as string);
});

describe('config validation', () => {
  it('accepts a minimal config and applies defaults', () => {
    const config = validateAppConfig(appConfigFixture());
    expect(config.site.documentRootStrategy).toBe('public');
    expect(config.deployment.keepReleases).toBe(5);
    expect(config.deployment.seeders).toBe(false);
    expect(config.env.strategy).toBe('preserve');
    expect(config.database.driver).toBe('mysql');
    expect(config.ssl.enabled).toBe(false);
  });

  it('rejects a missing server', () => {
    expect(() => validateAppConfig({ site: { domain: 'example.com' } })).toThrow(ConfigValidationError);
  });

  it('rejects an invalid hostname with a field-level message', () => {
    try {
      validateAppConfig({ server: 'a', site: { domain: 'not a host' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as ConfigValidationError).issues;
      const domainIssue = issues.find((issue) => issue.path === 'site.domain');
      expect(domainIssue?.message).toBe('invalid hostname');
    }
  });

  it('rejects keepReleases below 1', () => {
    try {
      validateAppConfig(appConfigFixture({ deployment: { keepReleases: 0 } }));
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as ConfigValidationError).issues;
      expect(issues.some((i) => i.path === 'deployment.keepReleases')).toBe(true);
    }
  });

  it('rejects a relative or traversing site root', () => {
    expect(() =>
      validateAppConfig(appConfigFixture({ site: { domain: 'example.com', root: 'relative/path' } })),
    ).toThrow(ConfigValidationError);
    expect(() =>
      validateAppConfig(appConfigFixture({ site: { domain: 'example.com', root: '/www/../../etc' } })),
    ).toThrow(ConfigValidationError);
  });

  it('requires templatePath when env.strategy is template', () => {
    expect(() =>
      validateAppConfig(appConfigFixture({ env: { strategy: 'template' } })),
    ).toThrow(ConfigValidationError);
  });

  it('requires uploadPath when env.strategy is upload', () => {
    expect(() => validateAppConfig(appConfigFixture({ env: { strategy: 'upload' } }))).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects ssl.provider=none while ssl.enabled is true', () => {
    expect(() =>
      validateAppConfig(appConfigFixture({ ssl: { enabled: true, provider: 'none' } })),
    ).toThrow(ConfigValidationError);
  });

  it('never exposes raw Zod internals in the message', () => {
    try {
      validateAppConfig({ server: '', site: { domain: '' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toBe('Invalid deployment configuration.');
      expect(message).not.toContain('ZodError');
      expect(message).not.toContain('invalid_type');
      expect((error as ConfigValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it('formats issues as dotted paths', () => {
    expect(formatConfigIssues([{ path: 'site.domain', message: 'invalid hostname' }])).toBe(
      '  site.domain: invalid hostname',
    );
  });
});

describe('config file parsing', () => {
  it('strips line and block comments but keeps # inside strings', () => {
    const input = `{
      // a comment
      "server": "prod", /* block */
      "site": { "domain": "example.com#anchor" }
    }`;
    const parsed = JSON.parse(stripJsonComments(input)) as { server: string; site: { domain: string } };
    expect(parsed.server).toBe('prod');
    expect(parsed.site.domain).toBe('example.com#anchor');
  });

  it('reports invalid JSON with the file path', () => {
    const root = makeLaravelFixture();
    created.push(root);
    fs.writeFileSync(path.join(root, '.laravel-deploy.json'), '{ "server": }');
    expect(() => loadProjectConfig({ cwd: root, required: true })).toThrow(/not valid JSON/);
  });

  it('accepts site.domains[0] as an alias for site.domain', () => {
    const config = validateAppConfig({
      server: 'prod',
      site: { domains: ['example.com'] },
    });
    expect(config.site.domain).toBe('example.com');
  });

  it('layers an environment file over the base file', () => {
    const root = makeLaravelFixture();
    created.push(root);
    fs.writeFileSync(
      path.join(root, '.laravel-deploy.json'),
      JSON.stringify({ server: 'prod', site: { domain: 'example.com' }, deployment: { keepReleases: 3 } }),
    );
    fs.writeFileSync(
      path.join(root, '.laravel-deploy.staging.json'),
      JSON.stringify({ deployment: { keepReleases: 2 } }),
    );

    const staging = loadProjectConfig({ cwd: root, env: 'staging', required: true });
    expect(staging.config.deployment.keepReleases).toBe(2);
    // Base values survive the overlay.
    expect(staging.config.site.domain).toBe('example.com');

    const production = loadProjectConfig({ cwd: root, required: true });
    expect(production.config.deployment.keepReleases).toBe(3);
  });

  it('throws an actionable error when no config exists', () => {
    const root = makeLaravelFixture();
    created.push(root);
    expect(() => loadProjectConfig({ cwd: root, required: true })).toThrow(ConfigError);
    try {
      loadProjectConfig({ cwd: root, required: true });
    } catch (error) {
      expect((error as ConfigError).remediation.join(' ')).toContain('init');
    }
  });
});