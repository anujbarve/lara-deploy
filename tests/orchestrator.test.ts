/**
 * End-to-end deployment scenarios against a scripted server.
 *
 * These exercise the orchestrator's ordering, idempotency and failure semantics:
 * build failure stops everything, migrations run before activation, activation
 * is atomic, a failure never silently rolls back, and two simultaneous
 * deployments cannot both proceed.
 *
 * Everything is injected: no network, no local build, no filesystem outside the
 * temp fixture.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DeploymentOrchestrator } from '../src/core/deployment/orchestrator.js';
import { validateAppConfig } from '../src/core/config/loader.js';
import { serverProfileSchema, type AppConfig } from '../src/core/config/schema.js';
import { resolvePaths } from '../src/core/config/paths.js';
import { MemorySecretsStore } from '../src/core/security/secrets.js';
import { SilentUi } from '../src/cli/ui/ui.js';
import { fixedClock } from '../src/utils/ids.js';
import { FakeExecutor, makeLaravelFixture, cleanupFixture } from './helpers.js';
import { AutoYes } from '../src/core/deployment/confirmation.js';
import type { UploadOptions, Uploader } from '../src/providers/sftp/uploader.js';
import type { PanelAdapter } from '../src/providers/aapanel/types.js';

const profile = serverProfileSchema.parse({
  name: 'test',
  host: '10.0.0.1',
  username: 'root',
  siteRoot: '/www/wwwroot',
  aapanel: { enabled: true, fallbackToSsh: true },
});

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

let projectRoot: string;
let stateDir: string;
let localBuild: FakeExecutor;
let remote: FakeExecutor;
let uploads: string[];
let uploadShouldFail: boolean;
let websiteExists: boolean;

beforeEach(() => {
  projectRoot = makeLaravelFixture();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-state-'));
  uploads = [];
  uploadShouldFail = false;
  websiteExists = false;
  localBuild = new FakeExecutor();
  remote = new FakeExecutor();
  // Every test starts from a server that answers the whole happy path; a test
  // that needs a failure adds its own more specific handler.
  happyServer();
});

afterEach(() => {
  cleanupFixture(projectRoot);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A server that answers everything the happy path needs. */
function happyServer(): FakeExecutor {
  remote
    .on('hostname', { stdout: 'srv1\n' })
    .on('id -un', { stdout: 'root\n' })
    .on('uname -sr', { stdout: 'Linux 6.1\n' })
    .on('php -v', { stdout: 'PHP 8.3.12 (cli) (built: Nov 21 2024) 8.3.12\n' })
    .on('id -un www', { exitCode: 0, stdout: 'www\n' })
    .on('id -gn', { stdout: 'www\n' })
    .on('nginx -v', { stdout: 'nginx version: nginx/1.24.0\n' })
    .on('stat -c %U /www/wwwroot', { stdout: 'root\n' })
    .on('readlink -f', { stdout: '/www/wwwroot/example.com/releases/20261003-101500\n' })
    .on('ls -1 /www/wwwroot/example.com/releases', { stdout: '20261003-101500\n20261002-101500\n' })
    .on('test -d /www/wwwroot/example.com', { exitCode: websiteExists ? 0 : 1 })
    .on('artisan about', { exitCode: 0, stdout: 'Environment  production' })
    .on('artisan migrate:status', {
      exitCode: 0,
      stdout: [
        '+-----+---------------------------+-------+',
        '| Ran? | Migration                 | Batch |',
        '+-----+---------------------------+-------+',
        '| Yes | 2024_01_01_create_users   | 1     |',
        '| No  | 2024_02_01_add_slug       |       |',
        '+-----+---------------------------+-------+',
      ].join('\n'),
    })
    .on('artisan migrate --force', { exitCode: 0, stdout: 'Migrated: 2024_02_01_add_slug' })
    .on('mysqldump', { exitCode: 0, stdout: '' })
    .on('stat -c %s', { stdout: '4096\n' });
  return remote;
}

