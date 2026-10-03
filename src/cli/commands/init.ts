/**
 * `laravel-deploy init` — create .lar-deploy.json interactively.
 *
 * Only asks for what is genuinely missing, and writes a reusable configuration
 * so that later `deploy` runs need no questions (SPEC §46).
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { emitJson, runCommand, type GlobalOptions } from '../context.js';
import { validateAppConfig } from '../../core/config/loader.js';
import { loadGlobalConfig } from '../../core/config/loader.js';
import { PROJECT_CONFIG_BASENAME } from '../../core/config/paths.js';
import { inspectProject, slugify, looksLikeLaravel } from '../../laravel/detector.js';
import { TerminalUi } from '../ui/ui.js';
import { formatConfigIssues } from '../../core/config/loader.js';
import { ConfigError } from '../../core/errors/errors.js';
import type { ServerProfile } from '../../core/config/schema.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create a deployment configuration interactively')
    .option('--env <environment>', 'write .laravel-deploy.<environment>.json instead', 'production')
    .option('--force', 'overwrite an existing configuration file')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-y, --yes', 'accept defaults for everything it can detect')
    .action(async (flags: GlobalOptions & { force?: boolean }) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        const cwd = flags.cwd ?? process.cwd();
        const target = path.join(cwd, `.laravel-deploy.${flags.env ?? 'production'}.json`);

        const existing = path.join(cwd, PROJECT_CONFIG_BASENAME);
        if (fs.existsSync(existing) && !flags.force) {
          const overwrite = await confirm({
            message: `${PROJECT_CONFIG_BASENAME} already exists. Overwrite?`,
            default: false,
          });
          if (!overwrite) {
            ui.warn('Cancelled.', `${PROJECT_CONFIG_BASENAME} was left untouched.`);
            return 1;
          }
        }

        if (!looksLikeLaravel(cwd)) {
          throw new ConfigError(`${cwd} does not look like a Laravel project.`, {
            remediation: [
              'Expected artisan, composer.json and app/ bootstrap/ config/ routes/.',
              'Run `laravel-deploy init` from your Laravel project root.',
            ],
          });
        }

        const project = inspectProject(cwd);
        ui.section('Project');
        ui.status('Laravel detected', `${project.name} (Laravel ${project.laravelMajor ?? 'unknown'})`);
        if (project.phpRequirement) ui.status('PHP requirement', project.phpRequirement);
        if (project.packageManager) ui.status('Package manager', project.packageManager);

        // --- server ---------------------------------------------------------
        // Read the global server profiles directly: the project config does not
        // exist yet, so createContext() would fail.
        const global = loadGlobalConfig();
        const servers: Record<string, ServerProfile> = global.servers as Record<string, ServerProfile>;
        const serverNames = Object.keys(servers);
        let serverName: string;
        if (serverNames.length === 0) {
          throw new ConfigError('No server profiles are configured.', {
            remediation: ['Run `laravel-deploy server add` first, then re-run `init`.'],
          });
        }

        if (serverNames.length === 1) {
          serverName = serverNames[0] as string;
          ui.status('Server', serverName);
        } else {
          serverName = await select({
            message: 'Select server:',
            choices: serverNames.map((name: string) => ({ name, value: name })),
          });
        }

        const profile = servers[serverName] as ServerProfile | undefined;
        const siteRoot = profile?.siteRoot ?? '/www/wwwroot';

        // --- domain ---------------------------------------------------------
        let domain = await input({
          message: 'Domain:',
          validate: (value: string) => {
            const trimmed = value.trim();
            if (trimmed === '') return 'A domain is required.';
            if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed)) {
              return `"${trimmed}" is not a valid hostname.`;
            }
            return true;
          },
        });
        domain = domain.trim();

        // --- behaviour ------------------------------------------------------
        ui.section('Behaviour');
        const createWebsite = await confirm({ message: 'Create the website if missing?', default: true });
        const createDatabase = await confirm({ message: 'Create the database if missing?', default: true });
        const runMigrations = await confirm({ message: 'Run migrations?', default: true });
        const runSeeders = await confirm({ message: 'Run seeders?', default: false });
        const enableSsl = await confirm({ message: 'Enable SSL?', default: true });
        const useQueue = await confirm({
          message: project.hints.queue ? 'Queue workers detected. Configure them?' : 'Configure queue workers?',
          default: project.hints.queue,
        });
        const useScheduler = await confirm({
          message: project.hints.scheduler ? 'Scheduled tasks detected. Configure the scheduler?' : 'Configure the scheduler?',
          default: project.hints.scheduler,
        });
        const keepReleases = await input({
          message: 'How many releases to keep?',
          default: '5',
          validate: (value: string) => (Number.isInteger(Number(value)) && Number(value) >= 1 ? true : 'Must be a number >= 1.'),
        });

        const dbName = slugify(project.name) || slugify(domain.split('.')[0] ?? 'app');

        const raw = {
          $schema: 'https://laravel-deploy.dev/schema.json',
          server: serverName,
          site: {
            domain,
            documentRootStrategy: 'public',
            root: `${siteRoot}/${domain}`,
          },
          deployment: {
            build: true,
            composer: true,
            migrations: runMigrations,
            seeders: runSeeders,
            optimize: true,
            healthCheck: true,
            backupDatabaseBeforeMigration: true,
            keepReleases: Number(keepReleases),
          },
          php: { binary: 'php' },
          database: {
            driver: 'mysql',
            createIfMissing: createDatabase,
            name: dbName,
            username: dbName,
          },
          ssl: {
            enabled: enableSsl,
            provider: 'letsencrypt',
          },
          queue: { enabled: useQueue, workers: 1, connection: 'default' },
          scheduler: { enabled: useScheduler, schedule: '* * * * *' },
          ...(createWebsite ? {} : { site: { domain, documentRootStrategy: 'public', root: `${siteRoot}/${domain}`, provision: false } }),
        };

        // Validate before writing so a broken config never lands on disk.
        try {
          validateAppConfig(raw, target);
        } catch (error) {
          const issues = (error as { issues?: Array<{ path: string; message: string }> }).issues;
          if (issues) {
            throw new ConfigError('The generated configuration is invalid.', {
              remediation: [formatConfigIssues(issues)],
            });
          }
          throw error;
        }

        fs.writeFileSync(target, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

        ui.section('Written');
        ui.ok(target, '');
        ui.info('');
        ui.info('Next:');
        ui.info('  laravel-deploy deploy --plan     # review the plan');
        ui.info('  laravel-deploy deploy           # deploy it');
        ui.info('  laravel-deploy status           # check health');
        ui.info('');

        if (flags.json) emitJson({ success: true, configFile: target, config: raw });
        return 0;
      });
    });

  void chalk;
}