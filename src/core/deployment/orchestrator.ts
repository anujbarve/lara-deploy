/**
 * Deployment orchestrator.
 *
 * Coordinates the pipeline stages; it owns the state machine, the ordering
 * guarantee (nothing activates before it is verified) and the failure reporting.
 * Each stage is a method backed by a dedicated module — there is deliberately no
 * 2,000-line `deploy()` here (SPEC §44, §60).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import type { AppConfig, ServerProfile } from '../config/schema.js';
import { type CliPaths } from '../config/paths.js';
import {
  AppError,
  RemoteCommandError,
  SafetyError,
  toAppError,
  UserAbortError,
} from '../errors/errors.js';
import { buildLayout, incomingArchivePath, scriptPath, type SiteLayout } from '../release/layout.js';
import {
  ManifestStore,
  newManifest,
  type DeploymentManifest,
} from '../release/manifest.js';
import { DeploymentMachine } from './machine.js';
import { DeploymentLock } from '../release/lock.js';
import {
  cleanupFailedRelease,
  listReleases,
  planRetention,
  pruneBackups,
  pruneReleases,
  readCurrentRelease,
  readPreviousRelease,
} from '../release/retention.js';
import { buildPlan, renderPlan, type DeploymentPlan } from './plan.js';
import { readGitInfo, describeGit, type GitInfo } from './git.js';
import { HealthChecker, healthChecksEnabled, type HealthReport, type CheckResult } from '../health/checker.js';

import { inspectProject, slugify, readEnvFile, type ProjectInfo } from '../../laravel/detector.js';
import { ArtisanCommandFactory, renderCommand } from '../../laravel/artisan.js';
import { parseMigrateStatus, buildMigrationPlan } from '../../laravel/migrations.js';
import { decideSeeders, buildSeedInvocations } from '../../laravel/seeders.js';
import { planCaches } from '../../laravel/cache.js';
import { planStorageLayout, requiredReleasePaths } from '../../laravel/storage.js';
import { planWorkers } from '../../laravel/workers.js';
import { validateEnv, planEnvWrite, parseEnv, renderEnv, envWriteScript } from '../../laravel/env.js';

import { Builder, planBuild } from '../../build/builder.js';
import { Packager } from '../../packaging/packager.js';
import { LocalExecutor } from '../../providers/exec/local.js';
import { SshExecutor } from '../../providers/exec/ssh.js';
import { SftpUploader } from '../../providers/sftp/uploader.js';
import { AaPanelAdapter, ensureDatabase, ensureSsl, ensureWebsite } from '../../providers/aapanel/adapter.js';
import type { PanelAdapter } from '../../providers/aapanel/types.js';
import { MysqlProvider } from '../../providers/mysql/provider.js';
import { SupervisorManager } from '../../providers/supervisor/manager.js';
import { CronManager } from '../../providers/cron/manager.js';
import { WebServerProvider, planPermissions } from '../../providers/webserver/provider.js';
import type { RemoteExecutor } from '../../providers/exec/types.js';

import type { SecretsStore } from '../security/secrets.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';
import { retry } from '../../utils/retry.js';
import { q, assertRemotePath } from '../../utils/shell.js';
import { compareVersions, parseVersionConstraint, parsePhpVersion } from '../../utils/versions.js';
import { buildDeploymentId, buildReleaseId, formatDuration, humanTimestamp, releaseStamp, shortToken, generatePassword, type Clock } from '../../utils/ids.js';
import { remoteScriptsDir } from '../config/paths.js';
import type { Ui } from '../../cli/ui/ui.js';
import type { Confirmation } from './confirmation.js';

export interface DeployOptions {
  cwd: string;
  paths: CliPaths;
  config: AppConfig;
  profile: ServerProfile;
  secrets: SecretsStore;
  ui: Ui;
  clock: Clock;
  logger?: Logger;

  /** CLI flags. */
  dryRun: boolean;
  planOnly: boolean;
  yes: boolean;
  force: boolean;
  forceUnlock: boolean;
  skipBuild: boolean;
  skipMigrations: boolean;
  seed?: boolean;
  noSeed: boolean;
  noProvision: boolean;
  verbose: boolean;
  environment: string;
  /** Explicit override for the config's server. */
  serverOverride?: string;
  branch?: string;
  commit?: string;
  /**
   * Local build executor. Injectable so tests (and alternative build runners)
   * can substitute it; defaults to a real LocalExecutor over the project cwd.
   */
  localExecutor?: RemoteExecutor;
  /** Uploader. Injectable for tests; defaults to a real SFTP uploader. */
  uploader?: import('../../providers/sftp/uploader.js').Uploader;
  /** Panel adapter factory. Injectable for tests. */
  panelFactory?: (executor: RemoteExecutor) => import('../../providers/aapanel/types.js').PanelAdapter;
  /** Directory holding the bundled remote shell scripts. */
  scriptsDir?: string;
  /** Remote executor factory. Injectable for tests; defaults to real SSH. */
  executorFactory?: (profile: ServerProfile, logger: Logger) => RemoteExecutor;
}

export interface DeployResult {
  success: boolean;
  deploymentId: string;
  releaseId: string;
  domain: string;
  server: string;
  gitSha: string | null;
  manifest: DeploymentManifest;
  plan: DeploymentPlan;
  /** Only present when --plan or --dry-run. */
  renderedPlan?: string;
  health?: HealthReport;
  backupPath?: string;
  durationMs: number;
  /** Set when a pre-activation failure occurred; the live site was untouched. */
  failure?: AppError;
}

export class DeploymentOrchestrator {
  private readonly logger: Logger;
  private readonly local: RemoteExecutor;
  private remote: RemoteExecutor | null = null;
  private machine: DeploymentMachine | null = null;
  private manifest: DeploymentManifest | null = null;
  private layout!: SiteLayout;
  private project!: ProjectInfo;
  private git: GitInfo | null = null;
  private lockAcquired = false;
  private activated = false;
  private manifestStore!: ManifestStore;
  private deploymentId = '';
  private releaseId = '';
  private startedAt = 0;

  constructor(private readonly options: DeployOptions) {
    this.logger = options.logger ?? nullLogger();
    this.local = options.localExecutor ?? new LocalExecutor(options.cwd);
    this.manifestStore = new ManifestStore(options.paths.historyDir);
  }

