/**
 * Deployment plan.
 *
 * Built *before* anything on the server changes, so `deploy --plan` and the
 * `--dry-run` preview are the same object the orchestrator then executes
 * (SPEC §61).
 */

import type { ProjectInfo } from '../../laravel/detector.js';
import type { AppConfig, ServerProfile } from '../config/schema.js';
import type { SiteLayout } from '../release/layout.js';
import type { BuildPlan } from '../../build/builder.js';
import type { SeederDecision } from '../../laravel/seeders.js';
import { describeSeeders } from '../../laravel/seeders.js';
import type { CachePlan } from '../../laravel/cache.js';
import type { MigrationPlan } from '../../laravel/migrations.js';
import type { HealthCheckConfig } from '../config/schema.js';

export type PlanAction = 'create' | 'reuse' | 'update' | 'skip';

export interface PlanItem {
  label: string;
  action: PlanAction;
  detail?: string;
}

export interface PlanSection {
  title: string;
  items: PlanItem[];
}

export interface DeploymentPlan {
  project: {
    name: string;
    laravel: string | null;
    php: string | null;
    git: string | null;
    branch: string | null;
    packageManager: string | null;
  };
  server: {
    name: string;
    host: string;
    user: string;
    panel: string;
  };
  infrastructure: PlanSection;
  build: PlanSection;
  application: PlanSection;
  workers: PlanSection;
  database: PlanSection;
  verification: PlanSection;
  release: {
    id: string;
    path: string;
    documentRoot: string;
  };
  /** One-line summary for the concise (non --plan) output. */
  summary: string[];
}

export interface PlanInput {
  project: ProjectInfo;
  config: AppConfig;
  profile: ServerProfile;
  layout: SiteLayout;
  releaseId: string;
  gitSha: string | null;
  gitBranch: string | null;
  buildPlan: BuildPlan;
  cachePlan: CachePlan;
  seeder: SeederDecision;
  migrationPlan: MigrationPlan | null;
  pendingMigrations: number | null;
  infrastructure: {
    websiteExists: boolean | null;
    databaseExists: boolean | null;
    sslEnabled: boolean | null;
    firstDeploy: boolean;
  };
  panelMode: string;
  healthCheck: HealthCheckConfig;
  /** Deploy-time overrides that change the plan. */
  options: {
    skipBuild: boolean;
    skipMigrations: boolean;
    seed: boolean;
    noProvision: boolean;
  };
}

export function buildPlan(input: PlanInput): DeploymentPlan {
  const { config, layout } = input;
  const first = input.infrastructure.firstDeploy;

  const infrastructure: PlanSection = {
    title: 'Infrastructure',
    items: [
      {
        label: 'Website',
        // --no-provision must never plan a creation the deploy will refuse.
        action: input.options.noProvision
          ? 'skip'
          : itemAction(input.infrastructure.websiteExists, first),
        detail: input.options.noProvision
          ? 'not modified (--no-provision)'
          : config.site.domain,
      },
      {
        label: 'Database',
        action: input.options.noProvision
          ? 'skip'
          : itemAction(input.infrastructure.databaseExists, config.database.createIfMissing),
        detail: input.options.noProvision
          ? 'not modified (--no-provision)'
          : config.database.name ?? '(derived from project)',
      },
      {
        label: 'SSL',
        action: config.ssl.enabled
          ? input.infrastructure.sslEnabled
            ? 'reuse'
            : input.options.noProvision
              ? 'skip'
              : 'create'
          : 'skip',
        detail: config.ssl.enabled ? config.ssl.provider : 'not enabled',
      },
      {
        label: 'PHP version',
        action: config.site.phpVersion ? 'update' : 'skip',
        detail: config.site.phpVersion ?? '(keep current)',
      },
    ],
  };

  const buildSteps = input.options.skipBuild
    ? [{ label: 'Local build', action: 'skip' as PlanAction, detail: 'skipped by --skip-build' }]
    : input.buildPlan.steps.map((step) => ({
        label: step.label,
        action: (step.skipReason ? 'skip' : 'create') as PlanAction,
        detail: step.skipReason ?? step.command,
      }));

  const build: PlanSection = { title: 'Build', items: buildSteps };

  const application: PlanSection = {
    title: 'Application',
    items: [
      { label: 'Release', action: 'create', detail: input.releaseId },
      {
        label: 'Document root',
        action: 'update',
        detail: layout.documentRoot,
      },
      {
        label: 'Migrations',
        action:
          !config.deployment.migrations || input.options.skipMigrations
            ? 'skip'
            : 'create',
        detail:
          !config.deployment.migrations
            ? 'disabled in configuration'
            : input.options.skipMigrations
              ? 'skipped by --skip-migrations'
              : input.pendingMigrations === null
                ? 'unknown count'
                : `${input.pendingMigrations} pending`,
      },
      {
        label: 'Seeders',
        action: input.seeder.enabled ? 'create' : 'skip',
        detail: `${describeSeeders(input.seeder)} — ${input.seeder.reason}`,
      },
      {
        label: 'Optimize',
        action: config.deployment.optimize ? 'create' : 'skip',
        detail: input.cachePlan.display.join(' && '),
      },
    ],
  };

  const workers: PlanSection = {
    title: 'Workers',
    items: [
      {
        label: 'Queue',
        action: config.queue.enabled ? 'update' : 'skip',
        detail: config.queue.enabled
          ? `${config.queue.workers} worker(s) on ${config.queue.connection ?? 'default'}`
          : 'not enabled',
      },
      {
        label: 'Scheduler',
        action: config.scheduler.enabled ? 'create' : 'skip',
        detail: config.scheduler.enabled
          ? `cron "${config.scheduler.schedule}"`
          : 'not enabled',
      },
      {
        label: 'Keep releases',
        action: 'skip',
        detail: `${config.deployment.keepReleases} after a successful deploy`,
      },
    ],
  };

  const database: PlanSection = {
    title: 'Database',
    items: [
      {
        label: 'Backup before migrating',
        action:
          config.deployment.backupDatabaseBeforeMigration && config.deployment.migrations
            ? 'create'
            : 'skip',
        detail: config.deployment.backupDatabaseBeforeMigration
          ? `mysqldump -> ${layout.backupsDir}`
          : 'disabled',
      },
    ],
  };

  const verificationItems: PlanItem[] = [];
  if (input.healthCheck.http) verificationItems.push({ label: 'HTTP', action: 'skip', detail: `https://${config.site.domain}` });
  if (input.healthCheck.artisan) verificationItems.push({ label: 'Laravel', action: 'skip', detail: 'artisan about' });
  if (input.healthCheck.database) verificationItems.push({ label: 'Database', action: 'skip', detail: 'migrate:status' });
  if (input.healthCheck.storage) verificationItems.push({ label: 'Storage', action: 'skip', detail: 'shared storage link' });
  if (config.queue.enabled) verificationItems.push({ label: 'Queue', action: 'skip', detail: 'supervisor workers' });
  if (config.scheduler.enabled) verificationItems.push({ label: 'Scheduler', action: 'skip', detail: 'cron entry' });
  if (input.healthCheck.ssl) verificationItems.push({ label: 'SSL', action: 'skip', detail: 'HTTPS probe' });

  const verification: PlanSection = { title: 'Verification', items: verificationItems };

  const laravelVersion = input.project.laravelRequirement ?? (input.project.laravelMajor ? `^${input.project.laravelMajor}.0` : null);

  return {
    project: {
      name: input.project.name,
      laravel: laravelVersion,
      php: input.project.phpRequirement,
      git: input.gitSha,
      branch: input.gitBranch,
      packageManager: input.buildPlan.packageManager ?? 'none',
    },
    server: {
      name: input.profile.name,
      host: `${input.profile.host}:${input.profile.port}`,
      user: input.profile.username,
      panel: input.panelMode,
    },
    infrastructure,
    build,
    application,
    workers,
    database,
    verification,
    release: {
      id: input.releaseId,
      path: input.layout.strategy === 'legacy-root-copy' ? layout.appDir : `${layout.releasesDir}/${input.releaseId}`,
      documentRoot: layout.documentRoot,
    },
    summary: buildSummary(input, infrastructure, application),
  };
}

