/**
 * `laravel-deploy queue` and `laravel-deploy scheduler`.
 *
 * Both manage their own resources idempotently and never touch anything this
 * CLI did not create (SPEC §25, §26).
 */

import { Command } from 'commander';
import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import { planWorkers, shouldRunWorkers, evaluateWorkers } from '../../laravel/workers.js';
import { inspectProject, slugify } from '../../laravel/detector.js';
import { q } from '../../utils/shell.js';

export function registerQueueCommand(program: Command): void {
  const queue = program.command('queue').description('Manage queue workers');

  queue
    .command('status')
    .description('Show queue worker status')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const project = inspectProject(ctx.paths.projectRoot);
          const names = planWorkers(project.name, ctx.config.queue).map((p) => p.programName);
          const manager = ctx.supervisor(executor);

          ctx.ui.section('Queue');
          if (!(await manager.available())) {
            ctx.ui.warn('supervisorctl is not available on this server.');
            if (flags.json) emitJson({ success: false, reason: 'supervisorctl unavailable' });
            return 1;
          }
          const states = await manager.status();
          const health = evaluateWorkers(states, names);

          if (health.ok) ctx.ok('Workers running', health.detail);
          else ctx.fail('Workers not healthy', health.detail);

          for (const state of states) {
            ctx.ui.info(`${state.name}: ${state.state} (pid ${state.pid})`);
          }
          if (flags.json) emitJson({ success: health.ok, ...health });
          return health.ok ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });

  queue
    .command('restart')
    .description('Gracefully restart the application workers')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const project = inspectProject(ctx.paths.projectRoot);
          const names = planWorkers(project.name, ctx.config.queue).map((p) => p.programName);

          ctx.ui.section('Queue');
          ctx.ui.action('Restarting workers', names.join(', '));
          const ok = await ctx.supervisor(executor).restart(names);
          if (ok) ctx.ok('Workers restarted');
          else ctx.fail('Worker restart failed');

          if (flags.json) emitJson({ success: ok, programs: names });
          return ok ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });

  queue
    .command('install')
    .description('Install or update supervisor worker definitions')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const project = inspectProject(ctx.paths.projectRoot);
          const layout = ctx.layout();

          if (!shouldRunWorkers({
            configEnabled: ctx.config.queue.enabled,
            queueHint: project.hints.queue,
            queueConnection: project.queueConnection,
            usesHorizon: false,
          }).needed) {
            ctx.ui.warn('Queue workers are not configured.', 'Set queue.enabled = true first.');
            if (flags.json) emitJson({ success: false, reason: 'queue disabled' });
            return 1;
          }

          ctx.ui.section('Queue');
          const plans = planWorkers(project.name, ctx.config.queue);
          const result = await ctx.supervisor(executor).install(plans, {
            siteRoot: layout.root,
            phpBinary: ctx.config.php.remoteBinary ?? ctx.config.php.binary,
            restart: true,
          });

          if (result.written.length) ctx.action('Created', result.written.join(', '));
          if (result.updated.length) ctx.action('Updated', result.updated.join(', '));
          if (result.unchanged.length) ctx.ok('Unchanged', result.unchanged.join(', '));
          if (result.written.length === 0 && result.updated.length === 0) ctx.ok('Nothing to do');

          if (flags.json) emitJson({ success: true, ...result });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });

  queue
    .command('logs')
    .description('Show queue worker logs')
    .option('--lines <n>', 'number of lines', '50')
    .option('-f, --follow', 'follow the log')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .action(async (flags: GlobalOptions & { lines?: string; follow?: boolean }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const project = inspectProject(ctx.paths.projectRoot);
          const names = planWorkers(project.name, ctx.config.queue).map((p) => p.programName);
          const manager = ctx.supervisor(executor);
          await manager.logs(names[0] as string, Number(flags.lines ?? 50), Boolean(flags.follow));
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

export function registerSchedulerCommand(program: Command): void {
  const scheduler = program.command('scheduler').description('Manage the Laravel scheduler');

  scheduler
    .command('status')
    .description('Show scheduler cron status')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const status = await ctx.cron(executor).status({
            config: ctx.config.scheduler,
            siteRoot: layout.root,
            phpBinary: ctx.config.php.remoteBinary ?? ctx.config.php.binary,
          });

          ctx.ui.section('Scheduler');
          if (!status.installed) {
            ctx.ui.fail('No cron entry installed.', 'Run `laravel-deploy scheduler install`.');
            if (flags.json) emitJson({ success: false, ...status });
            return 1;
          }
          ctx.ui.ok('Cron entry present', status.entry ?? '');
          if (status.staleTarget) {
            ctx.ui.fail('The cron entry points at a directory that no longer exists.');
            ctx.ui.info('Reinstall with `laravel-deploy scheduler install`.');
          }
          if (flags.json) emitJson({ success: !status.staleTarget, ...status });
          return status.staleTarget ? 1 : 0;
        } finally {
          await ctx.dispose();
        }
      });
    });

  scheduler
    .command('install')
    .description('Install the scheduler cron entry (idempotent)')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          ctx.ui.section('Scheduler');
          const result = await ctx.cron(executor).install({
            config: ctx.config.scheduler,
            siteRoot: layout.root,
            phpBinary: ctx.config.php.remoteBinary ?? ctx.config.php.binary,
          });
          if (result.reused) ctx.ok('Cron entry already present', result.entry);
          else ctx.ok('Cron entry installed', result.entry);
          if (flags.json) emitJson({ success: true, ...result });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });

  scheduler
    .command('remove')
    .description('Remove the scheduler cron entry')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          ctx.ui.section('Scheduler');
          const removed = await ctx.cron(executor).remove(ctx.config.scheduler);
          if (removed) ctx.ok('Cron entry removed');
          else ctx.info('No cron entry was present.');
          if (flags.json) emitJson({ success: true, removed });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