  /** The single entry point. Never throws — failures come back in the result. */
  async deploy(confirmation?: Confirmation): Promise<DeployResult> {
    this.startedAt = Date.now();
    const { ui, config, profile, clock } = this.options;
    const now = clock.now();

    // -- 1-2: project + layout ------------------------------------------------
    this.project = inspectProject(this.options.cwd);
    this.layout = buildLayout({
      root: config.site.root ?? `${profile.siteRoot}/${config.site.domain}`,
      strategy: config.site.documentRootStrategy,
      ...(config.legacy.mainDir ? { legacyMainDir: config.legacy.mainDir } : {}),
      backupDirName: config.database.backupPath
        ? config.database.backupPath.replace(new RegExp(`/${config.site.domain}$`), '')
        : undefined,
    });

    this.deploymentId = buildDeploymentId(releaseStamp(now), shortToken(4));
    this.releaseId = buildReleaseId(releaseStamp(now), null);

    const executor = await this.connect();

    this.manifest = newManifest({
      deploymentId: this.deploymentId,
      project: this.project.name,
      domain: config.site.domain,
      server: profile.name,
      serverHost: profile.host,
      environment: this.options.environment,
      host: os.hostname(),
      user: profile.username,
      startedAt: now,
      sequence: this.manifestStore.nextSequence(config.site.domain),
    });
    this.machine = new DeploymentMachine(this.manifest);

    try {
      // -- 3: git ------------------------------------------------------------
      this.git = await readGitInfo(this.local, this.options.cwd);
      const sha = this.options.commit ?? this.git.sha;

      // -- 4: lock -----------------------------------------------------------
      await this.acquireLock(executor);

      // -- 5-8: panel + infrastructure discovery ------------------------------
      const panel = this.createPanelAdapter(executor);
      const availability = await panel.available();
      const infra = await this.discoverInfrastructure(panel, executor);

      if (sha) {
        this.releaseId = buildReleaseId(releaseStamp(now), sha);
        this.manifest.releaseId = this.releaseId;
        this.manifest.gitSha = sha;
      }
      this.manifest.gitBranch = this.git.branch;
      this.manifest.sequence = this.manifestStore.nextSequence(config.site.domain);

      // -- 9-10: php + env validation ---------------------------------------
      await this.validatePhp(executor);
      const envValidation = await this.validateEnvironment(executor);

      // -- 11: build plan ----------------------------------------------------
      const buildStagePlan = planBuild(this.project, config);
      const artisanFactory = new ArtisanCommandFactory(this.project, {
        releasePath: this.layout.appDir,
        phpBinary: this.phpBinary(),
      });
      const cachePlan = planCaches(artisanFactory);
      const seeder = decideSeeders({
        config: config.seeders,
        ...(this.options.seed !== undefined ? { cliSeed: this.options.seed } : {}),
        cliNoSeed: this.options.noSeed,
        isProduction: this.isProduction(),
        isFirstDeploy: infra.firstDeploy,
        nonInteractive: this.options.yes,
      });

      const currentRelease = await readCurrentRelease(executor, this.layout);
      const pendingMigrations = await this.countPendingMigrations(executor, config);

      const plan = buildPlan({
        project: this.project,
        config,
        profile,
        layout: this.layout,
        releaseId: this.releaseId,
        gitSha: sha,
        gitBranch: this.git.branch,
        buildPlan: buildStagePlan,
        cachePlan,
        seeder,
        migrationPlan: config.deployment.migrations
          ? buildMigrationPlan({
              mode: 'deploy',
              force: true,
              confirmedProduction: false,
              isProduction: this.isProduction(),
            })
          : null,
        pendingMigrations,
        infrastructure: infra,
        panelMode: availability.mode === 'api' ? 'aaPanel (API)' : availability.mode === 'ssh' ? 'aaPanel (SSH)' : 'unavailable',
        healthCheck: config.healthCheck,
        options: {
          skipBuild: this.options.skipBuild,
          skipMigrations: this.options.skipMigrations,
          seed: seeder.enabled,
          noProvision: this.options.noProvision,
        },
      });

      this.machine.advance({ to: 'VALIDATED', step: 'validate', detail: `${this.git ? describeGit(this.git) : 'no git'}`, at: clock.now() });

      // -- plan output -------------------------------------------------------
      if (this.options.planOnly) {
        ui.block(renderPlan(plan).split('\n'));
        return this.finish({
          success: true,
          plan,
          renderedPlan: renderPlan(plan),
        });
      }

      if (this.options.dryRun) {
        ui.section('Plan');
        ui.block(renderPlan(plan).split('\n'));
        ui.advisory('Dry run: no changes were made to the server.');
        return this.finish({ success: true, plan, renderedPlan: renderPlan(plan) });
      }

      // -- confirmation ------------------------------------------------------
      if (!this.options.yes && confirmation) {
        const proceed = await confirmation.confirmPlan(plan, {
          database: config.database.name ?? slugify(this.project.name),
          environment: this.options.environment,
          pending: pendingMigrations,
          release: this.releaseId,
          destructive: seeder.enabled || this.isProduction(),
        });
        if (!proceed) throw new UserAbortError('Deployment cancelled.');
      }

      // -- 11: build ---------------------------------------------------------
      if (!this.options.skipBuild && config.deployment.build) {
        ui.section('Build');
        await this.runBuild(buildStagePlan);
        this.machine.advance({ to: 'BUILT', step: 'build', at: clock.now() });
      } else {
        this.machine.skip('build', 'skipped by --skip-build', clock.now(), 'BUILT');
        ui.section('Build');
        ui.warn('Build skipped', '--skip-build');
      }

      // -- 12: package -------------------------------------------------------
      ui.section('Package');
      const archive = await this.runPackager();
      this.machine.advance({ to: 'PACKAGED', step: 'package', detail: `${archive.humanSize}, ${archive.fileCount} entries`, at: clock.now() });

      // -- 13: upload -------------------------------------------------------
      ui.section('Upload');
      await this.uploadArchive(executor, archive);
      this.machine.advance({ to: 'UPLOADED', step: 'upload', detail: archive.humanSize, at: clock.now() });

      // -- 14: extract + configure ------------------------------------------
      ui.section('Release');
      await this.prepareRelease(executor);
      this.machine.advance({ to: 'EXTRACTED', step: 'extract', at: clock.now() });

      ui.section('Configuration');
      await this.configureRelease(executor, config, envValidation);
      this.machine.advance({ to: 'CONFIGURED', step: 'configure', at: clock.now() });

      // -- 19-20: backup + migrations ---------------------------------------
      let backupPath: string | undefined;
      if (
        config.deployment.backupDatabaseBeforeMigration &&
        config.deployment.migrations &&
        !this.options.skipMigrations
      ) {
        ui.section('Database');
        backupPath = await this.backupDatabase(executor, config);
      }

      if (config.deployment.migrations && !this.options.skipMigrations) {
        await this.runMigrations(executor, artisanFactory, config, pendingMigrations);
        this.machine.advance({ to: 'MIGRATED', step: 'migrate', at: clock.now() });
        if (this.manifest) this.manifest.migrationStatus = 'ran';
      } else {
        this.machine.skip('migrate', 'disabled', clock.now(), 'MIGRATED');
        if (this.manifest) this.manifest.migrationStatus = 'skipped';
      }

      // -- 21: seeders ------------------------------------------------------
      if (seeder.enabled) {
        ui.section('Seeders');
        for (const invocation of buildSeedInvocations(seeder, artisanFactory)) {
          await this.runArtisan(executor, invocation, `seed:${invocation.args[1] ?? 'db:seed'}`);
        }
        if (this.manifest) this.manifest.seedStatus = 'ran';
      } else if (this.manifest) {
        this.manifest.seedStatus = 'skipped';
      }

      // -- 22: optimize -----------------------------------------------------
      if (config.deployment.optimize) {
        ui.section('Optimize');
        for (const step of cachePlan.steps) {
          await this.runArtisan(executor, step.invocation, step.label);
        }
      }
      this.machine.advance({ to: 'OPTIMIZED', step: 'optimize', at: clock.now() });

      // -- 23-24: workers + scheduler --------------------------------------
      ui.section('Workers');
      await this.configureWorkers(executor, config);
      await this.configureScheduler(executor, config);

      // -- 25: candidate health check --------------------------------------
      if (healthChecksEnabled(config)) {
        ui.section('Verification');
        const candidate = await this.checkCandidate(executor, config);
        if (candidate.status === 'UNHEALTHY') {
          throw new AppError('The candidate release failed its health check and was not activated.', {
            liveAffected: false,
            remediation: [
              'The current production release is unchanged.',
              ...candidate.results.filter((r) => r.status === 'fail').flatMap((r) => r.remediation ?? []),
            ],
            details: { checks: candidate.results.map((r) => `${r.name}: ${r.message}`) },
          });
        }
      }

      // -- 26: activate -----------------------------------------------------
      await this.activateRelease(executor);
      this.activated = true;
      if (this.manifest) this.manifest.activated = true;
      this.machine.advance({ to: 'ACTIVATED', step: 'activate', at: clock.now() });

      // Let opcache / the web server settle before probing.
      await sleep(config.deployment.activationSettleSeconds * 1000);

      // -- 27: restart workers ---------------------------------------------
      await this.restartWorkers(executor, config);

      // -- 28: live health check -------------------------------------------
      let health: HealthReport | undefined;
      if (healthChecksEnabled(config)) {
        health = await this.checkLive(executor, config);
        if (this.manifest) this.manifest.healthStatus = health.status === 'UNHEALTHY' ? 'failed' : 'healthy';
        this.machine.advance({ to: 'VERIFIED', step: 'verify', at: clock.now() });
      } else {
        this.machine.skip('verify', 'health check disabled', clock.now(), 'VERIFIED');
      }

      // -- 29: cleanup ------------------------------------------------------
      ui.section('Cleanup');
      await this.cleanup(executor, config, archive.archivePath);

      this.machine.complete(clock.now());

      if (backupPath) {
        ui.status('Database backup retained', backupPath);
      }

      return this.finish({
        success: true,
        plan,
        ...(health ? { health } : {}),
        ...(backupPath ? { backupPath } : {}),
      });
    } catch (error) {
      const appError = toAppError(error);
      this.handleFailure(appError, executor, clock);
      const plan = buildPlan({
        project: this.project,
        config,
        profile,
        layout: this.layout,
        releaseId: this.releaseId,
        gitSha: this.manifest?.gitSha ?? null,
        gitBranch: this.git?.branch ?? null,
        buildPlan: planBuild(this.project, config),
        cachePlan: planCaches(new ArtisanCommandFactory(this.project)),
        seeder: decideSeeders({
          config: config.seeders,
          cliNoSeed: this.options.noSeed,
          isProduction: this.isProduction(),
          isFirstDeploy: false,
          nonInteractive: this.options.yes,
        }),
        migrationPlan: null,
        pendingMigrations: null,
        infrastructure: {
          websiteExists: null,
          databaseExists: null,
          sslEnabled: null,
          firstDeploy: false,
        },
        panelMode: 'unknown',
        healthCheck: config.healthCheck,
        options: {
          skipBuild: this.options.skipBuild,
          skipMigrations: this.options.skipMigrations,
          seed: false,
          noProvision: this.options.noProvision,
        },
      });
      return this.finish({ success: false, plan, failure: appError });
    } finally {
      await this.releaseResources();
    }
  }