/** A panel adapter that reports "nothing exists yet" and records provisions. */
/** Shared so a test can assert what the deploy stored. */
const secrets = new MemorySecretsStore();

function fakePanel(): PanelAdapter & { created: string[] } {
  const created: string[] = [];
  return {
    name: 'fake',
    canProvision: true,
    created,
    available: async () => ({ available: true, mode: 'ssh' as const, reason: 'test' }),
    createWebsite: async ({ domain }) => {
      created.push(`website:${domain}`);
      return { name: domain, domain, port: 80, root: '/r', status: 'running' as const };
    },
    websiteExists: async () => websiteExists,
    getWebsite: async () =>
      websiteExists
        ? { name: 'example.com', domain: 'example.com', port: 80, root: '/r', status: 'running' as const }
        : null,
    deleteWebsite: async () => true,
    createDatabase: async ({ name }) => {
      created.push(`database:${name}`);
      return { name, username: name, host: 'localhost', port: 3306, accept: true };
    },
    databaseExists: async () => false,
    getDatabase: async () => null,
    enableSsl: async () => ({ enabled: true, provider: 'letsencrypt' as const, domains: [] }),
    getSslStatus: async () => ({ enabled: false, provider: 'none' as const, domains: [] }),
    getSiteConfig: async () => null,
    updateSiteConfig: async () => {},
    setPhpVersion: async () => {},
  };
}

function fakeUploader(): Uploader {
  // Report the real size of whatever was uploaded so the orchestrator's
  // integrity check behaves exactly as it would in production.
  let lastBytes = 0;
  return {
    upload: async (options: UploadOptions) => {
      uploads.push(options.remotePath);
      if (uploadShouldFail) {
        const { TransportError } = await import('../src/core/errors/errors.js');
        throw new TransportError('upload failed', { severity: 'transient' });
      }
      lastBytes = fs.statSync(options.localPath).size;
      return {
        remotePath: options.remotePath,
        bytes: lastBytes,
        durationMs: 1,
        attempts: 1,
        humanSize: `${lastBytes} B`,
      };
    },
    uploadText: async () => {},
    remove: async () => {},
    stat: async () => lastBytes,
    verify: async () => true,
    close: async () => {},
  };
}

function makeOrchestrator(configOverrides: Record<string, unknown> = {}, flagOverrides: Record<string, unknown> = {}) {
  const config = validateAppConfig(
    {
      server: 'test',
      site: { domain: 'example.com', root: '/www/wwwroot/example.com' },
      deployment: { healthCheck: false, optimize: true, keepReleases: 3 },
      queue: { enabled: false },
      scheduler: { enabled: false },
      ...configOverrides,
    },
    'test',
  ) as AppConfig;

  const paths = { ...resolvePaths(projectRoot), historyDir: path.join(stateDir, 'history'), cacheDir: stateDir };

  return new DeploymentOrchestrator({
    cwd: projectRoot,
    paths,
    config,
    profile,
    secrets,
    ui: new SilentUi(),
    clock: fixedClock('2026-10-03T10:32:10Z'),
    dryRun: false,
    planOnly: false,
    yes: true,
    force: false,
    forceUnlock: false,
    skipBuild: false,
    skipMigrations: false,
    noSeed: false,
    noProvision: false,
    verbose: false,
    environment: 'production',
    localExecutor: localBuild,
    uploader: fakeUploader(),
    panelFactory: () => fakePanel(),
    scriptsDir: SCRIPTS_DIR,
    executorFactory: () => remote,
    ...flagOverrides,
  });
}

