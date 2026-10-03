/**
 * Version comparison.
 *
 * Kept separate from the orchestrator so both the deployment path and the
 * validation code can use it without pulling in the whole pipeline.
 */

/** Compare dotted versions numerically. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Extract the minimum `major.minor` from a composer-style constraint.
 * `^8.3` -> `8.3`, `>=8.1` -> `8.1`, `^11.0 || ^12.0` -> `11.0`.
 */
export function parseVersionConstraint(constraint: string): string | null {
  const match = /(\d+)\.(\d+)/.exec(constraint);
  return match ? `${match[1]}.${match[2]}` : null;
}

/** True when the app's constraint allows the version the server reports. */
export function satisfiesConstraint(constraint: string, version: string): boolean {
  const minimum = parseVersionConstraint(constraint);
  if (!minimum) return true;
  return compareVersions(version, minimum) >= 0;
}

/** Parse `PHP 8.3.12` into `8.3.12`. */
export function parsePhpVersion(output: string): string | null {
  return /PHP\s+(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}