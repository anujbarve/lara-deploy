/**
 * Seeders.
 *
 * Production default is: never seed. Seeding only happens when the operator
 * asks for it explicitly (`--seed`, `--no-seed`, or config opt-in), and
 * `migrate:fresh --seed` is never produced by the deploy pipeline (SPEC §22).
 */

import type { SeedersConfig } from '../core/config/schema.js';
import { ArtisanCommandFactory, type ArtisanInvocation } from './artisan.js';

export interface SeederDecisionInput {
  config: SeedersConfig;
  /** `--seed` passed on the CLI. */
  cliSeed?: boolean;
  /** `--no-seed` passed on the CLI. */
  cliNoSeed?: boolean;
  /** The deployment is targeting production. */
  isProduction: boolean;
  /** First deployment to this site. */
  isFirstDeploy: boolean;
  /** Non-interactive mode; seeders are skipped unless explicitly enabled. */
  nonInteractive: boolean;
}

export interface SeederDecision {
  enabled: boolean;
  reason: string;
  /** Classes to run, main class first. */
  classes: string[];
}

export function decideSeeders(input: SeederDecisionInput): SeederDecision {
  const classes = dedupe([input.config.class, ...input.config.extraClasses].filter(Boolean));

  // CLI flags win over config in both directions.
  if (input.cliSeed === true) {
    if (!input.cliSeed) return disabled(classes, 'Disabled by --no-seed.');
    return enabled(classes, 'Enabled by --seed.');
  }
  if (input.cliNoSeed === true) {
    return disabled(classes, 'Disabled by --no-seed.');
  }

  if (input.config.enabled) {
    return enabled(classes, 'Enabled by configuration (seeders.enabled).');
  }

  if (input.nonInteractive) {
    // In CI we never seed unless it was asked for explicitly.
    return disabled(
      classes,
      input.isFirstDeploy
        ? 'Disabled: non-interactive run, and seeders are off by default.'
        : 'Disabled: non-interactive run, seeders are off by default and this is not a first deploy.',
    );
  }

  if (input.isFirstDeploy && !input.isProduction) {
    return disabled(classes, 'Disabled: first deploy to a non-production environment.');
  }

  return disabled(classes, 'Disabled: seeders are off by default in production.');
}

function enabled(classes: string[], reason: string): SeederDecision {
  return { enabled: true, reason, classes };
}

function disabled(classes: string[], reason: string): SeederDecision {
  return { enabled: false, reason, classes };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Build the `db:seed` invocations for the enabled classes. */
export function buildSeedInvocations(
  decision: SeederDecision,
  factory: ArtisanCommandFactory,
): ArtisanInvocation[] {
  if (!decision.enabled) return [];
  return decision.classes.flatMap((className) => factory.seed(className));
}

/** Human label for the classes, for the plan output. */
export function describeSeeders(decision: SeederDecision): string {
  if (!decision.enabled) return 'disabled';
  return decision.classes.join(', ');
}