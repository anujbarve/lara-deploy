/**
 * Release retention and cleanup.
 *
 * After a successful deployment only, old releases are pruned — never the
 * current one, never the previous one (which rollback needs), and never fewer
 * than `keepReleases` remain (SPEC §33, §34).
 */

import { q } from '../../utils/shell.js';
import type { RemoteExecutor } from '../../providers/exec/types.js';
import type { SiteLayout } from './layout.js';
import { releasePath } from './layout.js';

export interface RetentionPlan {
  keep: string[];
  delete: string[];
  /** Never touched, with the reason. */
  protected: string[];
}

export interface RetentionInput {
  releases: string[];
  currentRelease: string | null;
  keepReleases: number;
  /** Keep this many previous successful releases for rollback. Default 1. */
  keepPrevious?: number;
}

/**
 * Decide what to delete. Pure so it can be unit tested without a server.
 * Releases are ordered newest-first by their `YYYYMMDD-HHMMSS` stamp, which
 * sorts lexicographically, so no date parsing is needed.
 */
export function planRetention(input: RetentionInput): RetentionPlan {
  const sorted = [...input.releases].sort((a, b) => (a < b ? 1 : -1));
  const keepCount = Math.max(1, input.keepReleases);
  const keepPrevious = input.keepPrevious ?? 1;

  const keep: string[] = [];
  const protectedIds: string[] = [];

  if (input.currentRelease) {
    keep.push(input.currentRelease);
    protectedIds.push(input.currentRelease);
  }
  // The next N after the current one are rollback candidates.
  for (const release of sorted) {
    if (keep.length >= 1 + keepPrevious) break;
    if (!keep.includes(release)) {
      keep.push(release);
      protectedIds.push(release);
    }
  }
  // Fill up to keepCount with the newest remaining.
  for (const release of sorted) {
    if (keep.length >= keepCount) break;
    if (!keep.includes(release)) keep.push(release);
  }

  const delete_ = sorted.filter((release) => !keep.includes(release));
  return { keep, delete: delete_, protected: protectedIds };
}

/** List release directory names on the server. */
export async function listReleases(
  executor: RemoteExecutor,
  layout: SiteLayout,
): Promise<string[]> {
  const result = await executor.exec(
    `ls -1 ${q(layout.releasesDir)} 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}(-[A-Za-z0-9]+)?$' || true`,
    { allowFailure: true },
  );
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

/** Resolve the release `current` points at. */
export async function readCurrentRelease(
  executor: RemoteExecutor,
  layout: SiteLayout,
): Promise<string | null> {
  const result = await executor.exec(
    `readlink -f ${q(layout.currentLink)} 2>/dev/null || true`,
    { allowFailure: true },
  );
  const resolved = result.stdout.trim();
  if (resolved === '' || resolved === layout.currentLink) return null;
  const name = resolved.split('/').filter(Boolean).pop();
  return name && /^[0-9]{8}-[0-9]{6}/.test(name) ? name : null;
}

/** The release before `current`, i.e. the rollback target. */
export async function readPreviousRelease(
  executor: RemoteExecutor,
  layout: SiteLayout,
  currentRelease: string | null,
): Promise<string | null> {
  const releases = await listReleases(executor, layout);
  if (!currentRelease) return releases[0] ?? null;
  const newer = releases
    .filter((release) => release > currentRelease)
    .sort((a, b) => (a < b ? 1 : -1));
  return newer[0] ?? null;
}

/** Delete releases and prune database backups, oldest first. */
export async function pruneReleases(
  executor: RemoteExecutor,
  layout: SiteLayout,
  releases: readonly string[],
): Promise<string[]> {
  const deleted: string[] = [];
  for (const release of releases) {
    // Defence in depth: the path is built from a validated id, but re-check.
    if (!/^[0-9]{8}-[0-9]{6}(-[A-Za-z0-9]+)?$/.test(release)) continue;
    const result = await executor.exec(`rm -rf ${q(releasePath(layout, release))}`, {
      label: `prune release ${release}`,
      allowFailure: true,
    });
    if (result.exitCode === 0) deleted.push(release);
  }
  return deleted;
}

/** Keep the newest N backup files, delete the rest. */
export async function pruneBackups(
  executor: RemoteExecutor,
  layout: SiteLayout,
  keep: number,
): Promise<string[]> {
  const result = await executor.exec(
    [
      'set -Eeuo pipefail',
      `dir=${q(layout.backupsDir)}`,
      `test -d "$dir" || exit 0`,
      // List newest first, skip the first N, delete the rest.
      `ls -1t "$dir" 2>/dev/null | tail -n +$(( ${keep} + 1 )) | while IFS= read -r file; do`,
      `  [ -n "$file" ] && rm -f "$dir/$file" && echo "$file"`,
      'done',
    ].join('\n'),
    { label: 'prune database backups', allowFailure: true },
  );
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * Remove a failed release that was never activated.
 * Refuses to touch the current release (SPEC §34).
 */
export async function cleanupFailedRelease(
  executor: RemoteExecutor,
  layout: SiteLayout,
  releaseId: string,
  currentRelease: string | null,
): Promise<boolean> {
  if (releaseId === currentRelease) return false;
  const result = await executor.exec(`rm -rf ${q(releasePath(layout, releaseId))}`, {
    label: 'cleanup failed release',
    allowFailure: true,
  });
  return result.exitCode === 0;
}