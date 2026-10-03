/**
 * `laravel-deploy logs`, `history`, `domain`, `optimize`, `database`, `site`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import { ManifestStore } from '../../core/release/manifest.js';
import { readCurrentRelease } from '../../core/release/retention.js';
import { planCaches } from '../../laravel/cache.js';
import { ArtisanCommandFactory } from '../../laravel/artisan.js';
import { inspectProject, slugify } from '../../laravel/detector.js';
import { q } from '../../utils/shell.js';
import { formatDuration } from '../../utils/ids.js';
import { input } from '@inquirer/prompts';
import { HealthChecker } from '../../core/health/checker.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('Show server or application logs')
    .argument('[source]', 'laravel | nginx | php | queue | deploy', 'laravel')
    .option('-n, --lines <n>', 'number of lines', '50')
    .option('-f, --follow', 'follow the log')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (source: string, flags: GlobalOptions & { lines?: string; follow?: boolean }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const lines = Number(flags.lines ?? 50);
          const follow = Boolean(flags.follow);
          const domain = ctx.config.site.domain;

          const paths: Record<string, string> = {
            laravel: `${layout.appDir}/storage/logs/laravel.log`,
            laravelOld: `${layout.sharedStorage}/logs/laravel.log`,
            nginx: `/www/wwwlogs/${domain}.error.log`,
            php: `${layout.appDir}/storage/logs/php-error.log`,
            deploy: ctx.paths.logDir + '/laravel-deploy.log',
          };

          let command: string;
          switch (source) {
            case 'nginx':
              command = follow
                ? `tail -n ${lines} -f ${q(paths.nginx as string)}`
                : `tail -n ${lines} ${q(paths.nginx as string)} 2>/dev/null || echo "No nginx error log at ${paths.nginx as string}"`;
              break;
            case 'php':
              command = `tail -n ${lines} ${q(paths.php as string)} 2>/dev/null || echo "No PHP error log"`;
              break;
            case 'deploy':
              // Deploy logs are local, not remote.
              process.stdout.write(readLocalLog(ctx.paths.logDir, lines));
              return 0;
            case 'queue': {
              const project = inspectProject(ctx.paths.projectRoot);
              const name = `laravel-${slugify(project.name)}-worker`;
              command = `tail -n ${lines} ${q(`/var/log/supervisor/${name}.log`)} 2>/dev/null || echo "No supervisor log for ${name}"`;
              break;
            }
            case 'laravel':
            default: {
              const logPath = `${layout.sharedStorage}/logs/laravel.log`;
              command = follow
                ? `tail -n ${lines} -f ${q(logPath)}`
                : `test -f ${q(logPath)} && tail -n ${lines} ${q(logPath)} || echo "No Laravel log yet. The application may not have logged anything, or storage is not linked."`;
              break;
            }
          }

          const result = await executor.exec(command, {
            allowFailure: true,
            timeoutMs: follow ? -1 : 30_000,
            label: `logs ${source}`,
          });
          process.stdout.write(result.stdout);
          if (result.stderr.trim()) process.stderr.write(result.stderr);
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

function readLocalLog(logDir: string, lines: number): string {
  const file = path.join(logDir, 'laravel-deploy.log');
  if (!existsSync(file)) return 'No deploy log found yet.\n';
  // The log is written on this machine, so on Windows the lines end CRLF.
  const content = readFileSync(file, 'utf8').split(/\r?\n/);
  return `${content.slice(-lines).join('\n')}\n`;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('List recent deployments')
    .option('-n, --limit <n>', 'number of entries', '20')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (flags: GlobalOptions & { limit?: string }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        const store = new ManifestStore(ctx.paths.historyDir);
        const manifests = store.list(Number(flags.limit ?? 20));

        if (manifests.length === 0) {
          ctx.ui.warn('No deployment history found.');
          if (flags.json) emitJson({ deployments: [] });
          return 0;
        }

        ctx.ui.section('Deployments');
        for (const manifest of manifests) {
          const icon =
            manifest.status === 'SUCCESS' ? '✓' : manifest.status === 'FAILED' ? '✗' : '·';
          ctx.ui.info(
            `${icon} ${manifest.deploymentId}  ${manifest.releaseId ?? '-'}  ` +
              `${manifest.domain}  ${manifest.status}` +
              (manifest.durationMs ? `  (${formatDuration(manifest.durationMs)})` : ''),
          );
        }
        if (flags.json) emitJson({ deployments: manifests });
        return 0;
      });
    });

  const deployment = program.command('deployment').description('Inspect a deployment');

  deployment
    .command('show')
    .description('Show the details of a deployment')
    .argument('<id>', 'deployment id')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (id: string, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        const store = new ManifestStore(ctx.paths.historyDir);
        const manifest = store.load(id);
        if (!manifest) throw new Error(`No deployment found with id ${id}.`);

        ctx.ui.section(id);
        ctx.ui.status('Project', manifest.project);
        ctx.ui.status('Domain', manifest.domain);
        ctx.ui.status('Server', `${manifest.server} (${manifest.serverHost})`);
        ctx.ui.status('Release', manifest.releaseId ?? '-');
        ctx.ui.status('Git', manifest.gitSha?.slice(0, 7) ?? '-');
        ctx.ui.status('Duration', manifest.durationMs ? formatDuration(manifest.durationMs) : '-');
        ctx.ui.status('Status', manifest.status);
        if (manifest.failedStep) ctx.ui.fail('Failed step', manifest.failedStep);
        if (manifest.error) ctx.ui.detail(manifest.error);

        ctx.ui.section('Steps');
        for (const step of manifest.steps) {
          if (step.status === 'ok') ctx.ui.ok(step.step);
          else if (step.status === 'skipped') ctx.ui.info(`${step.step} — skipped`);
          else ctx.ui.fail(step.step, step.error ?? '');
        }

        if (flags.json) emitJson(manifest);
        return 0;
      });
    });
}

export function registerDomainCommand(program: Command): void {
  program
    .command('domain')
    .description('Check DNS and reachability for the configured domain')
    .argument('[action]', 'check', 'check')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (_action: string, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const checker = new HealthChecker({
            executor,
            layout,
            config: ctx.config.healthCheck,
            domain: ctx.config.site.domain,
            phpBinary: ctx.config.php.binary,
            clock: ctx.clock,
          });

          ctx.ui.section(`Domain: ${ctx.config.site.domain}`);
          const dns = await checker.dnsCheck();
          if (dns.status === 'pass') ctx.ok('DNS resolves', dns.message);
          else ctx.fail('DNS does not resolve', dns.message);

          // Compare against the server's own public-facing address.
          const ip = await executor.exec(
            "curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'",
            { allowFailure: true, timeoutMs: 15_000 },
          );
          const serverIp = ip.stdout.trim();
          if (serverIp && dns.details?.addresses) {
            const addresses = (dns.details.addresses as Array<{ address: string }>).map((a) => a.address);
            if (addresses.includes(serverIp)) ctx.ok('DNS points at this server', serverIp);
            else ctx.warn(`DNS points elsewhere (${addresses.join(', ')}); server is ${serverIp}`);
          }

          const http = await checker.http();
          if (http.status === 'pass') ctx.ok('HTTPS', http.message);
          else ctx.fail('HTTPS', http.message);

          const ssl = await checker.ssl();
          if (ssl.status === 'pass') ctx.ok('SSL', ssl.message);
          else ctx.fail('SSL', ssl.message);

          if (flags.json) emitJson({ success: dns.status === 'pass', dns, http, ssl, serverIp });
          return dns.status === 'pass' ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

export function registerOptimizeCommand(program: Command): void {
  program
    .command('optimize')
    .description('Clear and rebuild Laravel caches on the active release')
    .option('--granular', 'run config:cache / route:cache / view:cache separately')
    .option('--clear-only', 'only clear caches')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (flags: GlobalOptions & { granular?: boolean; clearOnly?: boolean }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const project = inspectProject(ctx.paths.projectRoot);
          const phpBinary = ctx.config.php.remoteBinary ?? ctx.config.php.binary;
          const factory = new ArtisanCommandFactory(project, { releasePath: layout.appDir, phpBinary });

          const plan = flags.clearOnly
            ? { steps: factory.clearCaches().map((i) => ({ label: i.args.join(' '), invocation: i })), display: [] }
            : planCaches(factory, {
                ...(flags.granular ? { useOptimizeCommand: false } : {}),
                clearFirst: true,
              });

          ctx.ui.section('Optimize');
          for (const step of plan.steps) {
            const display = `php artisan ${step.label}`;
            ctx.ui.command(display, layout.appDir);
            const result = await executor.exec(
              `cd ${q(layout.appDir)} && ${q(phpBinary)} artisan ${step.label}`,
              { label: step.label, allowFailure: true, timeoutMs: ctx.config.timeouts.artisan },
            );
            if (result.exitCode === 0) ctx.ok(step.label);
            else ctx.fail(step.label, result.stderr.trim().split('\n').pop() ?? '');
          }

          if (flags.json) emitJson({ success: true, steps: plan.steps.map((s) => s.label) });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

export function registerDatabaseCommand(program: Command): void {
  const database = program.command('database').alias('db').description('Database operations');

  database
    .command('backup')
    .description('Create a database backup on the server')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const project = inspectProject(ctx.paths.projectRoot);
          const dbName = ctx.config.database.name ?? slugify(project.name);
          const dbUser = ctx.config.database.username ?? dbName;
          const password = ctx.secrets.get(`servers.${ctx.profile.name}.database.password`) ?? '';

          ctx.ui.section('Database');
          ctx.ui.action('Backing up', dbName);
          const result = await ctx.mysql(executor).backup({
            database: dbName,
            backupDir: layout.backupsDir,
            fileName: `${dbName}-manual-${Date.now()}.sql.gz`,
            credentials: {
              username: dbUser,
              password,
              host: ctx.config.database.host,
              port: ctx.config.database.port,
            },
            timeoutMs: ctx.config.timeouts.databaseBackup,
          });
          ctx.ui.ok('Backup created', `${result.path} (${result.humanSize})`);
          if (flags.json) emitJson({ success: true, ...result });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });

  database
    .command('restore')
    .description('Restore a database backup (requires typed confirmation)')
    .argument('[file]', 'backup filename in the backups directory')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--confirm-production', 'acknowledge that this overwrites the database')
    .option('--json', 'machine-readable output')
    .action(async (fileArg: string | undefined, flags: GlobalOptions & { confirmProduction?: boolean }) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const project = inspectProject(ctx.paths.projectRoot);
          const dbName = ctx.config.database.name ?? slugify(project.name);
          const dbUser = ctx.config.database.username ?? dbName;
          const password = ctx.secrets.get(`servers.${ctx.profile.name}.database.password`) ?? '';

          let file = fileArg;
          if (!file) {
            const listing = await executor.exec(`ls -1t ${q(layout.backupsDir)} 2>/dev/null | head -20`, {
              allowFailure: true,
            });
            const files = listing.stdout.split('\n').filter((line) => line.trim() !== '');
            if (files.length === 0) {
              ctx.ui.fail('No backups found.', `Looked in ${layout.backupsDir}`);
              return 1;
            }
            const { select } = await import('@inquirer/prompts');
            file = await select({ message: 'Which backup?', choices: files });
          }

          if (!flags.confirmProduction && !flags.yes) {
            const answer = await input({
              message: `This OVERWRITES the database "${dbName}" with ${file}. Type ${ctx.config.site.domain} to confirm:`,
            });
            if (answer.trim() !== ctx.config.site.domain) {
              ctx.ui.warn('Cancelled.');
              return 1;
            }
          } else if (!flags.confirmProduction) {
            ctx.ui.fail('Refusing to restore without --confirm-production.');
            return 1;
          }

          ctx.ui.section('Database');
          ctx.ui.action('Restoring', file);
          await ctx.mysql(executor).restore({
            backupFile: `${layout.backupsDir}/${file}`,
            database: dbName,
            credentials: {
              username: dbUser,
              password,
              host: ctx.config.database.host,
              port: ctx.config.database.port,
            },
            timeoutMs: ctx.config.timeouts.databaseBackup,
          });
          ctx.ui.ok('Database restored', file);
          if (flags.json) emitJson({ success: true, file });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });

  database
    .command('list')
    .alias('ls')
    .description('List available backups')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const listing = await executor.exec(
            `ls -lht ${q(layout.backupsDir)} 2>/dev/null | tail -n +2 || true`,
            { allowFailure: true },
          );
          ctx.ui.section('Backups');
          ctx.ui.block(listing.stdout.trimEnd().split('\n').filter((line) => line !== ''));
          if (flags.json) emitJson({ success: true, output: listing.stdout });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

export function registerSiteCommand(program: Command): void {
  const site = program.command('site').description('Inspect and provision the website');

  site
    .command('inspect')
    .description('Inspect website and server configuration')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const panel = ctx.panel(executor);
          const web = ctx.web(executor);

          const availability = await panel.available();
          const website = await panel.getWebsite(ctx.config.site.domain);
          const rootCheck = await web.checkDocumentRoot(ctx.config.site.domain, layout.documentRoot);
          const release = await readCurrentRelease(executor, layout);
          const webInfo = await web.detect();

          ctx.ui.section(`Site: ${ctx.config.site.domain}`);
          ctx.ui.status('Panel', availability.mode);
          ctx.ui.status('Website', website ? 'exists' : 'MISSING');
          ctx.ui.status('Site root', layout.root);
          ctx.ui.status('Document root', rootCheck.ok ? 'correct' : `MISMATCH — ${rootCheck.detail}`);
          ctx.ui.status('Active release', release ?? 'none');
          ctx.ui.status('Web server', `${webInfo.kind} ${webInfo.version ?? ''}`);
          ctx.ui.status('Web user', `${webInfo.webUser}:${webInfo.webGroup}`);

          if (flags.json) {
            emitJson({
              success: Boolean(website),
              domain: ctx.config.site.domain,
              panel: availability,
              website,
              layout: { root: layout.root, documentRoot: layout.documentRoot },
              documentRoot: rootCheck,
              release,
              web: webInfo,
            });
          }
          return website ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });

  site
    .command('create')
    .description('Create the website and database if they do not exist')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-y, --yes', 'skip confirmation')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const panel = ctx.panel(executor);
          const project = inspectProject(ctx.paths.projectRoot);
          const dbName = ctx.config.database.name ?? slugify(project.name);

          ctx.ui.section('Provisioning');
          ctx.ui.info(`Website: ${ctx.config.site.domain}`);
          ctx.ui.info(`Root:    ${layout.root}`);
          ctx.ui.info(`Database: ${dbName}`);

          const exists = await panel.websiteExists(ctx.config.site.domain);
          if (exists) ctx.ui.ok('Website already exists');
          else {
            ctx.ui.action('Creating website', ctx.config.site.domain);
            await panel.createWebsite({
              domain: ctx.config.site.domain,
              root: layout.root,
              ...(ctx.config.site.phpVersion ? { phpVersion: ctx.config.site.phpVersion } : {}),
            });
            ctx.ui.ok('Website created');
          }

          const dbExists = await panel.databaseExists(dbName);
          if (dbExists) ctx.ui.ok('Database already exists');
          else {
            ctx.ui.action('Creating database', dbName);
            const password = ctx.secrets.get(`servers.${ctx.profile.name}.database.password`) ?? '';
            await panel.createDatabase({ name: dbName, username: dbName, password, host: ctx.config.database.host });
            if (!password) {
              ctx.ui.info('A database password is required. Store one with:');
              ctx.ui.info(`  laravel-deploy secrets set servers.${ctx.profile.name}.database.password`);
            }
            ctx.ui.ok('Database created');
          }

          if (flags.json) emitJson({ success: true, domain: ctx.config.site.domain, database: dbName });
          return 0;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

export function registerPermissionsCommand(program: Command): void {
  const permissions = program.command('permissions').description('Check and fix file permissions');

  permissions
    .command('check')
    .description('Check ownership and permissions')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const web = ctx.web(executor);
          const webInfo = await web.detect();

          const probe = await executor.exec(
            [
              `release=${q(layout.appDir)}`,
              `shared=${q(layout.sharedStorage)}`,
              'echo "RELEASE_OWNER=$(stat -c %U "$release" 2>/dev/null || stat -f %Su "$release")"',
              'echo "SHARED_OWNER=$(stat -c %U "$shared" 2>/dev/null || stat -f %Su "$shared")"',
              'echo "SHARED_MODE=$(stat -c %a "$shared" 2>/dev/null || stat -f %Lp "$shared")"',
              'echo "STORAGE_WRITABLE=$([ -w "$shared/framework/views" ] && echo yes || echo no)"',
            ].join('\n'),
            { allowFailure: true },
          );

          const values = parseValues(probe.stdout);
          ctx.ui.section('Permissions');
          ctx.ui.status('Release owner', values.RELEASE_OWNER ?? 'unknown');
          ctx.ui.status('Shared storage owner', values.SHARED_OWNER ?? 'unknown');
          ctx.ui.status('Shared storage mode', values.SHARED_MODE ?? 'unknown');
          ctx.ui.status('Storage writable', values.STORAGE_WRITABLE ?? 'unknown');
          ctx.ui.info(`Web user: ${webInfo.webUser}:${webInfo.webGroup}`);

          const ok = values.STORAGE_WRITABLE === 'yes' && values.SHARED_OWNER === webInfo.webUser;
          if (!ok) ctx.ui.warn('Permissions look wrong.', 'Run `laravel-deploy permissions fix`.');
          if (flags.json) emitJson({ success: ok, ...values, webUser: webInfo.webUser });
          return ok ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });

  permissions
    .command('fix')
    .description('Apply the least-privilege permission policy')
    .option('--env <environment>', 'environment name', 'production')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-y, --yes', 'skip confirmation')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const executor = await ctx.connect();
          const layout = ctx.layout();
          const web = ctx.web(executor);
          const webInfo = await web.detect();
          const { planPermissions } = await import('../../providers/webserver/provider.js');

          const plan = planPermissions({
            releasePath: layout.appDir,
            sharedPath: layout.sharedDir,
            webUser: ctx.config.permissions.webUser ?? webInfo.webUser,
            webGroup: webInfo.webGroup,
            writableDirs: ctx.config.permissions.writable,
            dirMode: ctx.config.permissions.dirMode,
            fileMode: ctx.config.permissions.fileMode,
            chown: ctx.config.permissions.chown,
            chownShared: ctx.config.permissions.chownShared,
          });

          ctx.ui.section('Permissions');
          ctx.ui.info(`Web user: ${webInfo.webUser}:${webInfo.webGroup}`);
          ctx.ui.action('Applying permission policy');

          const result = await executor.exec(plan.steps.join('\n'), {
            label: 'permissions fix',
            allowFailure: true,
            timeoutMs: 180_000,
          });
          if (result.exitCode === 0) {
            ctx.ui.ok('Permissions applied');
            if (flags.json) emitJson({ success: true, steps: plan.steps.length });
            return 0;
          }
          ctx.ui.fail('Failed to apply permissions', result.stderr.trim().split('\n').pop() ?? '');
          if (flags.json) emitJson({ success: false, error: result.stderr.slice(-500) });
          return 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

function parseValues(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)=([\s\S]*)$/.exec(line);
    if (match) values[match[1] as string] = (match[2] ?? '').trim();
  }
  return values;
}