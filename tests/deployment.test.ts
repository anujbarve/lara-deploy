import { describe, it, expect } from 'vitest';
import { DeploymentMachine, canTransition } from '../src/core/deployment/machine.js';
import { newManifest, type DeploymentManifest } from '../src/core/release/manifest.js';
import {
  buildMigrationPlan,
  parseMigrateStatus,
  assertMigrationAllowed,
  migrationConfirmationSummary,
  assertDeployPipelineSafe,
} from '../src/laravel/migrations.js';
import { decideSeeders, buildSeedInvocations } from '../src/laravel/seeders.js';
import { ArtisanCommandFactory } from '../src/laravel/artisan.js';
import { planCaches } from '../src/laravel/cache.js';
import { SafetyError, ConfirmationRequiredError, AppError } from '../src/core/errors/errors.js';
import type { ProjectInfo } from '../src/laravel/detector.js';

function manifestFixture(): DeploymentManifest {
  return newManifest({
    deploymentId: 'DEPLOY-20261003-103210-A1B2',
    project: 'client-site',
    domain: 'example.com',
    server: 'production',
    serverHost: '1.2.3.4',
    environment: 'production',
    host: 'laptop',
    user: 'root',
    startedAt: new Date('2026-10-03T10:32:10Z'),
  });
}

const projectFixture = (overrides: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    name: 'client-site',
    isLaravel: true,
    laravelMajor: 11,
    phpRequirement: '^8.2',
    hasHealthEndpoint: true,
    hasFrontendBuild: true,
    ...overrides,
  }) as ProjectInfo;

describe('deployment state machine', () => {
  it('advances through the happy path in order', () => {
    const manifest = manifestFixture();
    const machine = new DeploymentMachine(manifest);
    const states = ['VALIDATED', 'BUILT', 'PACKAGED', 'UPLOADED', 'EXTRACTED', 'CONFIGURED', 'MIGRATED', 'OPTIMIZED', 'ACTIVATED', 'VERIFIED'] as const;
    for (const state of states) {
      machine.advance({ to: state, step: state.toLowerCase(), at: new Date() });
    }
    machine.complete(new Date());
    expect(machine.state).toBe('COMPLETED');
    expect(manifest.status).toBe('SUCCESS');
    // One record per advance() call; complete() is a state, not a step.
    expect(manifest.steps).toHaveLength(states.length);
    expect(manifest.steps.map((s) => s.state)).toEqual([...states]);
  });

  it('rejects a transition that skips a state', () => {
    const machine = new DeploymentMachine(manifestFixture());
    expect(() => machine.advance({ to: 'ACTIVATED', step: 'jump', at: new Date() })).toThrow(
      AppError,
    );
    expect(machine.state).toBe('INITIALIZED');
  });

  it('rejects going backwards', () => {
    const machine = new DeploymentMachine(manifestFixture());
    machine.advance({ to: 'VALIDATED', step: 'validate', at: new Date() });
    machine.advance({ to: 'BUILT', step: 'build', at: new Date() });
    expect(() => machine.advance({ to: 'VALIDATED', step: 'back', at: new Date() })).toThrow();
  });

  it('allows FAILED from any live state', () => {
    for (const from of ['INITIALIZED', 'VALIDATED', 'MIGRATED', 'ACTIVATED'] as const) {
      expect(canTransition(from, 'FAILED')).toBe(true);
    }
    expect(canTransition('COMPLETED', 'FAILED')).toBe(false);
  });

  it('records the failed step and error in the manifest', () => {
    const manifest = manifestFixture();
    const machine = new DeploymentMachine(manifest);
    machine.advance({ to: 'VALIDATED', step: 'validate', at: new Date() });
    machine.fail('migrate', new AppError('Migration failed'), new Date());

    expect(manifest.status).toBe('FAILED');
    expect(manifest.state).toBe('FAILED');
    expect(manifest.failedStep).toBe('migrate');
    expect(manifest.error).toBe('Migration failed');
    expect(manifest.steps.at(-1)?.status).toBe('failed');
  });

  it('records skipped steps without advancing the state', () => {
    const manifest = manifestFixture();
    const machine = new DeploymentMachine(manifest);
    machine.advance({ to: 'VALIDATED', step: 'validate', at: new Date() });
    machine.skip('build', 'skipped by --skip-build', new Date());
    expect(machine.state).toBe('VALIDATED');
    expect(manifest.steps.at(-1)).toMatchObject({ step: 'build', status: 'skipped' });
  });

  it('reports progress monotonically', () => {
    const machine = new DeploymentMachine(manifestFixture());
    expect(machine.progress()).toBe(0);
    machine.advance({ to: 'VALIDATED', step: 'a', at: new Date() });
    const after = machine.progress();
    machine.advance({ to: 'BUILT', step: 'b', at: new Date() });
    expect(machine.progress()).toBeGreaterThan(after);
  });
});

