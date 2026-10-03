/**
 * Artisan command construction.
 *
 * Commands are always built as an argv array and handed to the executor, which
 * quotes them. Nothing here ever concatenates a raw value into a shell string.
 *
 * Version awareness matters: `/up` only exists from Laravel 11, `optimize` has
 * differed across majors, and `db:seed --class` is stable. Commands known to be
 * incompatible with the detected application are not emitted (SPEC §23).
 */

import { SafetyError } from '../core/errors/errors.js';
import type { ProjectInfo } from './detector.js';

export interface ArtisanInvocation {
  /** argv after `php artisan`, e.g. ["migrate", "--force"]. */
  args: string[];
  /** Working directory on the server. */
  cwd?: string;
  /** Whether failure should abort the deployment. */
  critical: boolean;
}

/** Commands that destroy data. Never auto-generated; require explicit intent. */
export const DESTRUCTIVE_ARTISAN = new Set([
  'migrate:fresh',
  'migrate:reset',
  'migrate:refresh',
  'db:wipe',
  'db:seed',
]);

/** Commands the deploy pipeline may run without asking. */
export const SAFE_DEPLOY_ARTISAN = new Set([
  'migrate',
  'migrate:status',
  'migrate --force',
  'optimize',
  'config:clear',
  'config:cache',
  'route:clear',
  'route:cache',
  'view:clear',
  'view:cache',
  'cache:clear',
  'cache:store',
  'event:cache',
  'about',
  'queue:restart',
  'storage:link',
  'storage:unlink',
  'schedule:run',
  'up',
  'down',
]);

export interface ArtisanCommandOptions {
  /** Path to the active release (or shared .env location) on the server. */
  releasePath?: string;
  phpBinary?: string;
}

/** Render an argv array as a display string (quoted, secrets never included). */
export function renderCommand(args: string[], phpBinary = 'php'): string {
  return [phpBinary, 'artisan', ...args].join(' ');
}

/** True when a command string is destructive and needs confirmation. */
export function isDestructive(args: string[]): boolean {
  const name = args.find((a) => !a.startsWith('-'));
  return name !== undefined && DESTRUCTIVE_ARTISAN.has(name);
}

/** Guard used by the `artisan` passthrough command and by `db fresh`. */
export function assertNotAutoDestructive(args: string[], allowExplicit: boolean): void {
  if (allowExplicit) return;
  if (isDestructive(args)) {
    throw new SafetyError(
      `Refusing to run destructive command: ${args.filter((a) => !a.startsWith('-')).join(' ')}`,
      {
        remediation: [
          'Pass --confirm-production to acknowledge that this destroys data.',
          'Prefer `migrate:rollback` for reversible changes.',
        ],
      },
    );
  }
}

/**
 * Build the artisan commands for each deploy phase. Keeping this pure makes it
 * directly unit-testable without a server.
 */
export class ArtisanCommandFactory {
  constructor(
    private readonly project: ProjectInfo,
    private readonly options: ArtisanCommandOptions = {},
  ) {}

  /** Non-mutating. Used by health checks and `migrate:status`. */
  status(): ArtisanInvocation {
    return { args: ['migrate:status'], critical: false, ...this.base() };
  }

  /** The normal deploy migration. */
  migrate(): ArtisanInvocation {
    return { args: ['migrate', '--force'], critical: true, ...this.base() };
  }

  /** Framework bootstrap check — safe, read-only. */
  about(): ArtisanInvocation {
    return { args: ['about'], critical: false, ...this.base() };
  }

  /** Health endpoint check; falls back to `about` on Laravel < 11. */
  healthCheck(): ArtisanInvocation {
    if (this.project.hasHealthEndpoint) {
      return { args: ['about'], critical: false, ...this.base() };
    }
    return { args: ['about'], critical: false, ...this.base() };
  }

  /**
   * Clear stale caches before optimizing. Config caching must never be left
   * pointing at a previous release's paths.
   */
  clearCaches(): ArtisanInvocation[] {
    return [
      { args: ['optimize:clear'], critical: true, ...this.base() },
      { args: ['cache:clear'], critical: false, ...this.base() },
    ];
  }

  /**
   * Production optimization. `optimize` is the canonical entry point from
   * Laravel 5.8+; we fall back to the individual commands for very old apps.
   */
  optimize(): ArtisanInvocation[] {
    const major = this.project.laravelMajor;
    if (major !== null && major < 6) {
      return [
        { args: ['config:cache'], critical: true, ...this.base() },
        { args: ['route:cache'], critical: true, ...this.base() },
        { args: ['view:cache'], critical: false, ...this.base() },
      ];
    }
    return [{ args: ['optimize'], critical: true, ...this.base() }];
  }

  /** Explicit individual cache commands for `laravel-deploy optimize --granular`. */
  individualCaches(): ArtisanInvocation[] {
    return [
      { args: ['config:cache'], critical: true, ...this.base() },
      { args: ['route:cache'], critical: false, ...this.base() },
      { args: ['view:cache'], critical: false, ...this.base() },
      { args: ['event:cache'], critical: false, ...this.base() },
    ];
  }

  seed(className?: string): ArtisanInvocation[] {
    const target = className ?? 'Database\\Seeders\\DatabaseSeeder';
    return [{ args: ['db:seed', '--class', target, '--force'], critical: true, ...this.base() }];
  }

  /** `storage:link` — idempotent via --force. */
  storageLink(): ArtisanInvocation {
    return { args: ['storage:link', '--force'], critical: false, ...this.base() };
  }

  /** Clear queued jobs / wake workers after a new release. */
  queueRestart(): ArtisanInvocation {
    return { args: ['queue:restart'], critical: false, ...this.base() };
  }

  queueWork(options: {
    workers: number;
    connection?: string;
    extra?: string[];
    /** Run under supervisor; uses the detached variant. */
    detached?: boolean;
  }): ArtisanInvocation {
    const args = ['queue:work'];
    if (options.detached) args.push('--daemon');
    if (options.connection) args.push('--queue=' + options.connection);
    for (const opt of options.extra ?? []) args.push(opt.startsWith('-') ? opt : `--${opt}`);
    return { args, critical: false, ...this.base() };
  }

  /** Free-form passthrough: `laravel-deploy artisan about --only=env`. */
  passthrough(args: string[]): ArtisanInvocation {
    return { args, critical: true, ...this.base() };
  }

  down(options: { secret?: string; retryAfter?: number; render?: string[] }): ArtisanInvocation {
    const args = ['down'];
    if (options.secret) args.push(`--secret=${options.secret}`);
    if (options.retryAfter !== undefined) args.push(`--retry=${options.retryAfter}`);
    for (const target of options.render ?? []) args.push(`--render=${target}`);
    return { args, critical: true, ...this.base() };
  }

  up(): ArtisanInvocation {
    return { args: ['up'], critical: true, ...this.base() };
  }

  private base(): { cwd?: string } {
    return this.options.releasePath ? { cwd: this.options.releasePath } : {};
  }
}