import { describe, it, expect } from 'vitest';
import {
  HealthChecker,
  checkHttp,
  aggregate,
  parseKeyValues,
  healthChecksEnabled,
  type CheckResult,
} from '../src/core/health/checker.js';
import { healthCheckConfigSchema } from '../src/core/config/schema.js';
import { buildLayout } from '../src/core/release/layout.js';
import { verifySymlink, planStorageLayout, requiredReleasePaths } from '../src/laravel/storage.js';
import { evaluateWorkers, parseSupervisorStatus } from '../src/laravel/workers.js';
import { buildPlan, renderPlan } from '../src/core/deployment/plan.js';
import { validateAppConfig } from '../src/core/config/loader.js';
import { serverProfileSchema } from '../src/core/config/schema.js';
import type { ProjectInfo } from '../src/laravel/detector.js';
import { FakeExecutor } from './helpers.js';

const layout = buildLayout({ root: '/www/wwwroot/example.com', strategy: 'public' });

describe('HTTP health check', () => {
  const okResponse = (status = 200) => new Response('ok', { status });

  it('passes on an accepted status', async () => {
    const result = await checkHttp({
      url: 'https://example.com',
      expectStatus: [200],
      timeoutMs: 1000,
      attempts: 1,
      retryDelayMs: 0,
      fetchImpl: (async () => okResponse(200)) as unknown as typeof fetch,
    });
    expect(result.status).toBe('pass');
  });

  it('accepts a redirect when configured', async () => {
    const result = await checkHttp({
      url: 'https://example.com',
      expectStatus: [301, 302],
      timeoutMs: 1000,
      attempts: 1,
      retryDelayMs: 0,
      fetchImpl: (async () => okResponse(301)) as unknown as typeof fetch,
    });
    expect(result.status).toBe('pass');
  });

  it('fails on an unexpected status, after retries', async () => {
    let calls = 0;
    const result = await checkHttp({
      url: 'https://example.com',
      expectStatus: [200],
      timeoutMs: 1000,
      attempts: 3,
      retryDelayMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        return okResponse(500);
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe('fail');
    expect(result.message).toContain('HTTP 500');
    // A 5xx is transient, so all attempts are used.
    expect(calls).toBe(3);
    expect(result.remediation?.length).toBeGreaterThan(0);
  });

  it('fails on a network error with actionable advice', async () => {
    const result = await checkHttp({
      url: 'https://example.com',
      expectStatus: [200],
      timeoutMs: 1000,
      attempts: 1,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe('fail');
    expect(result.remediation?.join(' ')).toMatch(/DNS|nginx/i);
  });
});

describe('storage verification', () => {
  it('accepts a correct symlink', () => {
    const result = verifySymlink({
      exists: true,
      isSymlink: true,
      resolvesTo: '/www/wwwroot/example.com/shared/storage',
      expectedTarget: '/www/wwwroot/example.com/shared/storage',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a dangling link', () => {
    const result = verifySymlink({
      exists: true,
      isSymlink: true,
      resolvesTo: '',
      expectedTarget: '/x',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('broken');
  });

  it('rejects a real directory masquerading as a link', () => {
    const result = verifySymlink({
      exists: true,
      isSymlink: false,
      resolvesTo: '/x',
      expectedTarget: '/x',
    });
    expect(result.problem).toBe('not-a-symlink');
  });

  it('rejects a link pointing somewhere else', () => {
    const result = verifySymlink({
      exists: true,
      isSymlink: true,
      resolvesTo: '/wrong/place',
      expectedTarget: '/right/place',
    });
    expect(result.problem).toBe('wrong-target');
    expect(result.message).toContain('/wrong/place');
  });

  it('plans the shared storage layout', () => {
    const plan = planStorageLayout('/www/wwwroot/example.com');
    expect(plan.sharedStorage).toBe('/www/wwwroot/example.com/shared/storage');
    expect(plan.publicStorageTarget).toBe('/www/wwwroot/example.com/shared/storage/app/public');
    expect(plan.requiredDirs).toContain('/www/wwwroot/example.com/shared/storage/framework/views');
  });

  it('requires the files a Laravel release must have', () => {
    const required = requiredReleasePaths({ hasFrontendBuild: true, hasConfigDir: true });
    expect(required).toContain('artisan');
    expect(required).toContain('vendor/autoload.php');
    expect(required).toContain('public/index.php');
    expect(required).toContain('public/build');
  });
});

describe('worker health', () => {
  it('parses supervisorctl status', () => {
    const output = [
      'laravel-client-site-worker          RUNNING   pid 1234, uptime 0:10:00',
      'laravel-other-worker               STOPPED   Nov 01 00:00',
      'some-other-program                 RUNNING   pid 999, uptime 1 day',
    ].join('\n');
    const states = parseSupervisorStatus(output);
    expect(states).toHaveLength(3);
    expect(states[0]).toMatchObject({ name: 'laravel-client-site-worker', state: 'RUNNING' });
  });

  it('is healthy when every expected worker runs', () => {
    const health = evaluateWorkers(
      [{ name: 'laravel-a-worker', state: 'RUNNING', pid: '1', uptime: '1m' }],
      ['laravel-a-worker'],
    );
    expect(health.ok).toBe(true);
  });

  it('is unhealthy when a worker is stopped', () => {
    const health = evaluateWorkers(
      [{ name: 'laravel-a-worker', state: 'STOPPED', pid: '0', uptime: '0' }],
      ['laravel-a-worker'],
    );
    expect(health.ok).toBe(false);
    expect(health.missing).toEqual(['laravel-a-worker']);
  });

  it('ignores processes it does not own', () => {
    const health = evaluateWorkers(
      [{ name: 'laravel-a-worker', state: 'RUNNING', pid: '1', uptime: '1m' }],
      ['laravel-b-worker'],
    );
    expect(health.ok).toBe(false);
  });
});

describe('health aggregation', () => {
  const check = (status: CheckResult['status']): CheckResult => ({ name: 'x', status, message: '' });

  it('is HEALTHY when everything passes', () => {
    expect(aggregate([check('pass'), check('pass')]).status).toBe('HEALTHY');
  });

  it('is DEGRADED on warnings', () => {
    expect(aggregate([check('pass'), check('warn')]).status).toBe('DEGRADED');
  });

  it('is UNHEALTHY on any failure', () => {
    expect(aggregate([check('pass'), check('fail')]).status).toBe('UNHEALTHY');
  });

  it('counts results', () => {
    const report = aggregate([check('pass'), check('pass'), check('warn'), check('fail'), check('skip')]);
    expect(report.passed).toBe(2);
    expect(report.warnings).toBe(1);
    expect(report.failed).toBe(1);
  });
});

describe('health check toggles', () => {
  it('requires both deployment.healthCheck and healthCheck.enabled', () => {
    const base = { server: 'p', site: { domain: 'example.com' } };
    expect(
      healthChecksEnabled(
        validateAppConfig({ ...base, deployment: { healthCheck: false }, healthCheck: { enabled: true } }),
      ),
    ).toBe(false);
    expect(
      healthChecksEnabled(
        validateAppConfig({ ...base, deployment: { healthCheck: true }, healthCheck: { enabled: false } }),
      ),
    ).toBe(false);
    expect(
      healthChecksEnabled(
        validateAppConfig({ ...base, deployment: { healthCheck: true }, healthCheck: { enabled: true } }),
      ),
    ).toBe(true);
  });
});

describe('HealthChecker against a fake server', () => {
  it('passes laravel, database and storage when the server is healthy', async () => {
    const executor = new FakeExecutor()
      .on('artisan about', { exitCode: 0, stdout: 'production' })
      .on('artisan migrate:status', { exitCode: 0, stdout: '| Yes | x | 1 |' })
      .on('SHARED', { stdout: 'SHARED=ok\nWRITABLE=yes\nLINK=/www/wwwroot/example.com/shared/storage\nPUBLIC=/www/wwwroot/example.com/shared/storage/app/public' });

    const checker = new HealthChecker({
      executor,
      layout,
      config: healthCheckConfigSchema.parse({}),
      domain: 'example.com',
      phpBinary: 'php',
    });

    const report = await checker.runAll({ skipHttp: true });
    const byName = Object.fromEntries(report.results.map((r) => [r.name, r.status]));
    expect(byName.laravel).toBe('pass');
    expect(byName.database).toBe('pass');
    expect(byName.storage).toBe('pass');
  });

  it('flags a broken storage symlink', async () => {
    const executor = new FakeExecutor()
      .on('SHARED', { stdout: 'SHARED=ok\nWRITABLE=yes\nLINK=broken\nPUBLIC=broken' });

    const checker = new HealthChecker({
      executor,
      layout,
      config: healthCheckConfigSchema.parse({}),
      domain: 'example.com',
      phpBinary: 'php',
    });

    const storage = await checker.storage();
    expect(storage.status).toBe('fail');
    expect(storage.message).toMatch(/broken|missing/);
    expect(storage.remediation?.join(' ')).toContain('storage repair');
  });

  it('fails laravel when artisan about fails', async () => {
    const executor = new FakeExecutor().on('artisan about', {
      exitCode: 1,
      stderr: 'PHP Fatal: Uncaught Error: undefined constant "APP_KEY"',
    });
    const checker = new HealthChecker({
      executor,
      layout,
      config: healthCheckConfigSchema.parse({}),
      domain: 'example.com',
      phpBinary: 'php',
    });
    const laravel = await checker.laravel();
    expect(laravel.status).toBe('fail');
    expect(laravel.message).toContain('APP_KEY');
  });
});

describe('key/value probe parsing', () => {
  it('parses KEY=value output', () => {
    const values = parseKeyValues('SHARED=ok\nWRITABLE=yes\nLINK=/some/path\nEMPTY=');
    expect(values.SHARED).toBe('ok');
    expect(values.WRITABLE).toBe('yes');
    expect(values.EMPTY).toBe('');
  });
});

describe('plan building', () => {
  const config = validateAppConfig({
    server: 'production',
    site: { domain: 'example.com', root: '/www/wwwroot/example.com' },
    deployment: { healthCheck: true, keepReleases: 4, seeders: false },
    queue: { enabled: true, workers: 2 },
    scheduler: { enabled: true },
    ssl: { enabled: true },
  });

  const profile = serverProfileSchema.parse({
    name: 'production',
    host: '123.123.123.123',
    username: 'root',
  });

  const project = {
    name: 'client-site',
    isLaravel: true,
    laravelMajor: 11,
    laravelRequirement: '^11.0',
    phpRequirement: '^8.2',
    packageManager: 'npm',
    hasFrontendBuild: true,
    hasConfigDir: true,
    hasMigrations: true,
    hasSeeders: false,
    hasHealthEndpoint: true,
    usesVite: true,
    usesMix: false,
    hasRoutes: true,
    hasBootstrapDir: true,
    queueConnection: 'database',
    broadcastConnection: null,
    hints: { queue: true, scheduler: false, broadcasting: false, storage: true },
  } as unknown as ProjectInfo;

  const buildStagePlan = {
    steps: [
      { label: 'composer install', command: 'composer install --no-dev' },
      { label: 'build frontend', command: 'npm run build' },
    ],
    active: [{ label: 'composer install', command: 'composer install --no-dev' }],
    packageManager: 'npm' as const,
    display: ['composer install --no-dev', 'npm run build'],
  };

  const baseInput = {
    project,
    config,
    profile,
    layout,
    releaseId: '20261003-103210',
    gitSha: 'a1b2c3d4e5f6a7b8',
    gitBranch: 'main',
    buildPlan: buildStagePlan,
    cachePlan: { steps: [], display: ['php artisan optimize'] },
    seeder: { enabled: false, reason: 'off by default', classes: ['DatabaseSeeder'] },
    migrationPlan: null,
    pendingMigrations: 4,
    infrastructure: { websiteExists: false, databaseExists: false, sslEnabled: false, firstDeploy: true },
    panelMode: 'aaPanel (API)',
    healthCheck: config.healthCheck,
    options: { skipBuild: false, skipMigrations: false, seed: false, noProvision: false },
  };

  it('plans creation on a first deploy', () => {
    const plan = buildPlan(baseInput);
    const website = plan.infrastructure.items.find((i) => i.label === 'Website');
    const database = plan.infrastructure.items.find((i) => i.label === 'Database');
    expect(website?.action).toBe('create');
    expect(database?.action).toBe('create');
  });

  it('plans reuse when infrastructure already exists', () => {
    const plan = buildPlan({
      ...baseInput,
      infrastructure: { websiteExists: true, databaseExists: true, sslEnabled: true, firstDeploy: false },
    });
    expect(plan.infrastructure.items.find((i) => i.label === 'Website')?.action).toBe('reuse');
    expect(plan.infrastructure.items.find((i) => i.label === 'SSL')?.action).toBe('reuse');
  });

  it('reports the pending migration count', () => {
    const plan = buildPlan(baseInput);
    expect(plan.application.items.find((i) => i.label === 'Migrations')?.detail).toBe('4 pending');
  });

  it('marks seeders as skipped by default', () => {
    const plan = buildPlan(baseInput);
    const seeders = plan.application.items.find((i) => i.label === 'Seeders');
    expect(seeders?.action).toBe('skip');
    expect(seeders?.detail).toContain('off by default');
  });

  it('lists the verification checks that will run', () => {
    const plan = buildPlan(baseInput);
    const labels = plan.verification.items.map((i) => i.label);
    expect(labels).toContain('HTTP');
    expect(labels).toContain('Database');
    expect(labels).toContain('Queue');
    expect(labels).toContain('Scheduler');
    expect(labels).toContain('SSL');
  });

  it('never plans to create anything under --no-provision', () => {
    const plan = buildPlan({
      ...baseInput,
      options: { ...baseInput.options, noProvision: true },
    });
    // Nothing may be created: the deploy would refuse the action.
    expect(plan.infrastructure.items.every((i) => i.action !== 'create')).toBe(true);
    expect(plan.infrastructure.items.find((i) => i.label === 'Website')?.action).toBe('skip');
    expect(plan.infrastructure.items.find((i) => i.label === 'Database')?.action).toBe('skip');
  });

  it('renders the full plan as readable text', () => {
    const rendered = renderPlan(buildPlan(baseInput));
    expect(rendered).toContain('Project');
    expect(rendered).toContain('Infrastructure');
    expect(rendered).toContain('Verification');
    expect(rendered).toContain('20261003-103210');
    expect(rendered).toContain('/www/wwwroot/example.com/current/public');
  });

  it('truncates the git sha for display', () => {
    expect(renderPlan(buildPlan(baseInput))).toContain('a1b2c3d');
  });
});