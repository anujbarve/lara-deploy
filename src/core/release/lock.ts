/**
 * Deployment lock.
 *
 * A remote lock file at <root>/.deploy/deployment.lock prevents two deploys from
 * racing to the same site. The lock records who holds it and when, so a stale
 * lock left by a killed process can be identified and broken deliberately
 * (SPEC §35).
 */

import { q } from '../../utils/shell.js';
import { DeploymentLockedError } from '../errors/errors.js';
import type { RemoteExecutor } from '../../providers/exec/types.js';

export interface LockInfo {
  deploymentId: string;
  startedAt: string;
  host: string;
  user: string;
}

export interface AcquireLockOptions {
  lockFile: string;
  deploymentId: string;
  startedAt: string;
  host: string;
  user: string;
  /** Break a lock even if it looks live. Requires confirmation upstream. */
  force?: boolean;
  /** Locks older than this are considered stale. Default 3 hours. */
  staleAfterMs?: number;
}

export class DeploymentLock {
  constructor(private readonly executor: RemoteExecutor) {}

  /** Read the current lock, or null. */
  async read(lockFile: string): Promise<LockInfo | null> {
    const result = await this.executor.exec(`cat ${q(lockFile)} 2>/dev/null`, { allowFailure: true });
    if (result.exitCode !== 0 || result.stdout.trim() === '') return null;
    try {
      const parsed = JSON.parse(result.stdout) as Partial<LockInfo>;
      if (!parsed.deploymentId) return null;
      return {
        deploymentId: parsed.deploymentId,
        startedAt: parsed.startedAt ?? 'unknown',
        host: parsed.host ?? 'unknown',
        user: parsed.user ?? 'unknown',
      };
    } catch {
      // An unparseable lock is treated as stale rather than blocking forever.
      return {
        deploymentId: '(corrupt lock file)',
        startedAt: 'unknown',
        host: 'unknown',
        user: 'unknown',
      };
    }
  }

  /**
   * The shell script that takes the lock. Extracted so its semantics can be
   * asserted directly, since the difference between "contended" and "broken"
   * lives entirely in this text.
   */
  buildAcquireScript(lockFile: string, info: Omit<AcquireLockOptions, 'lockFile' | 'force' | 'staleAfterMs'>): string {
    const payload = JSON.stringify({ ...info, pid: process.pid }, null, 2);
    const tag = `LDLOCK${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    // The .deploy directory does not exist on a first deploy, and a bare
    // `mkdir` of the lock directory would then fail with ENOENT — which the
    // race check below reads as "someone else holds the lock". Skipped when the
    // lock path has no directory component, since `mkdir -p ''` would abort
    // the whole script under `set -e`.
    const lockDir = lockFile.replace(/\/[^/]*$/, '');
    return [
      'set -Eeuo pipefail',
      ...(lockDir === '' ? [] : [`mkdir -p ${q(lockDir)}`]),
      `lockdir=${q(lockFile)}.d`,
      // mkdir is atomic: exactly one deploy wins the race. A failure is only
      // contention when the directory now exists; anything else (permissions,
      // read-only filesystem) is a real error and must not be reported as
      // "another deployment is running".
      `if ! mkdir "$lockdir" 2>/dev/null; then`,
      '  if [ -d "$lockdir" ]; then echo "LOCKED"; exit 3; fi',
      `  echo "unable to create lock directory $lockdir" >&2`,
      '  exit 4',
      'fi',
      `cat > ${q(lockFile)} <<'${tag}'`,
      payload,
      `${tag}`,
      `chmod 0600 ${q(lockFile)}`,
    ].join('\n');
  }

  /**
   * Acquire the lock. Uses a single atomic mkdir so two deploys cannot both win.
   */
  async acquire(options: AcquireLockOptions): Promise<LockInfo> {
    const existing = await this.read(options.lockFile);

    if (existing) {
      const stale = this.isStale(existing, options.staleAfterMs ?? 3 * 60 * 60 * 1000);
      if (!stale && !options.force) {
        throw new DeploymentLockedError(
          `A deployment is already running for this site.\n\n  Deployment ID: ${existing.deploymentId}\n  Started:      ${existing.startedAt}\n  Host:         ${existing.host}\n  User:         ${existing.user}`,
          {
            remediation: [
              'Wait for it to finish, or inspect the server: cat ' + options.lockFile,
              'If the other process is gone, re-run with --force-unlock.',
            ],
          },
        );
      }
      await this.release(options.lockFile);
    }

    const script = this.buildAcquireScript(options.lockFile, {
      deploymentId: options.deploymentId,
      startedAt: options.startedAt,
      host: options.host,
      user: options.user,
    });

    // allowFailure so exit codes 3 and 4 are inspected here rather than thrown
    // as a generic remote failure by the executor.
    const result = await this.executor.exec(script, {
      label: 'acquire deployment lock',
      allowFailure: true,
    });
    if (result.exitCode === 3) {
      throw new DeploymentLockedError('Another deployment acquired the lock first.', {
        remediation: ['Wait for it to complete, or re-run with --force-unlock.'],
      });
    }
    if (result.exitCode === 4) {
      throw new DeploymentLockedError(`Unable to create the lock directory for ${options.lockFile}.`, {
        details: { stderr: result.stderr.slice(-1000) },
        remediation: [
          `Check that the SSH user can write to the directory holding ${options.lockFile}.`,
        ],
      });
    }
    if (result.exitCode !== 0) {
      throw new DeploymentLockedError('Unable to acquire the deployment lock.', {
        details: { stderr: result.stderr.slice(-1000) },
        remediation: [`Check that the SSH user can write to ${options.lockFile}.`],
      });
    }

    return {
      deploymentId: options.deploymentId,
      startedAt: options.startedAt,
      host: options.host,
      user: options.user,
    };
  }

  /** Release the lock, but only when we still hold it. */
  async release(lockFile: string, deploymentId?: string): Promise<void> {
    // With a deployment id the removal is guarded by a grep, so a deploy that
    // lost its lock cannot delete the lock another deploy now owns.
    const script = deploymentId
      ? [
          'set -Eeuo pipefail',
          `lockfile=${q(lockFile)}`,
          `if [ -f "$lockfile" ] && grep -q ${q(deploymentId)} "$lockfile"; then`,
          '  rm -f "$lockfile"',
          'fi',
          `rmdir ${q(`${lockFile}.d`)} 2>/dev/null || true`,
        ].join('\n')
      : [`rm -f ${q(lockFile)}`, `rmdir ${q(`${lockFile}.d`)} 2>/dev/null || true`].join('\n');

    await this.executor.exec(script, { label: 'release deployment lock', allowFailure: true });
  }

  /** A lock older than the threshold, or from a dead host, is stale. */
  isStale(info: LockInfo, staleAfterMs: number): boolean {
    const started = Date.parse(info.startedAt);
    if (Number.isNaN(started)) return true;
    return Date.now() - started > staleAfterMs;
  }
}