function itemAction(exists: boolean | null, expected: boolean): PlanAction {
  if (exists === null) return 'skip';
  if (exists) return 'reuse';
  return expected ? 'create' : 'skip';
}

/** The concise version shown in normal mode. */
function buildSummary(input: PlanInput, infrastructure: PlanSection, application: PlanSection): string[] {
  const lines: string[] = [];
  const domain = input.config.site.domain;

  lines.push(`${input.gitSha ? `${input.gitSha.slice(0, 7)} ` : ''}-> ${domain} on ${input.profile.name}`);

  const creates = infrastructure.items.filter((item) => item.action === 'create');
  if (creates.length > 0) {
    lines.push(`will create: ${creates.map((item) => item.label.toLowerCase()).join(', ')}`);
  }

  if (!input.options.skipBuild) {
    const active = input.buildPlan.active.length;
    lines.push(`build: ${active} command${active === 1 ? '' : 's'}`);
  }

  const migrationItem = application.items.find((item) => item.label === 'Migrations');
  if (migrationItem?.action === 'create') {
    lines.push(`migrations: ${migrationItem.detail}`);
  }

  lines.push(`release: ${input.releaseId}`);
  return lines;
}

/** Render the full plan as text. */
export function renderPlan(plan: DeploymentPlan): string {
  const out: string[] = [];
  const title = (text: string) => out.push(`\n${text}\n${'─'.repeat(text.length)}`);

  title('Project');
  out.push(`  Laravel      ${plan.project.laravel ?? 'unknown'}`);
  out.push(`  PHP          ${plan.project.php ?? 'unspecified'}`);
  out.push(`  Git          ${plan.project.branch ?? 'n/a'} @ ${(plan.project.git ?? 'n/a').slice(0, 7)}`);
  out.push(`  Packages     ${plan.project.packageManager}`);

  title('Server');
  out.push(`  Profile      ${plan.server.name}`);
  out.push(`  Host         ${plan.server.host}`);
  out.push(`  User         ${plan.server.user}`);
  out.push(`  Panel        ${plan.server.panel}`);

  for (const section of [plan.infrastructure, plan.build, plan.application, plan.workers, plan.database, plan.verification]) {
    title(section.title);
    for (const item of section.items) {
      const marker =
        item.action === 'create'
          ? 'create'
          : item.action === 'reuse'
            ? 'reuse'
            : item.action === 'update'
              ? 'update'
              : 'skip';
      out.push(`  ${marker.padEnd(7)} ${item.label.padEnd(28)} ${item.detail ?? ''}`.trimEnd());
    }
  }

  title('Release');
  out.push(`  Id           ${plan.release.id}`);
  out.push(`  Path         ${plan.release.path}`);
  out.push(`  Doc root     ${plan.release.documentRoot}`);

  return out.join('\n');
}