/**
 * `laravel-deploy storage` — inspect and repair shared storage links.
 */
export function registerStorageCommand(program: Command): void {
  const storage = program.command('storage').description('Inspect and repair shared storage');

  const shared = (root: string) =>
    [
      'set -Eeuo pipefail',
      `root=${q(root)}`,
      'shared="$root/shared/storage"',
      'link="$root/current/storage"',
      'public="$root/current/public/storage"',
      '[ -d "$shared" ] && echo "SHARED=ok" || echo "SHARED=missing"',
      '[ -w "$shared/framework/views" ] && echo "WRITABLE=yes" || echo "WRITABLE=no"',
      'if [ -L "$public" ]; then',
      '  t="$(readlink -f "$public" 2>/dev/null || true)"',
      '  [ -n "$t" ] && echo "PUBLIC=$t" || echo "PUBLIC=broken"',
      'else',
      '  echo "PUBLIC=missing"',
      'fi',
      'if [ -L "$link" ]; then',
      '  t="$(readlink -f "$link" 2>/dev/null || true)"',
      '  [ -n "$t" ] && echo "LINK=$t" || echo "LINK=broken"',
      'else',
      '  echo "LINK=missing"',
      'fi',
    ].join('\n');

  storage
    .command('status')
    .description('Show storage link status')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const result = await executor.exec(shared(layout.root), {
            allowFailure: true,
          });

          ctx.ui.section('Storage');
          const values = parseValues(result.stdout);
          ctx.ui.status('shared/storage exists', values.SHARED === 'ok' ? 'ok' : 'MISSING');
          ctx.ui.status('storage writable', values.WRITABLE === 'yes' ? 'yes' : 'NO');
          ctx.ui.status('current/storage', values.LINK ?? 'missing');
          ctx.ui.status('public/storage', values.PUBLIC ?? 'missing');

          const ok = values.SHARED === 'ok' && values.WRITABLE === 'yes' &&
            values.LINK === layout.sharedStorage && values.PUBLIC === layout.sharedStorage + '/app/public';

          if (flags.json) emitJson({ success: ok, ...values });
          return ok ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });

  storage
    .command('repair')
    .description('Rebuild the storage symlinks')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const sharedStorage = `${layout.sharedStorage}`;

          ctx.ui.section('Storage');
          ctx.ui.action('Rebuilding storage links', layout.root);

          const script = [
            'set -Eeuo pipefail',
            `root=${q(layout.root)}`,
            `shared=${q(sharedStorage)}`,
            'mkdir -p "$shared/app/public" "$shared/app/private" "$shared/framework/cache/data" "$shared/framework/sessions" "$shared/framework/views" "$shared/logs"',
            // Only replace a real directory or a broken link, never data.
            'if [ -e "$root/current/storage" ] && [ ! -L "$root/current/storage" ]; then',
            '  echo "Refusing to replace a real storage directory." >&2; exit 1;',
            'fi',
            'rm -f "$root/current/storage"',
            'ln -s "$shared" "$root/current/storage"',
            'rm -f "$root/current/public/storage"',
            'ln -s "$shared/app/public" "$root/current/public/storage"',
            'echo REPAIRED',
          ].join('\n');

          const result = await executor.exec(script, { label: 'repair storage', allowFailure: true });
          if (result.exitCode !== 0) {
            ctx.ui.fail('Repair failed', result.stderr.trim().split('\n').pop() ?? '');
            if (flags.json) emitJson({ success: false, error: result.stderr.slice(-500) });
            return 1;
          }
          ctx.ui.ok('Storage links repaired', `current/storage -> ${sharedStorage}`);
          if (flags.json) emitJson({ success: true });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

