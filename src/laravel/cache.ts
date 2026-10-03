/**
 * Cache management.
 *
 * A new release changes the absolute path of the application. Any cached config
 * baked with the *previous* release's paths is a bug waiting to happen, so the
 * pipeline always clears before it optimizes, and never runs a cache command
 * known to be incompatible with the detected version (SPEC §23).
 */

import type { ArtisanCommandFactory, ArtisanInvocation } from './artisan.js';

export interface CachePlan {
  steps: Array<{ label: string; invocation: ArtisanInvocation }>;
  /** Aggregate display string for the plan / log. */
  display: string[];
}

export interface CachePlanOptions {
  /** Run `optimize:clear` before caching. Default true for releases. */
  clearFirst?: boolean;
  /** Use `optimize` (fast) rather than individual commands. Default true. */
  useOptimizeCommand?: boolean;
  /** Skip view caching (useful when views are compiled at runtime). */
  skipViews?: boolean;
}

export function planCaches(
  factory: ArtisanCommandFactory,
  options: CachePlanOptions = {},
): CachePlan {
  const { clearFirst = true, useOptimizeCommand = true, skipViews = false } = options;
  const steps: CachePlan['steps'] = [];

  if (clearFirst) {
    for (const invocation of factory.clearCaches()) {
      steps.push({ label: invocation.args.join(' '), invocation });
    }
  }

  const optimize = useOptimizeCommand
    ? factory.optimize()
    : factory.individualCaches().filter(
        (invocation) => !skipViews || !invocation.args.includes('view:cache'),
      );

  for (const invocation of optimize) {
    steps.push({ label: invocation.args.join(' '), invocation });
  }

  return {
    steps,
    display: steps.map((step) => `php artisan ${step.label}`),
  };
}

/** Commands a status/doctor check uses to detect whether caches are warm. */
export const CACHE_PROBE_COMMANDS = {
  config: ['config:show', '--json'],
  routesCached: ['route:list', '--json'],
} as const;

/** A cache file exists for this release if Laravel wrote it. */
export function cacheFileNames(): { config: string; routes: string; views: string; events: string } {
  return {
    config: 'bootstrap/cache/config.php',
    routes: 'bootstrap/cache/routes-v7.php',
    views: 'bootstrap/cache/views.php',
    events: 'bootstrap/cache/events.php',
  };
}

/** True when the cache file is non-empty (Laravel writes a header comment). */
export function isCacheFileWarm(sizeBytes: number): boolean {
  return sizeBytes > 0;
}