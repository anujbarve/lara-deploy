/**
 * `laravel-deploy status` and `laravel-deploy doctor`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import { HealthChecker, aggregate, type CheckResult } from '../../core/health/checker.js';
import { renderChecks } from '../ui/ui.js';
import { readCurrentRelease, listReleases } from '../../core/release/retention.js';
import { inspectProject, slugify } from '../../laravel/detector.js';
import { formatBytes } from '../../utils/ids.js';
import { q } from '../../utils/shell.js';
import type { RemoteExecutor } from '../../providers/exec/types.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Report the health of the deployment')
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const layout = ctx.layout();
          const project = inspectProject(ctx.paths.projectRoot);
          const executor = await ctx.connect();

          const checker = new HealthChecker({
            executor,
            layout,
            config: ctx.config.healthCheck,
            domain: ctx.config.site.domain,
            phpBinary: ctx.config.php.remoteBinary ?? ctx.config.php.binary,
            queue: ctx.config.queue,
            scheduler: ctx.config.scheduler,
            // Without this the SSL check runs even when the project is
            // explicitly HTTP-only, and reports a failure that the operator
            // has already opted out of.
            sslEnabled: ctx.config.ssl.enabled,
            projectSlug: slugify(project.name),
            clock: ctx.clock,
          });

          const results: CheckResult[] = [];

          // --- application ------------------------------------------------
          const localChecks = localApplicationChecks(ctx.paths.projectRoot, ctx.config.site.domain);
          results.push(...localChecks);

          // --- server -----------------------------------------------------
          results.push(...(await serverChecks(executor, ctx.config.timeouts)));

          // --- live checks ------------------------------------------------
          results.push(...(await checker.runAll()).results);

          // --- deployment --------------------------------------------------
          const current = await readCurrentRelease(executor, layout);
          const releases = await listReleases(executor, layout);
          results.push({
            name: 'current release',
            status: current ? 'pass' : 'fail',
            message: current ?? 'no active release found',
            ...(current ? {} : { remediation: ['Run `laravel-deploy deploy` to create one.'] }),
          });
          results.push({
            name: 'releases on disk',
            status: releases.length > 0 ? 'pass' : 'warn',
            message: `${releases.length} release(s): ${releases.slice(0, 3).join(', ')}${releases.length > 3 ? '…' : ''}`,
          });

          const report = aggregate(results);

          if (flags.json) {
            emitJson({
              success: report.status !== 'UNHEALTHY',
              domain: ctx.config.site.domain,
              server: ctx.profile.name,
              status: report.status,
              release: current,
              checks: Object.fromEntries(
                report.results.map((r) => [r.name, { status: r.status, message: r.message }]),
              ),
            });
          } else {
            renderChecks(ctx.ui, 'Laravel Deploy', report.results, report.status);
          }
          return report.status === 'UNHEALTHY' ? 1 : 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

function localApplicationChecks(projectRoot: string, domain: string): CheckResult[] {
  const project = inspectProject(projectRoot);
  return [
    {
      name: 'laravel detected',
      status: project.isLaravel ? 'pass' : 'fail',
      message: project.isLaravel
        ? `Laravel ${project.laravelRequirement ?? project.laravelMajor ?? 'unknown'}`
        : 'not a Laravel project',
    },
    {
      name: 'domain configured',
      status: domain ? 'pass' : 'fail',
      message: domain,
    },
    {
      name: 'local .env present',
      status: 'pass',
      message: existsSync(path.join(projectRoot, '.env.example'))
        ? '.env.example available'
        : 'no .env.example (the server .env is used instead)',
    },
  ];
}

async function serverChecks(executor: RemoteExecutor, timeouts: { artisan: number }): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const php = await executor.exec('php -v 2>&1 | head -1', { allowFailure: true, timeoutMs: timeouts.artisan });
  results.push({
    name: 'php',
    status: php.exitCode === 0 ? 'pass' : 'fail',
    message: php.stdout.trim() || 'php not found on the server',
    ...(php.exitCode === 0 ? {} : { remediation: ['Install PHP through aaPanel, or set php.binary.'] }),
  });

  const composer = await executor.exec('composer --version 2>&1 | head -1', { allowFailure: true });
  results.push({
    name: 'composer',
    status: composer.exitCode === 0 ? 'pass' : 'warn',
    message: composer.exitCode === 0 ? composer.stdout.trim() : 'composer not on PATH (only needed to build locally)',
  });

  const node = await executor.exec('node --version 2>&1 | head -1', { allowFailure: true });
  results.push({
    name: 'node',
    status: 'skip',
    message: node.exitCode === 0 ? node.stdout.trim() : 'not installed (not needed when the build runs locally)',
  });

  const disk = await executor.exec("df -BG --output=avail / | tail -1 | tr -dc '0-9'", { allowFailure: true });
  const available = Number(disk.stdout.trim());
  results.push({
    name: 'disk free',
    status: Number.isFinite(available) ? (available < 2 ? 'warn' : 'pass') : 'skip',
    message: Number.isFinite(available) ? `${formatBytes(available * 1024 * 1024 * 1024)} available on /` : 'unknown',
    ...(Number.isFinite(available) && available < 2
      ? { remediation: ['Free disk space before deploying: prune old releases with `laravel-deploy deploy --keep-releases 2`.'] }
      : {}),
  });

  const memory = await executor.exec('free -m 2>/dev/null | awk "/^Mem:/ {print \$7}"', { allowFailure: true });
  const availableMem = Number(memory.stdout.trim());
  results.push({
    name: 'memory free',
    status: Number.isFinite(availableMem) ? (availableMem < 256 ? 'warn' : 'pass') : 'skip',
    message: Number.isFinite(availableMem) ? `${(availableMem / 1024).toFixed(1)} GB available` : 'unknown',
  });

  return results;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Deep diagnostics for a broken deployment')
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--fix', 'repair what can be repaired safely')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour')
    .action(async (flags: GlobalOptions & { fix?: boolean }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const layout = ctx.layout();
          const executor = await ctx.connect();
          const results: CheckResult[] = [];

          const rootExists = await executor.exec(`test -d ${q(layout.root)}`, { allowFailure: true });
          results.push({
            name: 'site root',
            status: rootExists.exitCode === 0 ? 'pass' : 'fail',
            message: layout.root,
          });

          // broken release symlink
          const link = await executor.exec(
            `if [ -L ${q(layout.currentLink)} ]; then readlink -f ${q(layout.currentLink)} 2>/dev/null; elif [ -e ${q(layout.currentLink)} ]; then echo NOT_A_LINK; else echo MISSING; fi`,
            { allowFailure: true },
          );
          const linkState = link.stdout.trim();
          results.push({
            name: 'current symlink',
            status: linkState === 'MISSING' || linkState === 'NOT_A_LINK' || linkState === '' ? 'fail' : 'pass',
            message:
              linkState === 'MISSING'
                ? 'current is missing'
                : linkState === 'NOT_A_LINK'
                  ? 'current exists but is not a symlink'
                  : linkState,
          });

          // deployment lock
          const lock = await executor.exec(`cat ${q(layout.lockFile)} 2>/dev/null`, { allowFailure: true });
          const hasLock = lock.stdout.trim() !== '';
          results.push({
            name: 'deployment lock',
            status: hasLock ? 'warn' : 'pass',
            message: hasLock ? 'a lock file is present' : 'no stale lock',
            ...(hasLock ? { remediation: ['If no deployment is running: laravel-deploy deploy --force-unlock'] } : {}),
          });

          // storage
          const storage = await executor.exec(
            `test -d ${q(layout.sharedStorage)} && echo ok || echo missing`,
            { allowFailure: true },
          );
          results.push({
            name: 'shared storage',
            status: storage.stdout.trim() === 'ok' ? 'pass' : 'fail',
            message: storage.stdout.trim() === 'ok' ? 'present' : 'missing shared storage directory',
            ...(storage.stdout.trim() === 'ok'
              ? {}
              : { remediation: ['Run `laravel-deploy storage repair`.'] }),
          });

          // .env
          const envExists = await executor.exec(`test -s ${q(layout.envPath)}`, { allowFailure: true });
          results.push({
            name: 'server .env',
            status: envExists.exitCode === 0 ? 'pass' : 'fail',
            message: envExists.exitCode === 0 ? layout.envPath : 'missing or empty',
            ...(envExists.exitCode === 0 ? {} : { remediation: ['Set env.strategy to "generate" or upload a template.'] }),
          });

          // document root
          const web = ctx.web(executor);
          const rootCheck = await web.checkDocumentRoot(ctx.config.site.domain, layout.documentRoot);
          results.push({
            name: 'document root',
            status: rootCheck.ok ? 'pass' : 'fail',
            message: rootCheck.detail,
            ...(rootCheck.ok ? {} : { remediation: [`Expected: ${rootCheck.expected}`, 'Or set site.documentRootStrategy.'] }),
          });

          // caches
          const caches = await executor.exec(
            [
              `config=${q(`${layout.appDir}/bootstrap/cache/config.php`)}`,
              `routes=${q(`${layout.appDir}/bootstrap/cache/routes-v7.php`)}`,
              '[ -f "$config" ] && echo "config=warmed" || echo "config=stale"',
              '[ -f "$routes" ] && echo "routes=warmed" || echo "routes=stale"',
            ].join('\n'),
            { allowFailure: true },
          );
          const warm = (caches.stdout.match(/=warmed/g) ?? []).length;
          results.push({
            name: 'laravel caches',
            status: warm >= 2 ? 'pass' : 'warn',
            message: warm >= 2 ? 'config and routes cached' : 'caches are stale',
            ...(warm >= 2 ? {} : { remediation: ['Run `laravel-deploy optimize`.'] }),
          });

          // incomplete releases
          const releases = await listReleases(executor, layout);
          for (const release of releases) {
            const complete = await executor.exec(
              `test -e ${q(`${layout.releasesDir}/${release}/artisan`)} && test -e ${q(`${layout.releasesDir}/${release}/vendor/autoload.php`)}`,
              { allowFailure: true },
            );
            if (complete.exitCode !== 0) {
              results.push({
                name: `release ${release}`,
                status: 'warn',
                message: 'incomplete (missing artisan or vendor)',
                remediation: [`Remove it: rm -rf ${layout.releasesDir}/${release}`],
              });
            }
          }

          const report = aggregate(results);
          if (flags.json) {
            emitJson({
              success: report.status !== 'UNHEALTHY',
              status: report.status,
              checks: report.results,
            });
          } else {
            renderChecks(ctx.ui, 'Diagnosis', report.results, report.status);
          }
          return report.status === 'UNHEALTHY' ? 1 : 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}