describe('migration planning', () => {
  it('runs the safe deploy migration with --force', () => {
    const plan = buildMigrationPlan({
      mode: 'deploy',
      force: true,
      confirmedProduction: false,
      isProduction: true,
    });
    expect(plan.args).toEqual(['migrate', '--force']);
    expect(plan.destructive).toBe(false);
    expect(plan.display).toBe('php artisan migrate --force');
  });

  it('never produces migrate:fresh in the deploy pipeline', () => {
    expect(() =>
      assertDeployPipelineSafe(['migrate:fresh', '--force']),
    ).toThrow(SafetyError);
    expect(() => assertDeployPipelineSafe(['migrate:reset'])).toThrow(SafetyError);
    expect(() => assertDeployPipelineSafe(['db:wipe'])).toThrow(SafetyError);
    expect(() => assertDeployPipelineSafe(['migrate', '--force'])).not.toThrow();
  });

  it('marks fresh/reset as destructive and requires production confirmation', () => {
    const fresh = buildMigrationPlan({
      mode: 'fresh',
      force: true,
      confirmedProduction: false,
      isProduction: true,
    });
    expect(fresh.destructive).toBe(true);
    expect(fresh.requiresProductionConfirmation).toBe(true);
    expect(() => assertMigrationAllowed(fresh)).toThrow(ConfirmationRequiredError);
  });

  it('allows fresh on non-production without the confirmation flag', () => {
    const fresh = buildMigrationPlan({
      mode: 'fresh',
      force: true,
      confirmedProduction: false,
      isProduction: false,
    });
    expect(() => assertMigrationAllowed(fresh)).not.toThrow();
  });

  it('allows fresh on production once confirmed', () => {
    const fresh = buildMigrationPlan({
      mode: 'fresh',
      force: true,
      confirmedProduction: true,
      isProduction: true,
    });
    expect(() => assertMigrationAllowed(fresh)).not.toThrow();
  });

  it('supports step-scoped rollback', () => {
    const plan = buildMigrationPlan({
      mode: 'rollback',
      step: 3,
      force: true,
      confirmedProduction: false,
      isProduction: true,
    });
    expect(plan.args).toEqual(['migrate', '--step', '3', '--force']);
  });

  it('only seeds via --seeder when explicitly asked', () => {
    const without = buildMigrationPlan({
      mode: 'fresh',
      force: true,
      confirmedProduction: true,
      isProduction: true,
    });
    expect(without.args).not.toContain('--seeder');

    const withSeeder = buildMigrationPlan({
      mode: 'fresh',
      force: true,
      confirmedProduction: true,
      isProduction: true,
      seedClass: 'Database\\Seeders\\ProductionSeeder',
    });
    expect(withSeeder.args).toContain('--seeder');
  });

  it('parses migrate:status output', () => {
    const output = [
      '+-----+---------------------------------------+-------+',
      '| Ran? | Migration                             | Batch |',
      '+-----+---------------------------------------+-------+',
      '| Yes | 2024_01_01_000000_create_users_table   | 1     |',
      '| Yes | 2024_01_02_000000_create_posts_table   | 1     |',
      '| No  | 2024_02_01_000000_add_slug_to_users   |       |',
      '+-----+---------------------------------------+-------+',
    ].join('\n');

    const status = parseMigrateStatus(output);
    expect(status.ran).toBe(2);
    expect(status.pending).toBe(1);
    expect(status.migrations[2]?.ran).toBe(false);
    expect(status.migrations[0]?.batch).toBe(1);
  });

  it('produces the pre-migration confirmation summary', () => {
    const lines = migrationConfirmationSummary({
      database: 'client_example',
      environment: 'production',
      pending: 4,
      release: '20261003-103210',
    });
    expect(lines).toContain('Database: client_example');
    expect(lines).toContain('Environment: production');
    expect(lines).toContain('Pending migrations: 4');
  });
});

