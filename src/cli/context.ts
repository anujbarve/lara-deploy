/**
 * CLI runtime context.
 *
 * Everything a command needs is assembled here once: resolved config, server
 * profile, SSH executor, panel adapter, secrets store and the UI. Commands stay
 * thin, which is what keeps them testable (SPEC §59).
 */

import { Command } from 'commander';
import { confirm, input } from '@inquirer/prompts';

import { loadGlobalConfig, loadProjectConfig } from '../core/config/loader.js';
import { resolvePaths, findProjectRoot, type CliPaths } from '../core/config/paths.js';
import type { AppConfig, ServerProfile } from '../core/config/schema.js';
import { createSecretsStore, type SecretsStore } from '../core/security/secrets.js';
import { ConfigError, toAppError, type AppError } from '../core/errors/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { TerminalUi, SilentUi, type Ui } from './ui/ui.js';
import { SshExecutor } from '../providers/exec/ssh.js';
import { AaPanelAdapter } from '../providers/aapanel/adapter.js';
import { WebServerProvider } from '../providers/webserver/provider.js';
import { SupervisorManager } from '../providers/supervisor/manager.js';
import { CronManager } from '../providers/cron/manager.js';
import { MysqlProvider } from '../providers/mysql/provider.js';
import { buildLayout, type SiteLayout } from '../core/release/layout.js';
import type { RemoteExecutor } from '../providers/exec/types.js';
import { systemClock, type Clock } from '../utils/ids.js';
import type { Confirmation } from '../core/deployment/confirmation.js';

/** Global flags every command accepts. */
export interface GlobalOptions {
  env?: string;
  config?: string;
  server?: string;
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
  noColor?: boolean;
  cwd?: string;
}