  // =========================================================================
  // Stages
  // =========================================================================

  private async connect(): Promise<RemoteExecutor> {
    const { profile, ui } = this.options;
    this.remote = this.options.executorFactory
      ? this.options.executorFactory(profile, this.logger)
      : new SshExecutor({ profile, logger: this.logger });
    ui.section('Server');
    const info = await retry(
      async () => this.remote!.info(),
      {
        attempts: 3,
        onRetry: (error, attempt, delay) => {
          ui.warn(`Connection attempt ${attempt} failed; retrying in ${Math.round(delay / 1000)}s`);
          this.logger.debug('SSH connect retry.', { attempt, error: error instanceof Error ? error.message : String(error) });
        },
      },
    );
    ui.status('SSH connection established', `${info.hostname} as ${info.user}`);
    ui.info(`Server: ${profile.name} (${profile.host}:${profile.port})`);
    return this.remote;
  }

  private createPanelAdapter(executor: RemoteExecutor): PanelAdapter {
    const config = this.options.config;
    if (this.options.panelFactory) return this.options.panelFactory(executor);
    return new AaPanelAdapter({
      profile: this.options.profile,
      // --no-provision means "discover only": existence checks still work.
      config: {
        ...this.options.profile.aapanel,
        enabled: this.options.noProvision ? false : this.options.profile.aapanel.enabled,
      },
      executor,
      logger: this.logger,
    });
  }

