/**
 * `laravel-deploy deploy` — the primary command.
 */

import { Command } from 'commander';
import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import { DeploymentOrchestrator, type DeployResult } from '../../core/deployment/orchestrator.js';
import { inspectProject } from '../../laravel/detector.js';
import { redact } from '../../utils/redact.js';

export interface DeployFlags extends GlobalOptions {
  dryRun?: boolean;
  plan?: boolean;
  force?: boolean;
  forceUnlock?: boolean;
  skipBuild?: boolean;
  skipMigrations?: boolean;
  seed?: boolean;
  noSeed?: boolean;
  noProvision?: boolean;
  branch?: string;
  commit?: string;
}

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy')
    .description('Deploy the Laravel application to its configured server')
    .option('--dry-run', 'show what would happen without changing the server')
    .option('--plan', 'print the full deployment plan and exit')
    .option('-y, --yes', 'use configured defaults and skip prompts')
    .option('--force', 'continue despite non-dangerous validation warnings')
    .option('--force-unlock', 'break a stale deployment lock (asks for confirmation)')
    .option('--skip-build', 'skip the local build')
    .option('--skip-migrations', 'skip database migrations')
    .option('--seed', 'run the configured seeders')
    .option('--no-seed', 'explicitly disable seeders')
    .option('--no-provision', 'never create or modify infrastructure')
    .option('--env <environment>', 'use .laravel-deploy.<environment>.json')
    .option('--config <path>', 'use an explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--branch <branch>', 'record the branch being deployed')
    .option('--commit <sha>', 'record the commit being deployed')
    .option('--json', 'machine-readable output')
    .option('-v, --verbose', 'verbose output')
    .option('--cwd <path>', 'project directory')
    .action(async (flags: DeployFlags) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const orchestrator = new DeploymentOrchestrator({
            cwd: ctx.paths.projectRoot,
            paths: ctx.paths,
            config: ctx.config,
            profile: ctx.profile,
            secrets: ctx.secrets,
            ui: ctx.ui,
            clock: ctx.clock,
            logger: ctx.logger,
            dryRun: Boolean(flags.dryRun),
            planOnly: Boolean(flags.plan),
            yes: Boolean(flags.yes),
            force: Boolean(flags.force),
            forceUnlock: Boolean(flags.forceUnlock),
            skipBuild: Boolean(flags.skipBuild),
            skipMigrations: Boolean(flags.skipMigrations),
            ...(flags.seed !== undefined ? { seed: flags.seed } : {}),
            noSeed: Boolean(flags.noSeed),
            noProvision: Boolean(flags.noProvision),
            verbose: Boolean(flags.verbose),
            environment: flags.env ?? 'production',
            ...(flags.server ? { serverOverride: flags.server } : {}),
            ...(flags.branch ? { branch: flags.branch } : {}),
            ...(flags.commit ? { commit: flags.commit } : {}),
          });

          // --force-unlock demands an explicit acknowledgement.
          let confirmation = ctx.confirmation();
          if (flags.forceUnlock && !flags.yes) {
            const { confirm } = await import('@inquirer/prompts');
            const ok = await confirm({
              message: 'Break the existing deployment lock and continue?',
              default: false,
            });
            if (!ok) {
              ctx.ui.warn('Cancelled.', 'A deployment is already running for this site.');
              return 1;
            }
            confirmation = {
              confirmPlan: () => confirmation.confirmPlan({} as never, {} as never),
              confirmDestructive: (reason, text) => confirmation.confirmDestructive(reason, text),
            };
          }

          const result = await orchestrator.deploy(confirmation);

          if (flags.json) {
            emitJson(toJsonResult(result));
          }
          return result.success ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

/** The `--json` payload for CI (SPEC §54). Secrets are never present. */
export function toJsonResult(result: DeployResult): Record<string, unknown> {
  return redact({
    success: result.success,
    deploymentId: result.deploymentId,
    release: result.releaseId,
    domain: result.domain,
    server: result.server,
    git: result.gitSha,
    durationMs: result.durationMs,
    ...(result.health
      ? {
          checks: Object.fromEntries(
            result.health.results.map((check) => [check.name, check.status === 'pass']),
          ),
          health: result.health.status,
        }
      : {}),
    ...(result.backupPath ? { backup: result.backupPath } : {}),
    ...(result.failure
      ? {
          error: {
            message: result.failure.message,
            command: result.failure.command,
            liveAffected: result.failure.liveAffected,
            remediation: result.failure.remediation,
          },
        }
      : {}),
  }) as Record<string, unknown>;
}

/** Summary printed by `laravel-deploy status --json`-adjacent flows. */
export function describeProject(cwd: string): string {
  const project = inspectProject(cwd);
  return `${project.name} (Laravel ${project.laravelMajor ?? '?'})`;
}