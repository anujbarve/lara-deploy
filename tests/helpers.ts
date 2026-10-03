/**
 * Test helpers: a fake RemoteExecutor that answers from a script, plus a small
 * fixture builder. Nothing here touches the network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ExecOptions,
  ExecResult,
  ExecutorInfo,
  RemoteExecutor,
} from '../src/providers/exec/types.js';

export interface FakeResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type Matcher = (command: string) => boolean;

export class FakeExecutor implements RemoteExecutor {
  /** Every command this executor was asked to run, in order. */
  readonly commands: string[] = [];

  private readonly handlers: Array<{ match: Matcher; response: FakeResponse | (() => FakeResponse) }> = [];

  /** Default for anything not matched. */
  fallback: FakeResponse = { exitCode: 0, stdout: '' };

  /** Answer commands containing `needle`. */
  on(needle: string | RegExp, response: FakeResponse | (() => FakeResponse)): this {
    const match: Matcher =
      typeof needle === 'string'
        ? (command) => command.includes(needle)
        : (command) => needle.test(command);
    this.handlers.push({ match, response });
    return this;
  }

  /** Fail any command containing `needle`. */
  fail(needle: string | RegExp, stderr = 'boom'): this {
    return this.on(needle, { exitCode: 1, stderr });
  }

  async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    // Later registrations win, so a test can override the default happy path.
    const handler = [...this.handlers].reverse().find((entry) => entry.match(command));
    const response = handler
      ? typeof handler.response === 'function'
        ? handler.response()
        : handler.response
      : this.fallback;
    return {
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      exitCode: response.exitCode ?? 0,
      durationMs: 1,
      command,
    };
  }

  async execFile(file: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    return this.exec([file, ...args].join(' '), options);
  }

  async which(command: string): Promise<boolean> {
    return !this.commands.some((c) => c.includes(`command -v ${command}`)) || true;
  }

  async info(): Promise<ExecutorInfo> {
    return { hostname: 'test-host', user: 'root', os: 'Linux 6.1', platform: 'remote' };
  }

  async close(): Promise<void> {
    /* nothing */
  }

  /** Did any command contain this text? */
  saw(needle: string): boolean {
    return this.commands.some((command) => command.includes(needle));
  }
}

/** Create a Laravel-shaped fixture project on disk. */
export function makeLaravelFixture(options: {
  laravel?: string;
  php?: string;
  withPackageJson?: boolean;
  lockfile?: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | 'bun.lock';
  withMigrations?: boolean;
  withSeeders?: boolean;
  withVite?: boolean;
  dotEnvExample?: string;
  extras?: Record<string, string>;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-deploy-test-'));

  fs.writeFileSync(path.join(root, 'artisan'), "#!/usr/bin/env php\n<?php\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(root, 'composer.json'),
    JSON.stringify(
      {
        name: 'acme/client-site',
        require: {
          'laravel/framework': options.laravel ?? '^11.0',
          php: options.php ?? '^8.2',
        },
        'require-dev': { 'laravel/pint': '^1.0' },
      },
      null,
      2,
    ),
  );

  for (const dir of ['app', 'bootstrap', 'config', 'routes', 'database', 'storage/app', 'public']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'bootstrap', 'app.php'), '<?php return Application::configure()', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(root, 'config', 'app.php'), '<?php return [];');
  fs.writeFileSync(path.join(root, 'public', 'index.php'), '<?php');
  fs.writeFileSync(
    path.join(root, 'routes', 'console.php'),
    options.withSeeders ? '' : 'Schedule::command("inspire")->hourly();',
  );

  if (options.withMigrations !== false) {
    fs.mkdirSync(path.join(root, 'database', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'database', 'migrations', '2024_01_01_000000_create_users_table.php'), '<?php');
  }
  if (options.withSeeders) {
    fs.mkdirSync(path.join(root, 'database', 'seeders'), { recursive: true });
    fs.writeFileSync(path.join(root, 'database', 'seeders', 'DatabaseSeeder.php'), '<?php');
  }

  if (options.withPackageJson !== false) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        { name: 'client-site', scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { vite: '^5' } },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(root, options.lockfile ?? 'package-lock.json'),
      options.lockfile === 'pnpm-lock.yaml' ? 'lockfileVersion: 9\n' : '{ "lockfileVersion": 3 }',
    );
  }
  if (options.withVite) {
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}');
  }

  fs.writeFileSync(
    path.join(root, '.env.example'),
    options.dotEnvExample ??
      [
        'APP_NAME=Client',
        'APP_ENV=local',
        'APP_KEY=',
        'APP_DEBUG=true',
        'APP_URL=http://localhost',
        'DB_CONNECTION=mysql',
        'DB_HOST=127.0.0.1',
        'DB_PORT=3306',
        'DB_DATABASE=client_site',
        'DB_USERNAME=client_site',
        'DB_PASSWORD=',
        'QUEUE_CONNECTION=database',
        'MAIL_HOST=smtp.example.com',
      ].join('\n'),
  );

  for (const [name, contents] of Object.entries(options.extras ?? {})) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  return root;
}

/** Remove a fixture tree. */
export function cleanupFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

/** A minimal valid app config for tests. */
export function appConfigFixture(overrides: Record<string, unknown> = {}) {
  return {
    server: 'test',
    site: { domain: 'example.com', documentRootStrategy: 'public', root: '/www/wwwroot/example.com' },
    ...overrides,
  };
}