  private async discoverInfrastructure(
    panel: PanelAdapter,
    executor: RemoteExecutor,
  ): Promise<{ websiteExists: boolean | null; databaseExists: boolean | null; sslEnabled: boolean | null; firstDeploy: boolean }> {
    const { config, ui } = this.options;
    ui.section('Infrastructure');

    const availability = await panel.available();
    if (!availability.available) {
      ui.warn('aaPanel unavailable', availability.reason);
      for (const line of availability.remediation ?? []) ui.detail(line);
    } else {
      ui.status('aaPanel connected', availability.mode === 'api' ? 'API' : 'SSH fallback');
    }

    // Website
    let websiteExists: boolean | null = null;
    try {
      websiteExists = await panel.websiteExists(config.site.domain);
    } catch (error) {
      ui.warn('Could not determine whether the website exists', toAppError(error).message);
    }

    const currentRelease = websiteExists ? await readCurrentRelease(executor, this.layout) : null;
    const firstDeploy = currentRelease === null;

    if (this.options.noProvision) {
      ui.status('Provisioning disabled', '--no-provision; expecting existing infrastructure');
      if (websiteExists === false) {
        ui.warn(
          `Website ${config.site.domain} does not exist but --no-provision was passed.`,
          'Create it in aaPanel, or re-run without --no-provision.',
        );
      }
      return { websiteExists, databaseExists: null, sslEnabled: null, firstDeploy };
    }

    // Provision the website (idempotent).
    if (!this.options.profile.aapanel.enabled) {
      ui.warn('aaPanel provisioning is disabled for this server profile.');
    } else {
      const root = this.layout.root;
      const result = await ensureWebsite(panel, {
        domain: config.site.domain,
        root,
        ...(config.site.phpVersion ? { phpVersion: config.site.phpVersion } : {}),
      });
      if (result.created) ui.action('Created website', config.site.domain);
      else ui.status('Website exists', config.site.domain);
      websiteExists = true;

      // Point the web server at the right document root.
      const desired = this.layout.documentRoot;
      const web = new WebServerProvider(executor);
      const rootCheck = await web.checkDocumentRoot(config.site.domain, desired);
      if (!rootCheck.ok && rootCheck.actual !== null) {
        ui.warn('Document root mismatch', rootCheck.detail);
        await panel.updateSiteConfig({ domain: config.site.domain, documentRoot: desired });
        await web.reload();
        ui.status('Document root updated', desired);
      }

      // Database (idempotent).
      const dbName = config.database.name ?? slugify(this.project.name);
      if (config.database.createIfMissing) {
        const existing = await panel.databaseExists(dbName);
        ui.status(existing ? 'Database exists' : 'Database will be created', dbName);
      }
    }

    // SSL
    let sslEnabled: boolean | null = null;
    if (config.ssl.enabled) {
      const status = await panel.getSslStatus(config.site.domain);
      sslEnabled = status.enabled;
      if (status.enabled) {
        ui.status('SSL enabled', config.site.domain);
      } else if (this.options.noProvision) {
        ui.warn('SSL is enabled in config but no certificate exists.', 'Issue one: laravel-deploy ssl');
      }
    }

    return { websiteExists, databaseExists: null, sslEnabled, firstDeploy };
  }

  private async validatePhp(executor: RemoteExecutor): Promise<void> {
    const { config, ui } = this.options;
    const required = this.project.phpRequirement;
    const result = await executor.exec(`${this.phpBinary()} -v 2>&1 | head -1`, { allowFailure: true });
    const remoteVersion = parsePhpVersion(result.stdout) ?? result.stdout.trim();
    ui.info(`Remote PHP: ${remoteVersion || 'unknown'}`);

    if (!required || !config.php.enforceVersion) return;

    const requiredMajorMinor = parseVersionConstraint(required);
    const remoteMajorMinor = remoteVersion ? `${remoteVersion.split('.').slice(0, 2).join('.')}` : null;

    if (requiredMajorMinor && remoteMajorMinor && compareVersions(remoteMajorMinor, requiredMajorMinor) < 0) {
      const message = `Application requires PHP >= ${requiredMajorMinor} but the server has PHP ${remoteVersion}.`;
      if (this.options.force) {
        ui.warn(message, 'continuing because --force was passed');
        return;
      }
      throw new AppError(message, {
        liveAffected: false,
        remediation: [
          `Set the PHP version in aaPanel for ${config.site.domain}, or set site.phpVersion.`,
          'aaPanel installs additional PHP versions under /www/server/php.',
          'Or re-run with --force to deploy anyway.',
        ],
      });
    }
  }

  private async validateEnvironment(
    executor: RemoteExecutor,
  ): Promise<{ present: string[]; missing: string[]; warnings: string[]; blocking: boolean }> {
    const { config, ui } = this.options;
    const envContents = await this.readRemoteEnv(executor);
    const examplePath = path.join(this.options.cwd, '.env.example');
    const exampleKeys = Object.keys(readEnvFile(examplePath) ?? {});

    const result = validateEnv({
      remoteEnv: envContents ? parseEnv(envContents) : null,
      exampleKeys,
      configUsages: [],
      policy: {
        required: config.envValidation.required,
        optional: config.envValidation.optional,
        blockOnMissing: config.envValidation.blockOnMissing,
      },
    });

    if (result.missing.length > 0) {
      ui.warn(`Missing environment variables: ${result.missing.join(', ')}`, 'values are never printed');
      if (result.blocking && !this.options.force) {
        throw new AppError('Required environment variables are missing on the server.', {
          liveAffected: false,
          remediation: [
            'Add the missing variables to the server .env.',
            'Or set envValidation.blockOnMissing = false.',
          ],
        });
      }
    }
    for (const warning of result.warnings.slice(0, 5)) {
      ui.info(`Optional variable not set: ${warning}`);
    }
    return result;
  }

  private async runBuild(buildPlan: ReturnType<typeof planBuild>): Promise<void> {
    const { config, ui } = this.options;
    const builder = new Builder({
      executor: this.local,
      project: this.project,
      config,
      logger: this.logger,
      onStep: (step) => ui.command(step.command, step.label),
      onStepFinish: (step, result) => {
        if (result.exitCode === 0) ui.ok(step.label, `${Math.round(result.durationMs / 100) / 10}s`);
      },
    });
    await builder.run(buildPlan);
  }