describe('deployment happy path', () => {
  it('runs the full lifecycle and activates a release', async () => {
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.failure?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.manifest.status).toBe('SUCCESS');
    expect(result.releaseId).toMatch(/^20261003-103210/);
    expect(result.manifest.activated).toBe(true);

    const states = result.manifest.steps.map((step) => step.state);
    expect(states).toContain('PACKAGED');
    expect(states).toContain('EXTRACTED');
    expect(states).toContain('CONFIGURED');
    expect(states).toContain('MIGRATED');
    expect(states).toContain('ACTIVATED');
  });

  it('builds before packaging and activates after migrating', async () => {
    const result = await makeOrchestrator().deploy(new AutoYes());
    const order = result.manifest.steps.map((step) => step.step);
    expect(order.indexOf('build')).toBeLessThan(order.indexOf('package'));
    expect(order.indexOf('migrate')).toBeLessThan(order.indexOf('activate'));
  });

  it('runs the detected package manager', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    expect(localBuild.saw('composer install --no-dev')).toBe(true);
    expect(localBuild.saw('npm ci')).toBe(true);
    expect(localBuild.saw('npm run build')).toBe(true);
  });

  it('uploads to the incoming directory, never the live tree', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    expect(uploads[0]).toContain('/.deploy/incoming/');
    expect(uploads[0]).toContain('20261003-103210');
  });

  it('extracts into releases/<id> and verifies the contents', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    expect(remote.saw("export LD_RELEASE='20261003-103210'")).toBe(true);
    expect(remote.saw("export LD_STRATEGY='public'")).toBe(true);
    // Release completeness is verified before anything else happens.
    expect(remote.saw('vendor/autoload.php')).toBe(true);
    expect(remote.saw('bootstrap/app.php')).toBe(true);
    expect(remote.saw('public/index.php')).toBe(true);
  });

  it('activates atomically via the symlink switch', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    expect(remote.saw('activate-release.sh')).toBe(true);
    expect(remote.saw("export LD_RELEASE='20261003-103210'")).toBe(true);
  });

  it('prunes old releases after a successful deploy', async () => {
    await makeOrchestrator({ deployment: { healthCheck: false, keepReleases: 2 } }).deploy(new AutoYes());
    expect(remote.saw('rm -rf')).toBe(true);
    // Never the current release.
    expect(remote.commands.join('\n')).not.toMatch(/rm -rf [^\n]*20261003-103210'/);
  });

  it('makes a database backup before migrating', async () => {
    const result = await makeOrchestrator({
      deployment: { healthCheck: false, backupDatabaseBeforeMigration: true, keepReleases: 3 },
    }).deploy(new AutoYes());
    expect(result.backupPath).toContain('deploy-backups');
    expect(remote.saw('mysqldump')).toBe(true);
    // The credentials file is referenced, not inlined on the command line.
    expect(remote.saw('--defaults-file=')).toBe(true);
    expect(remote.saw('umask 077')).toBe(true);
  });

  it('runs artisan against the release being deployed, not the current symlink', async () => {
    // On a first deploy `current` does not exist until activation, but artisan
    // runs before that — so `cd current` failed and migrate could not run.
    await makeOrchestrator().deploy(new AutoYes());
    // Only real invocations: `cd <dir>` followed by `php artisan ...`.
    const artisan = remote.commands.filter((c) => /^cd .*\n.*artisan /m.test(c));
    expect(artisan.length).toBeGreaterThan(0);
    for (const command of artisan) {
      expect(command).toContain("/releases/20261003-103210'");
      expect(command).not.toContain("cd '/www/wwwroot/example.com/current'");
    }
  });

  it('forces production invariants over a development .env.example', async () => {
    // The fixture ships an .env.example with APP_ENV=local and APP_DEBUG=true.
    const result = await makeOrchestrator().deploy(new AutoYes());
    expect(result.success).toBe(true);
    const write = remote.commands.find((c) => c.includes("cat > '/www/wwwroot/example.com/shared/.env'"));
    expect(write).toContain('APP_ENV=production');
    expect(write).toContain('APP_DEBUG=false');
    expect(write).not.toContain('APP_ENV=local');
  });
});