describe('seeder policy', () => {
  const config = { enabled: false, class: 'Database\\Seeders\\DatabaseSeeder', extraClasses: [] };

  it('never seeds by default in production', () => {
    const decision = decideSeeders({
      config,
      isProduction: true,
      isFirstDeploy: false,
      nonInteractive: false,
    });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('off by default');
  });

  it('seeds when --seed is passed', () => {
    const decision = decideSeeders({
      config,
      cliSeed: true,
      isProduction: true,
      isFirstDeploy: false,
      nonInteractive: true,
    });
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toContain('--seed');
  });

  it('--no-seed wins over config opt-in', () => {
    const decision = decideSeeders({
      config: { ...config, enabled: true },
      cliNoSeed: true,
      isProduction: true,
      isFirstDeploy: true,
      nonInteractive: false,
    });
    expect(decision.enabled).toBe(false);
  });

  it('does not seed non-interactively even on a first deploy', () => {
    const decision = decideSeeders({
      config,
      isProduction: true,
      isFirstDeploy: true,
      nonInteractive: true,
    });
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('non-interactive');
  });

  it('builds one db:seed invocation per class', () => {
    const decision = decideSeeders({
      config: { ...config, enabled: true, extraClasses: ['Database\\Seeders\\RolesSeeder'] },
      isProduction: true,
      isFirstDeploy: false,
      nonInteractive: false,
    });
    expect(decision.enabled).toBe(true);
    const invocations = buildSeedInvocations(decision, new ArtisanCommandFactory(projectFixture()));
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).toEqual(['db:seed', '--class', 'Database\\Seeders\\DatabaseSeeder', '--force']);
  });

  it('never emits migrate:fresh --seed', () => {
    const decision = decideSeeders({
      config: { ...config, enabled: true },
      isProduction: true,
      isFirstDeploy: false,
      nonInteractive: false,
    });
    const invocations = buildSeedInvocations(decision, new ArtisanCommandFactory(projectFixture()));
    for (const invocation of invocations) {
      expect(invocation.args).not.toContain('migrate:fresh');
    }
  });
});

describe('artisan command factory', () => {
  it('builds the standard migrate command', () => {
    const factory = new ArtisanCommandFactory(projectFixture(), { releasePath: '/www/current' });
    const invocation = factory.migrate();
    expect(invocation.args).toEqual(['migrate', '--force']);
    expect(invocation.cwd).toBe('/www/current');
    expect(invocation.critical).toBe(true);
  });

  it('uses individual cache commands on very old Laravel', () => {
    const factory = new ArtisanCommandFactory(projectFixture({ laravelMajor: 5 }));
    const steps = factory.optimize();
    expect(steps.map((s) => s.args[0])).toEqual(['config:cache', 'route:cache', 'view:cache']);
  });

  it('uses `optimize` on modern Laravel', () => {
    const factory = new ArtisanCommandFactory(projectFixture({ laravelMajor: 11 }));
    expect(factory.optimize()[0]?.args).toEqual(['optimize']);
  });

  it('always clears caches before optimizing', () => {
    const factory = new ArtisanCommandFactory(projectFixture());
    const plan = planCaches(factory);
    expect(plan.steps[0]?.invocation.args).toEqual(['optimize:clear']);
    expect(plan.display[0]).toContain('optimize:clear');
  });

  it('builds an idempotent storage:link', () => {
    const factory = new ArtisanCommandFactory(projectFixture());
    expect(factory.storageLink().args).toEqual(['storage:link', '--force']);
  });

  it('passes artisan arguments through verbatim', () => {
    const factory = new ArtisanCommandFactory(projectFixture());
    const invocation = factory.passthrough(['about', '--only=env']);
    expect(invocation.args).toEqual(['about', '--only=env']);
  });
});