  private async runPackager() {
    const { config, ui, paths } = this.options;
    const packager = new Packager({
      projectRoot: this.options.cwd,
      config: config.packaging,
      ...(config.packaging.tempDir ? { tempDir: config.packaging.tempDir } : {}),
      tempDir: config.packaging.tempDir ?? paths.cacheDir,
    });
    const result = await packager.create(this.releaseId);
    ui.status('Release packaged', `${result.humanSize}, ${result.fileCount} entries`);
    return result;
  }

  private async uploadArchive(executor: RemoteExecutor, archive: { archivePath: string; bytes: number; humanSize: string }) {
    const { config, ui } = this.options;
    const uploader =
      this.options.uploader ??
      new SftpUploader({
        profile: this.options.profile,
        logger: this.logger,
        attempts: 3,
      });
    const remotePath = incomingArchivePath(this.layout, this.releaseId, config.packaging.format);

    await retry(
      async () => {
        ui.startSpinner(`Uploading ${archive.humanSize}`);
        await this.prepareIncomingDir(executor);
        const result = await uploader.upload({
          localPath: archive.archivePath,
          remotePath,
          timeoutMs: config.timeouts.upload,
        });
        ui.stopSpinner({ ok: true, text: `Uploaded ${result.humanSize} (${result.attempts} attempt${result.attempts === 1 ? '' : 's'})` });
        return result;
      },
      {
        attempts: 3,
        onRetry: (_error, attempt, delay) => {
          ui.stopSpinner({ ok: false, text: 'Upload failed' });
          ui.warn(`Upload attempt ${attempt} failed; retrying in ${Math.round(delay / 1000)}s`);
        },
      },
    );

    // Verify the transfer landed intact before extracting anything.
    const remoteSize = await uploader.stat(remotePath);
    if (remoteSize !== archive.bytes) {
      throw new TransportLike(
        `Uploaded archive size mismatch: expected ${archive.bytes} bytes, server has ${remoteSize ?? 0}.`,
      );
    }
  }

  private async prepareIncomingDir(executor: RemoteExecutor): Promise<void> {
    await executor.exec(`mkdir -p ${q(this.layout.incomingDir)} ${q(this.layout.deployDir)}`, {
      label: 'prepare upload directory',
    });
  }

  private async prepareRelease(executor: RemoteExecutor): Promise<void> {
    const { config, ui } = this.options;
    await this.uploadScript(executor, 'prepare-release.sh');

    const script = [
      'set -Eeuo pipefail',
      `export LD_ROOT=${q(this.layout.root)}`,
      `export LD_RELEASE=${q(this.releaseId)}`,
      `export LD_ARCHIVE=${q(incomingArchivePath(this.layout, this.releaseId, config.packaging.format))}`,
      // prepare-release.sh picks tar or unzip from this. Without it the script
      // silently defaulted to tar.gz and a zip deployment died at extraction.
      `export LD_FORMAT=${q(config.packaging.format)}`,
      `export LD_STRATEGY=${q(this.layout.strategy)}`,
      `export LD_MAIN_DIR=${q(config.legacy.mainDir)}`,
      `export LD_PHP=${q(this.phpBinary())}`,
      `bash ${q(scriptPath(this.layout, 'prepare-release.sh'))}`,
    ].join('\n');

    const result = await executor.exec(script, {
      label: 'prepare release',
      timeoutMs: 300_000,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      throw new RemoteCommandError('Failed to prepare the release on the server.', result.exitCode, {
        command: 'prepare-release.sh',
        liveAffected: false,
        details: { stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-1000) },
        remediation: [
          'The live deployment was not changed.',
          `Inspect the server manually: cd ${this.layout.root} && ls -la`,
        ],
      });
    }

    // Verify the release contents (SPEC §17).
    const releaseDir = this.releaseDirectory();
    const missing = await this.verifyReleaseContents(executor, releaseDir);
    if (missing.length > 0) {
      throw new RemoteCommandError(
        `The extracted release is incomplete. Missing: ${missing.join(', ')}`,
        1,
        {
          liveAffected: false,
          remediation: [
            'The live deployment was not changed.',
            'Usually this means the build did not produce vendor/ or public/build/.',
          ],
        },
      );
    }
    ui.status('Release extracted', releaseDir);
  }

  private releaseDirectory(): string {
    return this.layout.strategy === 'legacy-root-copy'
      ? this.layout.appDir
      : `${this.layout.releasesDir}/${this.releaseId}`;
  }

  private async verifyReleaseContents(
    executor: RemoteExecutor,
    releaseDir: string,
  ): Promise<string[]> {
    const required = requiredReleasePaths({
      hasFrontendBuild: this.project.hasFrontendBuild,
      hasConfigDir: this.project.hasConfigDir,
    });
    const missing: string[] = [];
    for (const relative of required) {
      const result = await executor.exec(`test -e ${q(`${releaseDir}/${relative}`)}`, { allowFailure: true });
      if (result.exitCode !== 0) missing.push(relative);
    }
    return missing;
  }