describe('build failure', () => {
  it('stops before packaging or uploading anything', async () => {
    localBuild.on('npm run build', { exitCode: 1, stderr: 'error TS2345: Type mismatch' });
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.message).toContain('build frontend');
    expect(uploads).toHaveLength(0);
    expect(result.manifest.state).toBe('FAILED');
    expect(result.manifest.activated).toBeFalsy();
  });

  it('reports what failed, the command, and that live was untouched', async () => {
    localBuild.on('npm run build', { exitCode: 1, stderr: 'lockfile out of sync' });
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.failure?.command).toContain('npm run build');
    expect(result.failure?.liveAffected).toBe(false);
    expect(result.failure?.remediation.join(' ')).toMatch(/not changed/i);
    // The manifest records the failed step.
    expect(result.manifest.failedStep).toBeTruthy();
  });
});

describe('migration failure', () => {
  it('does not activate the release', async () => {
    remote.on('artisan migrate --force', {
      exitCode: 1,
      stderr: 'SQLSTATE[42S02]: Base table or view not found',
    });
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.message).toContain('migrate');
    expect(result.manifest.activated).toBeFalsy();
    expect(result.manifest.steps.some((s) => s.state === 'ACTIVATED')).toBe(false);
    expect(result.failure?.liveAffected).toBe(false);
  });
});

describe('upload failure', () => {
  it('never activates when the transfer fails', async () => {
    uploadShouldFail = true;
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.manifest.activated).toBeFalsy();
  });
});

describe('activation failure', () => {
  it('reports that the live site was not changed', async () => {
    remote.on('activate-release.sh', { exitCode: 7, stderr: 'Incomplete release: missing artisan' });
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.manifest.activated).toBeFalsy();
    expect(result.failure?.remediation.join(' ')).toMatch(/previous release is still live/i);
  });
});

describe('post-activation health failure', () => {
  /**
   * A server that is healthy inside the staged release but broken once the
   * symlink points at it. The two health checks differ only by their working
   * directory: the candidate check runs inside `releases/<id>`, the live check
   * inside `current`. `healthCheck.http` and `.ssl` are off because they would
   * reach the real network; laravel, database and storage are remote commands.
   */
  function breaksAfterActivation(): FakeExecutor {
    // The server's release history. Needed so there is something to roll back
    // to: the real `ls` path is quoted, so the happy-path matcher (which uses
    // the bare path) never fires and the listing would otherwise be empty.
    remote.on('ls -1', { stdout: '20261003-101500\n20261002-101500' });
    // The storage probe is a single command printing key=value lines.
    remote.on('SHARED=', {
      stdout: 'SHARED=ok\nLINK=/www/wwwroot/example.com/shared/storage\nWRITABLE=yes',
    });
    remote.on('artisan about', (command) =>
      command.includes("/current'")
        ? { exitCode: 1, stderr: 'Fatal error: Allowed memory size exhausted' }
        : { exitCode: 0, stdout: 'Environment  production' },
    );
    return remote;
  }

  const healthConfig = {
    deployment: { activationSettleSeconds: 0, rollbackOnHealthFailure: true },
    healthCheck: { enabled: true, http: false, ssl: false },
  };

  it('rolls back to the previous release and still fails the deployment', async () => {
    breaksAfterActivation();
    const result = await makeOrchestrator(healthConfig).deploy(new AutoYes());

    // Failing, even though the live site is healthy again: this deployment is
    // what broke it, and a CI pipeline must not read it as a green build.
    expect(result.success).toBe(false);
    expect(result.failure?.message).toMatch(/rolled back to 20261002-101500/);

    // It really switched: the last activation targets the *older* release.
    const activations = remote.commands.filter((c) => c.includes('export LD_RELEASE='));
    expect(activations[activations.length - 1]).toContain("export LD_RELEASE='20261002-101500'");

    // Production is back on the old code, so the report must not claim otherwise.
    expect(result.failure?.liveAffected).toBe(false);
    expect(result.manifest.healthStatus).toBe('failed');
  });

  it('leaves the failed release live when rollbackOnHealthFailure is off', async () => {
    breaksAfterActivation();
    const result = await makeOrchestrator({
      ...healthConfig,
      deployment: { activationSettleSeconds: 0, rollbackOnHealthFailure: false },
    }).deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.liveAffected).toBe(true);
    expect(result.failure?.remediation.join(' ')).toMatch(/laravel-deploy rollback/);

    const activations = remote.commands.filter((c) => c.includes('export LD_RELEASE='));
    expect(activations[activations.length - 1]).toContain("export LD_RELEASE='20261003-103210'");
  });

  it('does not activate a release that already failed the candidate check', async () => {
    breaksAfterActivation();
    remote.on('artisan about', { exitCode: 1, stderr: 'boom' });
    const result = await makeOrchestrator(healthConfig).deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.liveAffected).toBe(false);
    expect(result.failure?.message).toMatch(/not activated/);
  });
});

