/**
 * `laravel-deploy migrate*` and `laravel-deploy seed`.
 *
 * Destructive operations (fresh, reset) require a typed domain confirmation.
 */

import { Command } from 'commander';
import { confirm, input } from '@inquirer/prompts';

import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import {
  buildMigrationPlan,
  assertMigrationAllowed,
  parseMigrateStatus,
  migrationConfirmationSummary,
  type MigrationMode,
} from '../../laravel/migrations.js';
import { q } from '../../utils/shell.js';
import { redactOutput } from '../../utils/redact.js';
import { ConfirmationRequiredError } from '../../core/errors/errors.js';
import type { Confirmation } from '../../core/deployment/confirmation.js';

interface MigrateFlags extends GlobalOptions {
  step?: string;
  force?: boolean;
  confirmProduction?: boolean;
  path?: string;
}

export function registerMigrateCommands(program: Command): void {
  addMigrate(program, 'migrate', 'Run pending migrations on the active release', 'deploy');
  addMigrate(program, 'migrate:status', 'Show migration status', 'status');
  addMigrate(program, 'migrate:rollback', 'Roll back the last batch of migrations', 'rollback');
  addMigrate(program, 'migrate:reset', 'Roll back every migration (destructive)', 'reset');
  addMigrate(program, 'migrate:refresh', 'Roll back and re-run every migration (destructive)', 'refresh');
  addMigrate(program, 'migrate:fresh', 'Drop all tables and re-run migrations (destructive)', 'fresh');

  registerSeedCommand(program);
}

function addMigrate(program: Command, name: string, description: string, mode: MigrationMode): void {
  program
    .command(name)
    .description(description)
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--step <n>', 'number of batches/rows for rollback/refresh')
    .option('--force', 'pass --force to artisan')
    .option('--path <path>', 'migration path filter')
    .option('--confirm-production', 'acknowledge a destructive production operation')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour')
    .action(async (flags: MigrateFlags) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const layout = ctx.layout();
          const executor = await ctx.connect();
          const phpBinary = ctx.config.php.remoteBinary ?? ctx.config.php.binary;

          const plan = buildMigrationPlan({
            mode,
            ...(flags.step ? { step: Number(flags.step) } : {}),
            force: flags.force ?? mode === 'deploy',
            confirmedProduction: Boolean(flags.confirmProduction),
            isProduction: ctx.environment === 'production',
            ...(flags.path ? { path: flags.path } : {}),
          });

          // Enforce the safety layer (SPEC §21, §48).
          assertMigrationAllowed(plan);

          // Show pending counts before a destructive operation.
          if (mode === 'fresh' || mode === 'reset' || mode === 'refresh') {
            const statusResult = await executor.exec(
              `cd ${q(layout.appDir)} && ${q(phpBinary)} artisan migrate:status 2>/dev/null || true`,
              { allowFailure: true, timeoutMs: ctx.config.timeouts.artisan },
            );
            const pending = parseMigrateStatus(statusResult.stdout).pending;

            ctx.ui.section('Confirm');
            for (const line of migrationConfirmationSummary({
              database: ctx.config.database.name ?? 'default',
              environment: ctx.environment,
              pending,
              release: 'current',
            })) {
              ctx.ui.info(line);
            }
            ctx.ui.warn(`${plan.display} destroys all data in this database.`);

            const confirmation: Confirmation = ctx.confirmation();
            const typed =
              flags.yes ||
              flags.confirmProduction ||
              (await typedConfirmation(ctx.config.site.domain));
            if (!typed) {
              ctx.ui.warn('Cancelled.');
              if (flags.json) emitJson({ success: false, reason: 'cancelled' });
              return 1;
            }
            void confirmation;
          } else if (!flags.yes && !flags.force && mode === 'deploy') {
            const ok = await confirm({ message: 'Run migrations now?', default: true });
            if (!ok) return 1;
          }

          ctx.ui.section('Migrate');
          ctx.ui.command(plan.display, layout.appDir);

          const result = await executor.exec(
            `cd ${q(layout.appDir)} && ${q(phpBinary)} artisan ${plan.args.map((a) => (/^-{1,2}[A-Za-z]/.test(a) ? a : q(a))).join(' ')}`,
            { label: plan.mode, timeoutMs: ctx.config.timeouts.artisan, allowFailure: true },
          );

          const stdout = redactOutput(result.stdout).trim();
          const stderr = redactOutput(result.stderr).trim();
          if (stdout) ctx.ui.block(stdout.split('\n'));
          if (stderr) ctx.ui.block(stderr.split('\n'));

          if (mode === 'status' && stdout) {
            const parsed = parseMigrateStatus(stdout);
            ctx.ui.section('Summary');
            ctx.ui.status('Applied', String(parsed.ran));
            ctx.ui.status('Pending', String(parsed.pending));
          }

          if (flags.json) {
            emitJson({
              success: result.exitCode === 0,
              command: plan.display,
              exitCode: result.exitCode,
              stdout,
              stderr,
            });
          }
          return result.exitCode === 0 ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

/** Type the domain to confirm a destructive production operation. */
async function typedConfirmation(domain: string): Promise<boolean> {
  const answer = await input({
    message: `Type the domain name (${domain}) to confirm:`,
    validate: (value: string) =>
      value.trim() === domain ? true : `You must type "${domain}" exactly.`,
  });
  return answer.trim() === domain;
}

function registerSeedCommand(program: Command): void {
  program
    .command('seed')
    .description('Run database seeders on the active release')
    .argument('[class]', 'seeder class', 'Database\\Seeders\\DatabaseSeeder')
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour')
    .action(async (className: string, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ctx = await createContext(flags);
        try {
          const layout = ctx.layout();
          const executor = await ctx.connect();
          const phpBinary = ctx.config.php.remoteBinary ?? ctx.config.php.binary;
          const display = `php artisan db:seed --class ${className} --force`;

          ctx.ui.section('Seed');
          ctx.ui.command(display, layout.appDir);

          const result = await executor.exec(
            `cd ${q(layout.appDir)} && ${q(phpBinary)} artisan db:seed --class ${q(className)} --force`,
            { label: 'db:seed', timeoutMs: ctx.config.timeouts.artisan, allowFailure: true },
          );

          const stdout = redactOutput(result.stdout).trim();
          if (stdout) ctx.ui.block(stdout.split('\n'));
          if (result.exitCode === 0) ctx.ok('Seeding complete');
          else ctx.fail('Seeding failed', redactOutput(result.stderr).trim().split('\n').pop() ?? '');

          if (flags.json) emitJson({ success: result.exitCode === 0, command: display, stdout });
          return result.exitCode === 0 ? 0 : 1;
        } finally {
          await ctx.dispose();
        }
      });
    });
}

void ConfirmationRequiredError;