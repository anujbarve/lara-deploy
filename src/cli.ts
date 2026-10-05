#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { serverCommand } from './commands/server.js';
import { preflightCommand } from './commands/preflight.js';
import { migrateCommand, seedCommand, statusCommand } from './commands/remote.js';
import { loadConfig } from './config.js';
import { deploy } from './deploy.js';
import { printError, setVerbose, title } from './ui.js';

const program = new Command().name('lara-deploy').description('Deploy a Laravel app to an aaPanel VPS');

// Wrap every action so errors print cleanly (no stack trace unless --verbose).
const run =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      printError(e);
      process.exitCode = 1;
    }
  };

program
  .command('server')
  .description('Save the VPS and aaPanel credentials once, for every project')
  .option('--show', 'show the saved credentials (secrets hidden)')
  .option('--forget', 'delete the saved credentials')
  .action(run(serverCommand));

program.command('init').description('Configure a site (uses the credentials saved by `server`)').action(run(initCommand));

program
  .command('preflight')
  .alias('doctor')
  .description('Check SSH, the aaPanel API, the website and the database before deploying')
  .action(run(preflightCommand));

program
  .command('deploy')
  .description('Build, upload and deploy the app')
  .option('--skip-build', 'skip composer install and npm run build')
  .option('--seed', 'run seeders after migrating')
  .option('--verbose', 'show detailed output')
  .action(
    run(async (o: { skipBuild?: boolean; seed?: boolean; verbose?: boolean }) => {
      setVerbose(!!o.verbose);
      title();
      await deploy(loadConfig(), { skipBuild: !!o.skipBuild, seed: !!o.seed, verbose: !!o.verbose });
    }),
  );

program
  .command('migrate')
  .description('Run php artisan migrate --force on the server')
  .option('--status', 'show migrate:status instead')
  .option('--verbose', 'show detailed output')
  .action(run(async (o: { status?: boolean; verbose?: boolean }) => {
    setVerbose(!!o.verbose);
    await migrateCommand(o);
  }));

program
  .command('seed')
  .description('Run php artisan db:seed --force on the server')
  .option('--verbose', 'show detailed output')
  .action(run(async (o: { verbose?: boolean }) => {
    setVerbose(!!o.verbose);
    await seedCommand();
  }));

program.command('status').description('Check the deployed site').action(run(statusCommand));

await program.parseAsync();