describe('simultaneous deployments', () => {
  it('refuses the second deploy while a lock is held', async () => {
    remote.on(".deploy/deployment.lock' 2>/dev/null", {
      exitCode: 0,
      stdout: JSON.stringify({
        deploymentId: 'DEPLOY-OTHER',
        startedAt: new Date().toISOString(),
        host: 'ci-runner',
        user: 'deploy',
      }),
    });

    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.message).toContain('already running');
    expect(result.failure?.message).toContain('DEPLOY-OTHER');
    // It never got as far as building or uploading.
    expect(localBuild.saw('composer install')).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('acquires the lock before doing any work', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    expect(remote.saw('deployment.lock')).toBe(true);
  });
});

describe('plan and dry-run', () => {
  it('--plan prints the plan and changes nothing', async () => {
    const result = await makeOrchestrator({}, { planOnly: true }).deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(result.renderedPlan).toContain('Infrastructure');
    expect(result.renderedPlan).toContain('Document root');
    // Git is read for the plan; nothing is built, uploaded or activated.
    expect(localBuild.saw('composer install')).toBe(false);
    expect(localBuild.saw('npm ci')).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(remote.saw('prepare-release.sh')).toBe(false);
  });

  it('--dry-run makes no changes', async () => {
    const result = await makeOrchestrator({}, { dryRun: true }).deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(localBuild.saw('composer install')).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(remote.saw('prepare-release.sh')).toBe(false);
    expect(remote.saw('activate-release.sh')).toBe(false);
  });
});

describe('packaging format', () => {
  it('tells the server which archive format to extract', async () => {
    const result = await makeOrchestrator({ packaging: { format: 'zip' } }).deploy(new AutoYes());
    expect(result.success).toBe(true);

    // LD_FORMAT selects tar or unzip inside prepare-release.sh. It used to be
    // omitted entirely, so the script always fell back to tar.gz and a zip
    // deployment failed on the server after the upload.
    expect(remote.saw("export LD_FORMAT='zip'")).toBe(true);
  });

  it('sends tar.gz by default and names the archive to match', async () => {
    const result = await makeOrchestrator({}).deploy(new AutoYes());
    expect(result.success).toBe(true);

    expect(remote.saw("export LD_FORMAT='tar.gz'")).toBe(true);
    expect(remote.saw('.tar.gz')).toBe(true);
  });
});

