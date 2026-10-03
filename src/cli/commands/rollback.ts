/**
 * `laravel-deploy rollback` — restore the previous application release.
 *
 * The database is deliberately NOT rolled back: application code and schema are
 * separate concerns and reverting one without the other is how outages are made
 * (SPEC §32).
 */

import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';

import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import {
  listReleases,
  readCurrentRelease,
  readPreviousRelease,
} from '../../core/release/retention.js';
import { scriptPath } from '../../core/release/layout.js';
import { HealthChecker } from '../../core/health/checker.js';
import { SftpUploader } from '../../providers/sftp/uploader.js';

import { planWorkers, shouldRunWorkers } from '../../laravel/workers.js';
import { inspectProject, slugify } from '../../laravel/detector.js';

import { q } from '../../utils/shell.js';


export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback')
    .description('Switch back to the previous application release (the database is NOT rolled back)')
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--to <release>', 'specific release id to switch to')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour')
    .action(async (flags: GlobalOptions & { to?: string }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const layout = ctx.layout();
          const executor = await ctx.connect();
          const ui = ctx.ui;

          const current = await readCurrentRelease(executor, layout);
          const releases = await listReleases(executor, layout);

          if (layout.strategy === 'legacy-root-copy') {
            ui.warn(
              'Rollback is not supported in legacy-root-copy mode.',
              'Deploy an older commit instead.',
            );
            return 1;
          }

          const target = flags.to ?? (await readPreviousRelease(executor, layout, current));

          ui.section('Rollback');
          ui.info(`Current:  ${current ?? 'none'}`);
          ui.info(`Target:   ${target ?? 'none'}`);
          ui.info(`Releases: ${releases.join(', ') || 'none'}`);

          if (!target) {
            ui.fail('No previous release is available to roll back to.');
            ui.info('A rollback needs at least two releases on the server.');
            if (flags.json) emitJson({ success: false, reason: 'no previous release' });
            return 1;
          }

          const targetExists = await executor.exec(`test -d ${q(`${layout.releasesDir}/${target}`)}`, {
            allowFailure: true,
          });
          if (targetExists.exitCode !== 0) {
            ui.fail(`Release ${target} does not exist on the server.`);
            if (flags.json) emitJson({ success: false, reason: 'target release missing' });
            return 1;
          }

          if (!flags.yes) {
            ui.section('Confirm');
            ui.warn('This will switch the live application back one release.');
            ui.warn('The database will NOT be rolled back.');
            const ok = await confirm({ message: `Switch to ${target}?`, default: false });
            if (!ok) {
              ui.warn('Cancelled.');
              return 1;
            }
          }

          // Upload and run the activation script against the target release.
          const uploader = new SftpUploader({ profile: ctx.profile, logger: ctx.logger });
          await uploader.uploadText(await readActivationScript(), scriptPath(layout, 'activate-release.sh'), ctx.config.timeouts.ssh);

          const script = [
            'set -Eeuo pipefail',
            `export LD_ROOT=${q(layout.root)}`,
            `export LD_RELEASE=${q(target)}`,
            `export LD_STRATEGY=${q(layout.strategy)}`,
            `bash ${q(scriptPath(layout, 'activate-release.sh'))}`,
          ].join('\n');

          const result = await executor.exec(script, { label: 'rollback', timeoutMs: 120_000, allowFailure: true });
          if (result.exitCode !== 0) {
            ui.fail('Rollback failed.');
            ui.detail(result.stderr.slice(-1500));
            if (flags.json) emitJson({ success: false, release: target, error: result.stderr.slice(-500) });
            return 1;
          }

          ui.ok(`Rolled back to ${target}`);

          // Restart workers so they pick up the older code.
          if (shouldRunWorkers({
            configEnabled: ctx.config.queue.enabled,
            queueHint: false,
            queueConnection: null,
            usesHorizon: false,
          }).needed) {
            const project = inspectProject(ctx.paths.projectRoot);
            const names = planWorkers(project.name, ctx.config.queue).map((plan) => plan.programName);
            await ctx.supervisor(executor).restart(names);
            ui.status('Workers restarted', names.join(', '));
          }

          // Verify the rolled-back release actually serves.
          const checker = new HealthChecker({
            executor,
            layout,
            config: ctx.config.healthCheck,
            domain: ctx.config.site.domain,
            phpBinary: ctx.config.php.remoteBinary ?? ctx.config.php.binary,
            queue: ctx.config.queue,
            scheduler: ctx.config.scheduler,
            projectSlug: slugify(inspectProject(ctx.paths.projectRoot).name),
            clock: ctx.clock,
          });
          const health = await checker.runAll();
          const failed = health.results.filter((r) => r.status === 'fail');

          ui.section('Result');
          ui.ok('Application release rolled back.', target);
          ui.warn('Database was NOT rolled back.');
          ui.info('If the new code required a schema change, migrate explicitly:');
          ui.info('  laravel-deploy migrate:rollback');

          for (const check of health.results) {
            if (check.status === 'pass') ui.ok(check.name);
            else if (check.status === 'fail') ui.fail(check.name, check.message);
          }

          if (flags.json) {
            emitJson({
              success: failed.length === 0,
              rolledBackTo: target,
              previousRelease: current,
              databaseRolledBack: false,
              health: health.status,
              checks: Object.fromEntries(health.results.map((r) => [r.name, r.status === 'pass'])),
            });
          }
          return failed.length === 0 ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

async function readActivationScript(): Promise<string> {
  const { remoteScriptsDir } = await import('../../core/config/paths.js');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  return fs.readFile(path.join(remoteScriptsDir(), 'activate-release.sh'), 'utf8');
}

