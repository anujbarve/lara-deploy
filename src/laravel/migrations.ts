/**
 * Migration planning.
 *
 * Migrations are never destructive without explicit intent (SPEC §21, §48), and
 * the pre-flight summary must show the database, the environment and the number
 * of pending migrations.
 */

import type { ArtisanInvocation } from './artisan.js';
import { SafetyError, ConfirmationRequiredError } from '../core/errors/errors.js';

export type MigrationMode =
  | 'deploy'
  | 'status'
  | 'rollback'
  | 'reset'
  | 'refresh'
  | 'fresh';

export interface MigrationPlanInput {
  mode: MigrationMode;
  /** Number of migrations to step back for `rollback`. */
  step?: number;
  /** Seeder class for `refresh --seed` / `fresh --seed`. */
  seedClass?: string;
  /** Production deployments need `--force`. */
  force: boolean;
  /** User acknowledged a destructive operation. */
  confirmedProduction: boolean;
  /** Whether the target is production. */
  isProduction: boolean;
  /** Migration path filter. */
  path?: string;
  /** Realpath or force for the migrations table. */
  realpath?: boolean;
}

export interface MigrationPlan {
  mode: MigrationMode;
  args: string[];
  /** Display string, already safe to print. */
  display: string;
  destructive: boolean;
  requiresProductionConfirmation: boolean;
  requiresConfirmation: boolean;
}

/** Parse `php artisan migrate:status` output into per-batch counts. */
export interface MigrationStatus {
  pending: number;
  ran: number;
  migrations: Array<{ name: string; ran: boolean; batch: number | null }>;
}

export function buildMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  const destructive = input.mode === 'fresh' || input.mode === 'reset' || input.mode === 'refresh';
  const args = ['migrate'];

  switch (input.mode) {
    case 'status':
      args[0] = 'migrate:status';
      break;
    case 'rollback':
      args.push('--step', String(input.step ?? 0));
      break;
    case 'reset':
      args[0] = 'migrate:reset';
      break;
    case 'refresh':
      args[0] = 'migrate:refresh';
      if (input.step !== undefined) args.push('--step', String(input.step));
      break;
    case 'fresh':
      args[0] = 'migrate:fresh';
      break;
    case 'deploy':
      break;
    default:
      break;
  }

  if (input.path) args.push(`--path=${input.path}`);
  if (input.realpath) args.push(`--realpath`);
  if (input.mode !== 'status') {
    if (input.force) args.push('--force');
    // Seeding via migration is never implicit; only when explicitly requested.
    if (input.seedClass && (input.mode === 'fresh' || input.mode === 'refresh')) {
      args.push('--seeder', input.seedClass);
    }
  }

  const requiresProductionConfirmation =
    destructive && input.isProduction && !input.confirmedProduction;

  return {
    mode: input.mode,
    args,
    display: `php artisan ${args.join(' ')}`,
    destructive,
    requiresProductionConfirmation,
    requiresConfirmation: destructive || !input.force,
  };
}

/**
 * Enforce the safety layer.
 *
 * `migrate:fresh` and `migrate:reset` on production require
 * --confirm-production *and* a typed domain confirmation, which the CLI layer
 * supplies. Here we only enforce the flag.
 */
export function assertMigrationAllowed(plan: MigrationPlan): void {
  if (plan.requiresProductionConfirmation) {
    throw new ConfirmationRequiredError(
      `${plan.display} would destroy all data in the production database.`,
      {
        command: plan.display,
        liveAffected: true,
        remediation: [
          'Re-run with --confirm-production if you are certain.',
          'Consider `laravel-deploy migrate:rollback` for a reversible alternative.',
        ],
      }
    );
  }
}

/**
 * Parse `migrate:status` table output.
 *
 * Laravel prints something like:
 *
 *   +-----+---------------------+-------+
 *   | Ran? | Migration           | Batch |
 *   +-----+---------------------+-------+
 *   | Yes | 2024_01_01_000000_create_users | 1 |
 *   | No  | 2024_01_02_000000_add_x        |     |
 */
export function parseMigrateStatus(output: string): MigrationStatus {
  const migrations: MigrationStatus['migrations'] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || !line.startsWith('|')) continue;

    // Split without dropping empty cells: a pending migration has an empty
    // Batch column, and dropping empties would shift the columns.
    const parts = line.split('|');
    const cells = parts.slice(1, parts.length - 1).map((cell) => cell.trim());
    if (cells.length < 2) continue;

    const [ran, name, batch] = cells as [string, string, string | undefined];
    if (ran !== 'Yes' && ran !== 'No') continue;
    if (name === 'Migration' || name === '') continue;

    const batchNumber = batch !== undefined && /^\d+$/.test(batch) ? Number(batch) : null;
    migrations.push({ name, ran: ran === 'Yes', batch: batchNumber });
  }
  return {
    pending: migrations.filter((m) => !m.ran).length,
    ran: migrations.filter((m) => m.ran).length,
    migrations,
  };
}

/** Migration files that exist locally but are not yet in the release. */
export function countMigrationFiles(dir: string, list: readonly string[]): number {
  const known = new Set(list);
  let count = 0;
  for (const name of dir.split('\n')) {
    const file = name.trim();
    if (file === '') continue;
    if (!known.has(file)) count += 1;
  }
  return count;
}

/** The confirmation summary shown before migrations run (SPEC §21). */
export function migrationConfirmationSummary(input: {
  database: string;
  environment: string;
  pending: number;
  release: string;
}): string[] {
  return [
    `Database: ${input.database}`,
    `Environment: ${input.environment}`,
    `Pending migrations: ${input.pending}`,
    `Release: ${input.release}`,
  ];
}

/** Destructive commands must never be produced by the automatic pipeline. */
export function assertDeployPipelineSafe(args: string[]): void {
  const name = args.find((a) => !a.startsWith('-'));
  if (name && (name === 'migrate:fresh' || name === 'migrate:reset' || name === 'db:wipe')) {
    throw new SafetyError(`The deploy pipeline must never run ${name}.`);
  }
}