  private async configureRelease(
    executor: RemoteExecutor,
    config: AppConfig,
    envValidation: { present: string[]; missing: string[] },
  ): Promise<void> {
    const { ui } = this.options;

    // .env
    await this.writeRemoteEnv(executor, config);

    // storage
    const storageLayout = planStorageLayout(this.layout.root);
    const created = await executor.exec(
      [
        'set -Eeuo pipefail',
        `mkdir -p ${[...storageLayout.requiredDirs].map((dir) => q(dir)).join(' ')}`,
        `ln -sfn ${q(storageLayout.publicStorageTarget)} ${q(`${this.releaseDirectory()}/public/storage`)}`,
      ].join('\n'),
      { label: 'link storage', allowFailure: true },
    );
    if (created.exitCode !== 0) {
      ui.warn('Could not create the public/storage link', created.stderr.trim().split('\n').pop() ?? '');
    } else {
      ui.status('storage linked', 'public/storage -> shared/storage/app/public');
    }

    // Permissions
    const web = new WebServerProvider(executor);
    const webInfo = await web.detect();
    const webUser = config.permissions.webUser ?? (config.permissions.forceWebUser ? config.permissions.webUser : webInfo.webUser);
    const plan = planPermissions({
      releasePath: this.releaseDirectory(),
      sharedPath: this.layout.sharedDir,
      webUser: webUser ?? 'www-data',
      webGroup: webInfo.webGroup,
      writableDirs: config.permissions.writable,
      dirMode: config.permissions.dirMode,
      fileMode: config.permissions.fileMode,
      chown: config.permissions.chown,
      chownShared: config.permissions.chownShared,
    });

    if (plan.empty) {
      ui.info('Permissions already correct');
    } else {
      const result = await executor.exec(plan.steps.join('\n'), {
        label: 'apply permissions',
        allowFailure: true,
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        ui.warn('Permission changes reported an error', result.stderr.trim().split('\n').pop() ?? '');
      } else {
        ui.status('Permissions applied', `${webUser}:${webInfo.webGroup}`);
      }
    }
    void envValidation;
  }

  private async writeRemoteEnv(executor: RemoteExecutor, config: AppConfig): Promise<void> {
    const { ui, secrets } = this.options;
    const current = await this.readRemoteEnv(executor);
    const dbName = config.database.name ?? slugify(this.project.name);
    const dbUser = config.database.username ?? dbName;
    const dbPassword = secrets.get(`servers.${this.options.profile.name}.database.password`) ?? generatePassword();

    const templateContents = config.env.templatePath
      ? await this.readLocalFile(config.env.templatePath)
      : undefined;
    const uploadContents = config.env.uploadPath ? await this.readLocalFile(config.env.uploadPath) : undefined;
    const exampleContents = await this.readLocalFile('.env.example');

    const plan = planEnvWrite({
      strategy: config.env.strategy,
      remoteEnv: current ? parseEnv(current) : null,
      isFirstDeploy: !current || current.trim() === '',
      domain: config.site.domain,
      database: {
        name: dbName,
        username: dbUser,
        password: dbPassword,
        host: config.database.host,
        port: config.database.port,
      },
      ...(templateContents ? { templateContents } : {}),
      ...(uploadContents ? { uploadContents } : {}),
      generateKeys: config.env.generate,
      extraValues: config.env.values,
      initialiseFromExample: config.env.initialiseFromExample,
      ...(exampleContents ? { exampleContents } : {}),
    });

    if (plan.contents === null) {
      ui.status('Server .env preserved', plan.reason);
      return;
    }

    await executor.exec(`mkdir -p ${q(this.layout.sharedDir)} && touch ${q(this.layout.envPath)}`, {
      allowFailure: true,
    });
    await executor.exec(envWriteScript(this.layout.envPath, plan.contents, '0640'), {
      label: 'write .env',
      timeoutMs: 30_000,
    });
    ui.status('Server .env written', `${plan.changedKeys.length} variable(s) changed: ${plan.changedKeys.join(', ') || 'none'}`);

    // Persist the generated DB password so future deploys reuse it.
    if (!secrets.get(`servers.${this.options.profile.name}.database.password`)) {
      secrets.set(`servers.${this.options.profile.name}.database.password`, dbPassword);
      this.logger.info('Generated and stored a database password.');
    }
  }

  private async readRemoteEnv(executor: RemoteExecutor): Promise<string | null> {
    const result = await executor.exec(`cat ${q(this.layout.envPath)} 2>/dev/null`, {
      allowFailure: true,
      timeoutMs: 15_000,
    });
    return result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout : null;
  }

  private async backupDatabase(executor: RemoteExecutor, config: AppConfig): Promise<string> {
    const { ui, clock, secrets } = this.options;
    const dbName = config.database.name ?? slugify(this.project.name);
    const dbUser = config.database.username ?? dbName;
    const password = secrets.get(`servers.${this.options.profile.name}.database.password`) ?? '';

    const mysql = new MysqlProvider({ executor, logger: this.logger });
    ui.startSpinner(`Backing up ${dbName}`);
    try {
      const result = await mysql.backup({
        database: dbName,
        backupDir: this.layout.backupsDir,
        fileName: `${dbName}-${releaseStamp(clock.now())}.sql.gz`,
        credentials: {
          username: dbUser,
          password,
          host: config.database.host,
          port: config.database.port,
        },
        timeoutMs: config.timeouts.databaseBackup,
      });
      ui.stopSpinner({ ok: true, text: `Backup created: ${result.path} (${result.humanSize})` });
      if (this.manifest) this.manifest.backupPath = result.path;
      return result.path;
    } catch (error) {
      ui.stopSpinner({ ok: false, text: 'Database backup failed' });
      throw error;
    }
  }

  private async countPendingMigrations(
    executor: RemoteExecutor,
    config: AppConfig,
  ): Promise<number | null> {
    if (!config.deployment.migrations) return null;
    const factory = new ArtisanCommandFactory(this.project, {
      releasePath: this.layout.appDir,
      phpBinary: this.phpBinary(),
    });
    const invocation = factory.status();
    const result = await executor.exec(
      [
        'set -Eeuo pipefail',
        `cd ${q(invocation.cwd ?? this.layout.appDir)}`,
        `${q(this.phpBinary())} artisan ${invocation.args.join(' ')}`,
      ].join('\n'),
      { allowFailure: true, timeoutMs: config.timeouts.artisan, label: 'migrate:status' },
    );
    if (result.exitCode !== 0) return null;
    return parseMigrateStatus(result.stdout).pending;
  }

  private async runMigrations(
    executor: RemoteExecutor,
    factory: ArtisanCommandFactory,
    config: AppConfig,
    pendingMigrations: number | null,
  ): Promise<void> {
    const { ui } = this.options;
    const invocation = factory.migrate();

    if (pendingMigrations === 0) {
      ui.status('No pending migrations');
      return;
    }
    ui.info(`Pending migrations: ${pendingMigrations ?? 'unknown'}`);
    await this.runArtisan(executor, invocation, 'migrate');
    void config;
  }

  private async runArtisan(
    executor: RemoteExecutor,
    invocation: { args: string[]; cwd?: string; critical: boolean },
    label: string,
  ): Promise<void> {
    const { config, ui } = this.options;
    const cwd = invocation.cwd ?? this.layout.appDir;
    const command = renderCommand(invocation.args, this.phpBinary());
    ui.command(command, label);

    const result = await executor.exec(
      [
        'set -Eeuo pipefail',
        `cd ${q(cwd)}`,
        // --env exists so artisan reads the shared .env through the release link.
        `${q(this.phpBinary())} artisan ${invocation.args.join(' ')}`,
      ].join('\n'),
      {
        label,
        timeoutMs: config.timeouts.artisan,
        allowFailure: true,
      },
    );

    if (result.exitCode !== 0) {
      const error = new RemoteCommandError(`laravel-deploy: ${label} failed.`, result.exitCode, {
        command,
        liveAffected: this.activated,
        details: { stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-1000) },
        remediation: [
          this.activated
            ? 'The previous release can be restored with `laravel-deploy rollback`.'
            : 'The current production release was NOT changed.',
          'Inspect the application log: laravel-deploy logs laravel',
        ],
      });
      ui.fail(`${label} failed`, command);
      throw error;
    }
    ui.ok(label, command);
  }

