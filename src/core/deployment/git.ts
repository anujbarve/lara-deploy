/**
 * Git metadata.
 *
 * Read-only: this CLI never modifies or pushes a repository (SPEC §36).
 *
 * These commands run on the *client* through LocalExecutor, so they use argv
 * rather than POSIX redirection: `2>/dev/null` would be parsed by cmd.exe as a
 * redirect to a file called `nul`, littering the user's working tree. Git
 * reports errors on stderr and sets a non-zero exit code, which is discarded.
 */

import type { RemoteExecutor } from '../../providers/exec/types.js';

export interface GitInfo {
  isRepo: boolean;
  sha: string | null;
  shortSha: string | null;
  branch: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
  /** Files changed, when dirty. */
  changedFiles: string[];
  remoteUrl: string | null;
}

const EMPTY: GitInfo = {
  isRepo: false,
  sha: null,
  shortSha: null,
  branch: null,
  dirty: false,
  changedFiles: [],
  remoteUrl: null,
};

export async function readGitInfo(
  executor: RemoteExecutor,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<GitInfo> {
  const run = (command: string) =>
    executor.exec(command, { cwd, allowFailure: true, timeoutMs: options.timeoutMs ?? 10_000 });

  const inside = await run('git rev-parse --is-inside-work-tree');
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return EMPTY;

  const [sha, branch, status, remote] = await Promise.all([
    run('git rev-parse HEAD'),
    run('git branch --show-current'),
    run('git status --porcelain'),
    run('git remote get-url origin'),
  ]);

  const shaValue = sha.stdout.trim() || null;
  const changedFiles = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  return {
    isRepo: true,
    sha: shaValue,
    shortSha: shaValue ? shaValue.slice(0, 7) : null,
    // A detached HEAD yields an empty branch name.
    branch: branch.stdout.trim() || null,
    dirty: changedFiles.length > 0,
    changedFiles,
    remoteUrl: remote.stdout.trim() || null,
  };
}

/** `main @ a1b2c3d`, or "not a git repository". */
export function describeGit(info: GitInfo): string {
  if (!info.isRepo) return 'not a git repository';
  const branch = info.branch ?? 'detached';
  const sha = info.shortSha ?? 'unknown';
  const dirty = info.dirty ? ' (uncommitted changes)' : '';
  return `${branch} @ ${sha}${dirty}`;
}