export interface Context {
  paths: CliPaths;
  config: AppConfig;
  environment: string;
  profile: ServerProfile;
  secrets: SecretsStore;
  ui: Ui;
  logger: Logger;
  clock: Clock;
  /** Lazily connected; closed by `ctx.dispose()`. */
  connect(): Promise<RemoteExecutor>;
  layout(): SiteLayout;
  panel(executor: RemoteExecutor): AaPanelAdapter;
  web(executor: RemoteExecutor): WebServerProvider;
  supervisor(executor: RemoteExecutor): SupervisorManager;
  cron(executor: RemoteExecutor): CronManager;
  mysql(executor: RemoteExecutor): MysqlProvider;
  dispose(): Promise<void>;
  /** Interactive confirmation, or auto-yes under --yes. */
  confirmation(): Confirmation;
  // Convenience delegates so commands can write `ctx.ok(...)` directly.
  section(title: string): void;
  ok(message: string, detail?: string): void;
  fail(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  action(message: string, detail?: string): void;
  info(message: string): void;
  note(message: string): void;
  detail(text: string): void;
  block(lines: string[]): void;
  summary(title: string, lines: string[]): void;
}

let executorInstance: SshExecutor | null = null;

/** Build the shared context for one command invocation. */
export async function createContext(options: GlobalOptions, command?: Command): Promise<Context> {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.env ?? 'production';

  // Find the project root so commands work from a subdirectory.
  const projectRoot = findProjectRoot(cwd) ?? cwd;
  const paths = resolvePaths(projectRoot);

  const { config } = loadProjectConfig({
    cwd: projectRoot,
    ...(options.env ? { env: options.env } : {}),
    ...(options.config ? { configPath: options.config } : {}),
    required: true,
  });

  const global = loadGlobalConfig();
  const serverName = options.server ?? config.server ?? global.defaultServer;
  const profile = global.servers[serverName];

  if (!profile) {
    const known = Object.keys(global.servers);
    throw new ConfigError(`Unknown server "${serverName}".`, {
      remediation: known.length > 0
        ? [`Known servers: ${known.join(', ')}`, 'Add one with `laravel-deploy server add`.']
        : ['Add one with `laravel-deploy server add`.'],
    });
  }

  const secrets = createSecretsStore(paths.secretsFile);
  const ui: Ui = options.json
    ? new SilentUi()
    : new TerminalUi({
        color: !options.noColor && process.env.NO_COLOR === undefined,
        quiet: Boolean(command?.opts()['quiet']),
      });

  const logger = createLogger({
    level: options.verbose ? 'debug' : options.json ? 'silent' : 'warn',
    logDir: paths.logDir,
    ...(options.json ? {} : { deploymentId: undefined }),
  });

  return {
    paths,
    config,
    environment,
    profile,
    secrets,
    ui,
    logger,
    clock: systemClock,

    async connect(): Promise<RemoteExecutor> {
      if (!executorInstance) {
        executorInstance = new SshExecutor({ profile, logger });
      }
      return executorInstance;
    },

    layout(): SiteLayout {
      return buildLayout({
        root: config.site.root ?? `${profile.siteRoot}/${config.site.domain}`,
        strategy: config.site.documentRootStrategy,
        legacyMainDir: config.legacy.mainDir,
        backupDirName: config.database.backupPath
          ? config.database.backupPath.replace(new RegExp(`/${config.site.domain}$`), '')
          : undefined,
      });
    },

    panel(executor: RemoteExecutor): AaPanelAdapter {
      return new AaPanelAdapter({ profile, config: profile.aapanel, executor, logger });
    },
    web: (executor) => new WebServerProvider(executor),
    supervisor: (executor) => new SupervisorManager({ executor }),
    cron: (executor) => new CronManager(executor),
    mysql: (executor) => new MysqlProvider({ executor, logger }),

    async dispose(): Promise<void> {
      await executorInstance?.close().catch(() => undefined);
      executorInstance = null;
    },

    section: (title) => ui.section(title),
    ok: (message, detail) => ui.ok(message, detail),
    fail: (message, detail) => ui.fail(message, detail),
    warn: (message, detail) => ui.warn(message, detail),
    action: (message, detail) => ui.action(message, detail),
    info: (message) => ui.info(message),
    note: (message) => ui.note(message),
    detail: (text) => ui.detail(text),
    block: (lines) => ui.block(lines),
    summary: (title, lines) => ui.summary(title, lines),

    confirmation(): Confirmation {
      if (options.yes) {
        return {
          confirmPlan: async () => true,
          confirmDestructive: async () => true,
        };
      }
      return {
        async confirmPlan(plan, input): Promise<boolean> {
          ui.section('Confirm');
          ui.info(`${input.environment} -> https://${config.site.domain}`);
          ui.info(`Release: ${input.release}`);
          if (input.pending !== null) ui.info(`Pending migrations: ${input.pending}`);
          ui.info(`Database: ${input.database}`);
          if (plan.infrastructure.items.some((item) => item.action === 'create')) {
            ui.warn('Infrastructure will be created on the server.');
          }
          return confirm({ message: 'Continue?', default: true });
        },
        async confirmDestructive(reason, expectedText): Promise<boolean> {
          ui.section('Confirm destructive operation');
          ui.warn(reason);
          const answer = await input({
            message: `Type ${expectedText} to confirm:`,
            validate: (value: string) =>
              value.trim() === expectedText ? true : `You must type "${expectedText}" exactly.`,
          });
          return answer.trim() === expectedText;
        },
      };
    },
  };
}

/** Run a command action with unified error reporting and exit codes. */
export async function runCommand(action: () => Promise<number | void>): Promise<void> {
  try {
    const code = await action();
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  } catch (error) {
    const appError: AppError = toAppError(error);
    reportError(appError);
    process.exitCode = 1;
  }
}

/** The five questions, every failure must answer (SPEC §50). */
export function reportError(error: AppError): void {
  const lines: string[] = [];
  lines.push(`\n✗ ${error.name}: ${error.message}`);

  if (error.command) {
    lines.push('');
    lines.push('Command:');
    lines.push(`  ${error.command}`);
  }
  if (error.details && Object.keys(error.details).length > 0) {
    const stderr = error.details.stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      lines.push('');
      lines.push('Output:');
      for (const line of stderr.split(/\r?\n/).slice(-15)) lines.push(`  ${line}`);
    }
  }
  if (error.remediation.length > 0) {
    lines.push('');
    lines.push('What to do:');
    for (const line of error.remediation) lines.push(`  → ${line}`);
  }
  lines.push('');
  lines.push(
    error.liveAffected
      ? 'Note: the live deployment WAS affected. See the summary above.'
      : 'Note: the live deployment was NOT changed.',
  );

  process.stderr.write(`${lines.join('\n')}\n`);
}

/** Parse --json output from a command result. */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}