  private async configureWorkers(executor: RemoteExecutor, config: AppConfig): Promise<void> {
    const { ui } = this.options;
    if (!config.queue.enabled) {
      ui.info('Queue workers disabled');
      return;
    }
    const plans = planWorkers(this.project.name, config.queue);
    const manager = new SupervisorManager({ executor });
    const result = await manager.install(plans, {
      siteRoot: this.layout.root,
      phpBinary: this.phpBinary(),
      restart: true,
    });
    if (result.written.length > 0) ui.action('Installed worker programs', result.written.join(', '));
    if (result.updated.length > 0) ui.action('Updated worker programs', result.updated.join(', '));
    if (result.unchanged.length > 0) ui.info(`Worker programs unchanged: ${result.unchanged.join(', ')}`);
    if (result.written.length === 0 && result.updated.length === 0) {
      ui.status('Worker programs already correct');
    }
  }

  private async configureScheduler(executor: RemoteExecutor, config: AppConfig): Promise<void> {
    const { ui } = this.options;
    if (!config.scheduler.enabled) {
      ui.info('Scheduler disabled');
      return;
    }
    const cron = new CronManager(executor);
    const result = await cron.install({
      config: config.scheduler,
      siteRoot: this.layout.root,
      phpBinary: this.phpBinary(),
    });
    ui.status(result.reused ? 'Scheduler cron entry present' : 'Scheduler cron entry installed', result.entry);
  }

  private async restartWorkers(executor: RemoteExecutor, config: AppConfig): Promise<void> {
    if (!config.queue.enabled) return;
    const { ui } = this.options;

    // Graceful restart first: queue:restart asks workers to exit after the
    // current job, which is safer than SIGKILL.
    const factory = new ArtisanCommandFactory(this.project, {
      releasePath: this.layout.appDir,
      phpBinary: this.phpBinary(),
    });
    try {
      await this.runArtisan(executor, factory.queueRestart(), 'queue:restart');
    } catch {
      ui.warn('queue:restart failed; falling back to a supervisor restart');
    }

    const manager = new SupervisorManager({ executor });
    const names = planWorkers(this.project.name, config.queue).map((plan) => plan.programName);
    await manager.restart(names);
    ui.status('Workers restarted', names.join(', '));
  }

  private async checkCandidate(executor: RemoteExecutor, config: AppConfig): Promise<HealthReport> {
    const checker = new HealthChecker({
      executor,
      layout: this.layout,
      config: config.healthCheck,
      domain: config.site.domain,
      phpBinary: this.phpBinary(),
      appDir: this.releaseDirectory(),
      queue: config.queue,
      scheduler: config.scheduler,
      projectSlug: slugify(this.project.name),
      clock: this.options.clock,
    });
    const report = await checker.runAll({ skipHttp: true });
    this.reportChecks(report.results);
    return report;
  }

  private async checkLive(executor: RemoteExecutor, config: AppConfig): Promise<HealthReport> {
    const checker = new HealthChecker({
      executor,
      layout: this.layout,
      config: config.healthCheck,
      domain: config.site.domain,
      phpBinary: this.phpBinary(),
      queue: config.queue,
      scheduler: config.scheduler,
      projectSlug: slugify(this.project.name),
      clock: this.options.clock,
    });
    const report = await checker.runAll();
    this.reportChecks(report.results);
    return report;
  }

  private reportChecks(results: readonly CheckResult[]): void {
    for (const result of results) {
      switch (result.status) {
        case 'pass':
          this.options.ui.ok(capitalise(result.name));
          break;
        case 'warn':
          this.options.ui.warn(capitalise(result.name), result.message);
          break;
        case 'fail':
          this.options.ui.fail(capitalise(result.name), result.message);
          break;
        default:
          this.options.ui.info(`${capitalise(result.name)} — skipped`);
          break;
      }
    }
  }

  private async activateRelease(executor: RemoteExecutor): Promise<void> {
    const { config, ui } = this.options;
    await this.uploadScript(executor, 'activate-release.sh');

    const script = [
      'set -Eeuo pipefail',
      `export LD_ROOT=${q(this.layout.root)}`,
      `export LD_RELEASE=${q(this.releaseId)}`,
      `export LD_STRATEGY=${q(this.layout.strategy)}`,
      `export LD_MAIN_DIR=${q(config.legacy.mainDir)}`,
      `bash ${q(scriptPath(this.layout, 'activate-release.sh'))}`,
    ].join('\n');

    const result = await executor.exec(script, {
      label: 'activate release',
      timeoutMs: 120_000,
      allowFailure: true,
    });

    if (result.exitCode !== 0) {
      throw new RemoteCommandError('Failed to activate the new release.', result.exitCode, {
        command: 'activate-release.sh',
        liveAffected: false,
        details: { stderr: result.stderr.slice(-2000) },
        remediation: [
          'The previous release is still live.',
          'Investigate, then re-run `laravel-deploy deploy`.',
        ],
      });
    }

    const previous = await readCurrentRelease(executor, this.layout);
    void previous;
    ui.ok('Release activated', this.releaseId);
    ui.info(`Live: https://${config.site.domain}`);
  }