/**
 * `laravel-deploy maintenance` — `artisan down` / `artisan up`.
 */
export function registerMaintenanceCommand(program: Command): void {
  const maintenance = program.command('maintenance').description('Toggle Laravel maintenance mode');

  const run = (direction: 'on' | 'off') => async (flags: GlobalOptions & { secret?: string; retry?: string; redirect?: string[] }) => {
    await runCommand(async () => {
      const ctx = await createContext(flags);
      try {
        const executor = await ctx.connect();
        const layout = ctx.layout();
        const phpBinary = ctx.config.php.remoteBinary ?? ctx.config.php.binary;

        const args: string[] = [];
        if (direction === 'on') {
          args.push('down');
          if (flags.secret) args.push(`--secret=${flags.secret}`);
          if (flags.retry) args.push(`--retry=${flags.retry}`);
          for (const target of flags.redirect ?? []) args.push(`--render=${target}`);
        } else {
          args.push('up');
        }

        const display = `php artisan ${args.join(' ')}`;
        ctx.ui.section('Maintenance');
        ctx.ui.command(display, layout.appDir);

        const result = await executor.exec(
          `cd ${q(layout.appDir)} && ${q(phpBinary)} artisan ${args.map((a) => (/^-{1,2}[A-Za-z]/.test(a) ? a : q(a))).join(' ')}`,
          { label: 'maintenance', timeoutMs: 60_000, allowFailure: true },
        );

        if (result.exitCode === 0) {
          ctx.ok(direction === 'on' ? 'Maintenance mode enabled' : 'Maintenance mode disabled');
        } else {
          ctx.fail('Command failed', result.stderr.trim().split('\n').pop() ?? '');
        }
        if (flags.json) emitJson({ success: result.exitCode === 0, command: display });
        return result.exitCode === 0 ? 0 : 1;
      } finally {
        await ctx.dispose();
      }
    });
  };

  maintenance
    .command('on')
    .description('Enable maintenance mode')
    .option('--secret <secret>', 'bypass secret')
    .option('--retry <seconds>', 'retry-after header')
    .option('--redirect <target...>', 'redirect targets')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(run('on'));

  maintenance
    .command('off')
    .description('Disable maintenance mode')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(run('off'));
}

function parseValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Z]+)=([\s\S]*)$/.exec(line);
    if (match) values[match[1] as string] = (match[2] ?? '').trim();
  }
  return values;
}

void slugify;