describe('flags', () => {
  it('--skip-build skips the build steps', async () => {
    const result = await makeOrchestrator({}, { skipBuild: true }).deploy(new AutoYes());

    expect(result.failure?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(localBuild.saw('composer install')).toBe(false);
    expect(localBuild.saw('npm ci')).toBe(false);
    expect(result.manifest.steps.some((s) => s.status === 'skipped')).toBe(true);
  });

  it('--skip-migrations never runs artisan migrate', async () => {
    const result = await makeOrchestrator({}, { skipMigrations: true }).deploy(new AutoYes());

    expect(result.failure?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(remote.saw('artisan migrate --force')).toBe(false);
    expect(result.manifest.migrationStatus).toBe('skipped');
  });

  it('never seeds by default', async () => {
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(remote.saw('artisan db:seed')).toBe(false);
    expect(result.manifest.seedStatus).toBe('skipped');
  });

  it('seeds when explicitly enabled', async () => {
    const result = await makeOrchestrator({}, { seed: true }).deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(remote.saw('artisan db:seed')).toBe(true);
    expect(result.manifest.seedStatus).toBe('ran');
  });
});

describe('PHP version gate', () => {
  it('blocks deployment when the server PHP is too old', async () => {
    remote.on('php -v', { stdout: 'PHP 8.1.27 (cli)\n' });
    const result = await makeOrchestrator().deploy(new AutoYes());

    expect(result.success).toBe(false);
    expect(result.failure?.message).toMatch(/requires PHP >= 8\.2/);
    expect(localBuild.saw('composer install')).toBe(false);
    expect(uploads).toHaveLength(0);
  });

  it('proceeds with --force', async () => {
    remote.on('php -v', { stdout: 'PHP 8.1.27 (cli)\n' });
    const result = await makeOrchestrator({}, { force: true }).deploy(new AutoYes());
    expect(result.success).toBe(true);
  });
});

describe('infrastructure provisioning', () => {
  it('reuses an existing website instead of creating a second', async () => {
    websiteExists = true;
    const panel = fakePanel();
    const orchestrator = makeOrchestrator({}, { panelFactory: () => panel });
    const result = await orchestrator.deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(panel.created.filter((c) => c.startsWith('website:'))).toHaveLength(0);
  });

  it('creates the website when it is missing', async () => {
    websiteExists = false;
    const panel = fakePanel();
    const result = await makeOrchestrator(
      {},
      { panelFactory: () => panel },
    ).deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(panel.created).toContain('website:example.com');
  });

  it('creates the database when it is missing', async () => {
    // The deploy only printed "Database will be created" and created nothing,
    // so it went on to dump a database that did not exist and died with
    // "Access denied for user ...". The user did not exist either, because
    // nothing had ever made it.
    const panel = fakePanel();
    const result = await makeOrchestrator({}, { panelFactory: () => panel }).deploy(new AutoYes());

    expect(result.success).toBe(true);
    // The fixture project's name is client-site, so the default database name
    // is its slug.
    expect(panel.created).toContain('database:client_site');
  });

  it('creates the database user with the password the deploy will use', async () => {
    // Provisioning, the .env and the pre-migration backup must agree, or the
    // backup authenticates with a password MySQL never accepted.
    let passwordUsedForCreate: string | undefined;
    const panel = fakePanel();
    panel.createDatabase = async ({ name, password }) => {
      passwordUsedForCreate = password;
      panel.created.push(`database:${name}`);
      return { name, username: name, host: 'localhost', port: 3306, accept: true };
    };

    await makeOrchestrator({}, { panelFactory: () => panel }).deploy(new AutoYes());

    const stored = secrets.get('servers.test.database.password');
    expect(stored).toBeTruthy();
    expect(passwordUsedForCreate).toBe(stored);
  });

  it('reuses an existing database instead of creating a second', async () => {
    const panel = fakePanel();
    panel.databaseExists = async () => true;
    await makeOrchestrator({}, { panelFactory: () => panel }).deploy(new AutoYes());
    expect(panel.created.filter((c) => c.startsWith('database:'))).toHaveLength(0);
  });

  it('never provisions when --no-provision is set', async () => {
    websiteExists = false;
    const panel = fakePanel();
    const result = await makeOrchestrator({}, { panelFactory: () => panel, noProvision: true }).deploy(new AutoYes());

    expect(panel.created).toHaveLength(0);
    expect(result.success).toBe(true);
  });
});

describe('legacy mode', () => {
  /**
   * The command that actually runs prepare-release.sh, as opposed to the one
   * that uploads it. Both contain the script's name, so match on something only
   * the invocation has.
   */
  function prepareInvocation(): string {
    return remote.commands.find((c) => c.includes('export LD_ARCHIVE=')) as string;
  }
  const legacySite = {
    domain: 'example.com',
    root: '/www/wwwroot/example.com',
    documentRootStrategy: 'legacy-root-copy' as const,
  };

  it('uses the legacy main/ layout', async () => {
    const result = await makeOrchestrator({
      site: legacySite,
      legacy: { mainDir: 'main' },
    }).deploy(new AutoYes());

    expect(result.success).toBe(true);
    expect(remote.saw("export LD_STRATEGY='legacy-root-copy'")).toBe(true);
    expect(remote.saw("export LD_MAIN_DIR='main'")).toBe(true);
  });

  it('stages the generated bootstrap and tells the script what to publish', async () => {
    await makeOrchestrator({ site: legacySite, legacy: { mainDir: 'main' } }).deploy(new AutoYes());

    // The document root is the site root, so index.php has to be written there.
    // It is staged and installed by the script, never written ad hoc.
    expect(remote.saw('export LD_INDEX_FILE=')).toBe(true);
    const prepare = prepareInvocation();
    expect(prepare).toContain('require main/vendor/autoload.php');
    expect(prepare).toContain('$app->handleRequest');

    // The allowlist and the never-clobber list come from the CLI, not the script.
    expect(prepare).toContain("export LD_LEGACY_PUBLIC_ENTRIES='assets build css js images img fonts favicon.ico robots.txt'");
    expect(prepare).toMatch(/export LD_LEGACY_PRESERVE='.*\.user\.ini/s);
  });

  it('passes operator-configured preserved files through to the script', async () => {
    await makeOrchestrator({
      site: legacySite,
      legacy: { mainDir: 'main', preserveRootFiles: ['custom.conf'] },
    }).deploy(new AutoYes());

    const prepare = prepareInvocation();
    expect(prepare).toContain('export LD_LEGACY_PRESERVE=');
    expect(prepare).toContain('custom.conf');
  });

  it('links shared storage under the live app dir, not always current/', async () => {
    await makeOrchestrator({ site: legacySite, legacy: { mainDir: 'main' } }).deploy(new AutoYes());

    // planStorageLayout used to hardcode <root>/current, so a legacy deploy
    // linked storage somewhere nginx never looks.
    expect(remote.saw("ln -sfn '/www/wwwroot/example.com/shared/storage/app/public' '/www/wwwroot/example.com/main/public/storage'")).toBe(true);
    expect(remote.saw('/www/wwwroot/example.com/current/public/storage')).toBe(false);
  });

  it('verifies the bootstrap is present before activating', async () => {
    await makeOrchestrator({ site: legacySite, legacy: { mainDir: 'main' } }).deploy(new AutoYes());
    expect(remote.saw("test -f '/www/wwwroot/example.com/index.php'")).toBe(true);
  });

  it('publishes nothing in the modern strategy', async () => {
    await makeOrchestrator().deploy(new AutoYes());
    // The legacy env vars must not leak into a standard deploy.
    expect(remote.saw('export LD_INDEX_FILE=')).toBe(false);
    expect(remote.saw('export LD_LEGACY_PUBLIC_ENTRIES=')).toBe(false);
  });
});

describe('manifest', () => {
  it('is persisted to the history directory', async () => {
    const result = await makeOrchestrator().deploy(new AutoYes());
    const file = path.join(stateDir, 'history', `${result.deploymentId}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.deploymentId).toBe(result.deploymentId);
    expect(saved.domain).toBe('example.com');
    expect(saved.status).toBe('SUCCESS');
  });

  it('is persisted on failure too', async () => {
    localBuild.on('npm run build', { exitCode: 1, stderr: 'nope' });
    const result = await makeOrchestrator().deploy(new AutoYes());
    const file = path.join(stateDir, 'history', `${result.deploymentId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.status).toBe('FAILED');
    expect(saved.failedStep).toBeTruthy();
  });
});