  private async cleanup(
    executor: RemoteExecutor,
    config: AppConfig,
    archivePath: string,
  ): Promise<void> {
    const { ui } = this.options;

    // Remove the local archive and the remote incoming copy.
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    await executor.exec(
      `rm -f ${q(incomingArchivePath(this.layout, this.releaseId, config.packaging.format))}`,
      { allowFailure: true },
    );
    ui.info('Upload artifacts removed');

    // Retention — only after a successful deploy.
    const releases = await listReleases(executor, this.layout);
    if (this.layout.strategy !== 'legacy-root-copy') {
      const current = this.releaseId;
      const plan = planRetention({
        releases,
        currentRelease: current,
        keepReleases: config.deployment.keepReleases,
      });
      if (plan.delete.length > 0) {
        const deleted = await pruneReleases(executor, this.layout, plan.delete);
        ui.status(`Removed ${deleted.length} old release(s)`, deleted.join(', '));
      } else {
        ui.info(`Keeping ${plan.keep.length} release(s)`);
      }
    }

    if (config.database.keepBackups > 0) {
      const pruned = await pruneBackups(executor, this.layout, config.database.keepBackups);
      if (pruned.length > 0) ui.info(`Pruned ${pruned.length} old database backup(s)`);
    }
  }

  // =========================================================================
  // Support
  // =========================================================================

  private async acquireLock(executor: RemoteExecutor): Promise<void> {
    const lock = new DeploymentLock(executor);
    await lock.acquire({
      lockFile: this.layout.lockFile,
      deploymentId: this.deploymentId,
      startedAt: humanTimestamp(this.options.clock.now()),
      host: os.hostname(),
      user: this.options.profile.username,
      force: this.options.forceUnlock,
    });
    this.lockAcquired = true;
    this.options.ui.status('Deployment lock acquired', this.deploymentId);
  }

  private async uploadScript(executor: RemoteExecutor, name: string): Promise<void> {
    const remote = scriptPath(this.layout, name);
    const contents = await this.readScript(name);
    if (contents === null) {
      throw new AppError(`Remote script "${name}" is missing from the CLI installation.`, {
        remediation: ['Reinstall laravel-deploy: npm install -g laravel-deploy'],
      });
    }
    await executor.exec(
      [
        'set -Eeuo pipefail',
        `mkdir -p ${q(`${this.layout.deployDir}/scripts`)}`,
        `cat > ${q(remote)} <<'LDSCRIPT'`,
        contents.replace(/\n?$/, ''),
        'LDSCRIPT',
        `chmod 0700 ${q(remote)}`,
      ].join('\n'),
      { label: `upload ${name}` },
    );
  }

  /** Read a bundled remote script, from dist/ or the source tree. */
  private async readScript(name: string): Promise<string | null> {
    if (this.options.scriptsDir) {
      return this.readLocalFile(path.join(this.options.scriptsDir, name));
    }
    const contents = await this.readLocalFile(path.join(remoteScriptsDir(), name));
    if (contents !== null) return contents;
    return this.readLocalFile(path.join(process.cwd(), 'scripts', name));
  }

  private async readLocalFile(relative: string): Promise<string | null> {
    try {
      return await fs.readFile(path.isAbsolute(relative) ? relative : path.join(this.options.cwd, relative), 'utf8');
    } catch {
      return null;
    }
  }

  private phpBinary(): string {
    return this.options.config.php.remoteBinary ?? this.options.config.php.binary;
  }

  private isProduction(): boolean {
    return this.options.environment === 'production' || this.options.config.site.domain.includes('prod');
  }

  private async releaseResources(): Promise<void> {
    if (this.remote && this.lockAcquired && this.manifest) {
      const lock = new DeploymentLock(this.remote);
      await lock.release(this.layout.lockFile, this.deploymentId);
    }
    await this.remote?.close().catch(() => undefined);
  }

  private handleFailure(error: AppError, executor: RemoteExecutor | null, clock: Clock): void {
    const { ui } = this.options;
    this.machine?.fail(error.command ?? 'deploy', error, clock.now());

    // A failed pre-activation deploy must leave the live site alone, but the
    // half-built release can be cleaned up (SPEC §34).
    if (!this.activated && executor && !this.options.dryRun) {
      cleanupFailedRelease(
        executor,
        this.layout,
        this.releaseId,
        this.activated ? this.releaseId : null,
      ).catch(() => undefined);
    }

    ui.section('Failure');
    ui.fail(error.message);
    if (error.command) ui.detail(`Command: ${error.command}`);
    if (error.details?.stderr) ui.detail(String(error.details.stderr).slice(-500));
    ui.info(this.activated ? 'The live release WAS changed.' : 'The live deployment was NOT changed.');
    for (const line of error.remediation) ui.detail(line);

    this.manifestStore.save(this.manifest as DeploymentManifest);
  }

  private finish(input: {
    success: boolean;
    plan: DeploymentPlan;
    renderedPlan?: string;
    health?: HealthReport;
    backupPath?: string;
    failure?: AppError;
  }): DeployResult {
    const durationMs = Date.now() - this.startedAt;
    if (this.manifest) {
      this.manifest.durationMs = durationMs;
      if (input.success && this.manifest.status === 'RUNNING') {
        this.manifest.status = 'SUCCESS';
      }
      this.manifestStore.save(this.manifest);
    }

    this.options.ui.summary(
      input.success ? 'Deployment successful' : 'Deployment failed',
      [
        `Deployment: ${this.deploymentId}`,
        `Release:    ${this.releaseId}`,
        `Domain:     ${this.options.config.site.domain}`,
        `Server:     ${this.options.profile.name}`,
        ...(this.manifest?.gitSha ? [`Git:        ${this.manifest.gitSha.slice(0, 7)}`] : []),
        ...(input.backupPath ? [`Backup:     ${input.backupPath}`] : []),
        `Duration:   ${formatDuration(durationMs)}`,
        ...(input.health ? [`Health:     ${input.health.status}`] : []),
      ],
    );

    return {
      success: input.success,
      deploymentId: this.deploymentId,
      releaseId: this.releaseId,
      domain: this.options.config.site.domain,
      server: this.options.profile.name,
      gitSha: this.manifest?.gitSha ?? null,
      manifest: this.manifest as DeploymentManifest,
      plan: input.plan,
      ...(input.renderedPlan ? { renderedPlan: input.renderedPlan } : {}),
      ...(input.health ? { health: input.health } : {}),
      ...(input.backupPath ? { backupPath: input.backupPath } : {}),
      durationMs,
      ...(input.failure ? { failure: input.failure } : {}),
    };
  }
}

/** Local error type for transport-adjacent failures inside the orchestrator. */
class TransportLike extends AppError {}

/** Compare dotted versions. */
export { compareVersions, parseVersionConstraint } from '../../utils/versions.js';

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void assertRemotePath;
void SafetyError;
void renderEnv;
void os;