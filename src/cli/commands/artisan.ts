/**
 * `laravel-deploy artisan <command>` — run artisan on the active release.
 *
 * Arguments are passed through verbatim: this command never reinterprets what
 * you typed. The exact command is always displayed before it runs (SPEC §24).
 */

import { Command } from 'commander';
import { createContext, emitJson, runCommand, type GlobalOptions } from '../context.js';
import { renderCommand, isDestructive } from '../../laravel/artisan.js';
import { q } from '../../utils/shell.js';
import { redactOutput } from '../../utils/redact.js';

export function registerArtisanCommand(program: Command): Command {
  const artisan = program
    .command('artisan')
    .description('Run an artisan command against the active release on the server')
    .argument('<command...>', 'artisan command and arguments')
    .allowUnknownOption()
    .option('--env <environment>', 'environment name', 'production')
    .option('--config <path>', 'explicit configuration file')
    .option('--server <name>', 'override the configured server')
    .option('--confirm-production', 'acknowledge a destructive command')
    .option('--json', 'machine-readable output')
    .option('--cwd <path>', 'project directory')
    .option('-v, --verbose', 'verbose output')
    .option('--no-color', 'disable colour');

  artisan.action(async (args: string[], flags: GlobalOptions & { confirmProduction?: boolean }) => {
    await runCommand(async () => {
      const ctx = await createContext(flags);
      try {
        const layout = ctx.layout();
        const executor = await ctx.connect();
        const phpBinary = ctx.config.php.remoteBinary ?? ctx.config.php.binary;
        const display = renderCommand(args, phpBinary);

        // Destructive commands need explicit acknowledgement (SPEC §48).
        if (isDestructive(args) && !flags.confirmProduction) {
          throw new Error(
            `Refusing to run a destructive command without confirmation: ${display}`,
          );
        }

        ctx.ui.section('Artisan');
        ctx.ui.command(display, `${layout.appDir}`);

        const result = await executor.exec(
          ['set -Eeuo pipefail', `cd ${q(layout.appDir)}`, `${q(phpBinary)} artisan ${args.map((a) => q(a)).join(' ')}`].join('\n'),
          { label: 'artisan', timeoutMs: ctx.config.timeouts.artisan, allowFailure: true },
        );

        if (result.stdout.trim()) ctx.ui.block(redactOutput(result.stdout).trimEnd().split('\n'));
        if (result.stderr.trim()) ctx.ui.block(redactOutput(result.stderr).trimEnd().split('\n'));

        if (flags.json) {
          emitJson({
            success: result.exitCode === 0,
            command: display,
            exitCode: result.exitCode,
            stdout: redactOutput(result.stdout),
            stderr: redactOutput(result.stderr),
          });
        }
        return result.exitCode === 0 ? 0 : 1;
      } finally {
        await ctx.dispose();
      }
    });
  });

  return artisan;
}