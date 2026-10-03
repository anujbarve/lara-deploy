#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Registers every command and wires the global error handler. Nothing here
 * contains deployment logic — commands are thin wrappers over the core.
 */

import { Command, Option } from 'commander';
import chalk from 'chalk';

import { registerDeployCommand } from './commands/deploy.js';
import { registerInitCommand } from './commands/init.js';
import { registerServerCommand, registerSecretsCommand } from './commands/server.js';
import { registerStatusCommand, registerDoctorCommand } from './commands/status.js';
import { registerRollbackCommand } from './commands/rollback.js';
import { registerArtisanCommand } from './commands/artisan.js';
import { registerMigrateCommands } from './commands/migrate.js';
import {
  registerQueueCommand,
  registerSchedulerCommand,
  registerStorageCommand,
  registerMaintenanceCommand,
} from './commands/queue.js';
import {
  registerLogsCommand,
  registerHistoryCommand,
  registerDomainCommand,
  registerOptimizeCommand,
  registerDatabaseCommand,
  registerSiteCommand,
  registerPermissionsCommand,
} from './commands/ops.js';
import { reportError } from './context.js';
import { toAppError } from '../core/errors/errors.js';

export const VERSION = '1.0.0';

/** Build the commander program. Exported so tests can drive it. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('laravel-deploy')
    .description(
      chalk.bold('Deploy Laravel applications to aaPanel-managed VPS servers.') +
        '\n\n' +
        'The primary command is `laravel-deploy deploy`: it detects the project, ' +
        'provisions missing infrastructure, builds, uploads, configures, migrates, ' +
        'activates an immutable release, verifies it, and cleans up.',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .configureOutput({
      outputError: (str, write) => write(chalk.red(str)),
    })
    .showHelpAfterError('(run `laravel-deploy --help` for usage)');

  // Global options available to every command.
  program
    .option('--env <environment>', 'environment name', undefined)
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--json', 'machine-readable output for CI')
    .option('--verbose', 'verbose output')
    .option('--no-color', 'disable colour output')
    .option('--cwd <path>', 'project directory')
    .enablePositionalOptions();

  // Deployment.
  registerDeployCommand(program);
  registerInitCommand(program);
  registerRollbackCommand(program);

  // Diagnostics.
  registerStatusCommand(program);
  registerDoctorCommand(program);
  registerLogsCommand(program);
  registerHistoryCommand(program);

  // Laravel operations.
  registerArtisanCommand(program);
  registerMigrateCommands(program);
  registerOptimizeCommand(program);
  registerMaintenanceCommand(program);
  registerStorageCommand(program);
  registerPermissionsCommand(program);

  // Infrastructure.
  registerServerCommand(program);
  registerSecretsCommand(program);
  registerSiteCommand(program);
  registerQueueCommand(program);
  registerSchedulerCommand(program);
  registerDatabaseCommand(program);
  registerDomainCommand(program);

  program
    .command('version')
    .description('print the version')
    .action(() => {
      process.stdout.write(`laravel-deploy ${VERSION}\n`);
    });

  return program;
}

/** Parse argv and run. Never lets an exception escape unformatted. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  program.addHelpText(
    'after',
    `
Examples:
  $ laravel-deploy init                        create a deployment config
  $ laravel-deploy deploy                      full deployment lifecycle
  $ laravel-deploy deploy --plan               review what would happen
  $ laravel-deploy deploy --dry-run            show intent, change nothing
  $ laravel-deploy status                      full health check
  $ laravel-deploy doctor                      deep diagnostics
  $ laravel-deploy rollback                    restore the previous release
  $ laravel-deploy artisan queue:restart       run artisan on the live release
  $ laravel-deploy migrate:status              show migration status
  $ laravel-deploy logs nginx                  inspect the web server log

Documentation: https://github.com/your-org/laravel-deploy#readme
`,
  );

  try {
    await program.parseAsync(argv);
  } catch (error) {
    reportError(toAppError(error));
    process.exitCode = 1;
  }
}

export { Option };