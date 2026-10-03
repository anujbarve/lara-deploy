/**
 * Health checking.
 *
 * Multiple independent checks so one failure is diagnosable rather than a single
 * opaque "deploy failed" (SPEC §29). Every check returns a structured result;
 * the caller decides whether a failure blocks activation or only degrades.
 */

import dns from 'node:dns/promises';
import { q } from '../../utils/shell.js';
import { retry } from '../../utils/retry.js';
import { redactOutput } from '../../utils/redact.js';
import { buildReleaseId, releaseStamp, type Clock } from '../../utils/ids.js';
import type { RemoteExecutor } from '../../providers/exec/types.js';
import type { HealthCheckConfig, QueueConfig, SchedulerConfig, AppConfig } from '../config/schema.js';
import type { SiteLayout } from '../release/layout.js';
import { CronManager } from '../../providers/cron/manager.js';
import { SupervisorManager } from '../../providers/supervisor/manager.js';
import { evaluateWorkers } from '../../laravel/workers.js';
import { planStorageLayout, verifySymlink } from '../../laravel/storage.js';
import type { MigrationStatus } from '../../laravel/migrations.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  durationMs?: number;
  /** Remediation when failing. */
  remediation?: string[];
  details?: Record<string, unknown>;
}

export interface HealthReport {
  results: CheckResult[];
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  passed: number;
  failed: number;
  warnings: number;
}

export interface HttpCheckInput {
  url: string;
  expectStatus: number[];
  timeoutMs: number;
  attempts: number;
  retryDelayMs: number;
  /** Validate TLS. */
  rejectUnauthorized?: boolean;
  fetchImpl?: typeof fetch;
}

export interface HealthCheckerOptions {
  executor: RemoteExecutor;
  layout: SiteLayout;
  config: HealthCheckConfig;
  domain: string;
  phpBinary: string;
  /** Release under test; defaults to the live current release. */
  appDir?: string;
  queue?: QueueConfig & { processName?: string };
  scheduler?: SchedulerConfig;
  projectSlug?: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

/** HTTP probe with retries. Retried because a transient blip is not a failure. */
export async function checkHttp(input: HttpCheckInput): Promise<CheckResult> {
  const started = Date.now();
  const doFetch = input.fetchImpl ?? fetch;
  let lastError = '';

  try {
    await retry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), input.timeoutMs);
        try {
          const response = await doFetch(input.url, {
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'user-agent': 'laravel-deploy/health-check' },
          });
          if (!input.expectStatus.includes(response.status)) {
            throw new HttpStatusError(response.status);
          }
          return response;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        attempts: input.attempts,
        delayMs: input.retryDelayMs,
        isRetryable: (error) => error instanceof HttpStatusError || isNetworkError(error),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );

    return {
      name: 'http',
      status: 'pass',
      message: `${input.url} responded as expected`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    lastError = describeHttpError(error);
    return {
      name: 'http',
      status: 'fail',
      message: lastError,
      durationMs: Date.now() - started,
      remediation: [
        'Confirm DNS points at this server.',
        'Check nginx access/error logs: laravel-deploy logs nginx',
        'Check the application log: laravel-deploy logs laravel',
      ],
    };
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('timeout') ||
    message.includes('aborted')
  );
}

function describeHttpError(error: unknown): string {
  if (error instanceof HttpStatusError) {
    return `HTTP ${error.status} from the health endpoint (expected ${'2xx/3xx'})`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export class HealthChecker {
  private readonly executor: RemoteExecutor;
  private readonly layout: SiteLayout;
  private readonly options: HealthCheckerOptions;

  constructor(options: HealthCheckerOptions) {
    this.options = options;
    this.executor = options.executor;
    this.layout = options.layout;
  }

  private get appDir(): string {
    return this.options.appDir ?? this.layout.appDir;
  }

  /** Run every enabled check and aggregate. */
  async runAll(
    overrides: { skipHttp?: boolean; migrationStatus?: MigrationStatus | null } = {},
  ): Promise<HealthReport> {
    const results: CheckResult[] = [];
    const config = this.options.config;

    if (config.http && !overrides.skipHttp) {
      results.push(await this.http());
    }
    results.push(await this.laravel());
    if (config.database) results.push(await this.database());
    if (config.storage) results.push(await this.storage());
    if (config.ssl) results.push(await this.ssl());
    if (config.queue && this.options.queue?.enabled) results.push(await this.queue());
    if (config.scheduler && this.options.scheduler?.enabled) results.push(await this.schedulerCheck());

    if (overrides.migrationStatus) {
      results.push({
        name: 'migrations',
        status: overrides.migrationStatus.pending === 0 ? 'pass' : 'warn',
        message:
          overrides.migrationStatus.pending === 0
            ? 'All migrations applied'
            : `${overrides.migrationStatus.pending} pending migration(s)`,
      });
    }

    return aggregate(results);
  }

  /** Probe the live site over HTTPS, then HTTP as a fallback. */
  async http(): Promise<CheckResult> {
    const base = `https://${this.options.domain}`;
    const https = await checkHttp({
      url: base,
      expectStatus: this.options.config.expectStatus,
      timeoutMs: this.options.config.timeoutMs,
      attempts: this.options.config.attempts,
      retryDelayMs: this.options.config.retryDelayMs,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    if (https.status === 'pass') {
      return { ...https, name: 'http', message: `${base} is reachable over HTTPS` };
    }

    // A missing certificate is an SSL problem, not an HTTP one.
    if (/certificate|SSL|TLS/i.test(https.message)) {
      return { ...https, name: 'ssl', message: `TLS failure: ${https.message}` };
    }

    const http = await checkHttp({
      url: `http://${this.options.domain}`,
      expectStatus: this.options.config.expectStatus,
      timeoutMs: this.options.config.timeoutMs,
      attempts: 1,
      retryDelayMs: 0,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    if (http.status === 'pass') {
      return {
        name: 'http',
        status: 'warn',
        message: 'Reachable over HTTP but not HTTPS',
        remediation: ['Issue an SSL certificate: laravel-deploy ssl'],
      };
    }
    return {
      name: 'http',
      status: 'fail',
      message: `HTTPS: ${https.message}; HTTP: ${http.message}`,
      remediation: https.remediation,
    };
  }

  /** Laravel bootstrap: a read-only artisan command must succeed. */
  async laravel(): Promise<CheckResult> {
    const started = Date.now();
    if (this.options.config.artisan === false) {
      return { name: 'laravel', status: 'skip', message: 'disabled' };
    }
    const result = await this.executor.exec(
      [
        'set -Eeuo pipefail',
        `cd ${q(this.appDir)}`,
        `${q(this.options.phpBinary)} artisan about --only=environment`,
      ].join('\n'),
      { allowFailure: true, timeoutMs: this.options.config.timeoutMs, label: 'artisan about' },
    );

    if (result.exitCode === 0) {
      return {
        name: 'laravel',
        status: 'pass',
        message: 'artisan about succeeded',
        durationMs: Date.now() - started,
      };
    }
    return {
      name: 'laravel',
      status: 'fail',
      message: `artisan about failed: ${firstMeaningfulLine(result.stderr) || `exit ${result.exitCode}`}`,
      durationMs: Date.now() - started,
      remediation: [
        'Check the .env file on the server for missing variables.',
        'Inspect the application log: laravel-deploy logs laravel',
      ],
      details: { stderr: redactOutput(result.stderr).slice(-1500) },
    };
  }

  /** Database: ask Laravel, which knows its own connection settings. */
  async database(): Promise<CheckResult> {
    const started = Date.now();
    const result = await this.executor.exec(
      [
        'set -Eeuo pipefail',
        `cd ${q(this.appDir)}`,
        `${q(this.options.phpBinary)} artisan migrate:status`,
      ].join('\n'),
      { allowFailure: true, timeoutMs: this.options.config.timeoutMs, label: 'artisan migrate:status' },
    );
    if (result.exitCode === 0) {
      return { name: 'database', status: 'pass', message: 'database reachable', durationMs: Date.now() - started };
    }
    return {
      name: 'database',
      status: 'fail',
      message: `database unreachable: ${firstMeaningfulLine(result.stderr) || `exit ${result.exitCode}`}`,
      durationMs: Date.now() - started,
      remediation: [
        'Verify DB_* variables in the server .env.',
        'Check the database exists and the user has privileges.',
      ],
    };
  }

  /** Storage: shared dir exists, symlink valid, writable by the web user. */
  async storage(): Promise<CheckResult> {
    const started = Date.now();
    const storageLayout = planStorageLayout(this.layout.root);
    const probe = await this.executor.exec(
      [
        'set -Eeuo pipefail',
        `shared=${q(storageLayout.sharedStorage)}`,
        `link=${q(`${this.appDir}/storage`)}`,
        `if [ ! -d "$shared" ]; then echo "SHARED=missing"; else echo "SHARED=ok"; fi`,
        `if [ -L "$link" ]; then`,
        `  target="$(readlink -f "$link" 2>/dev/null || true)"`,
        `  if [ -z "$target" ] || [ ! -d "$target" ]; then echo "LINK=broken"; else echo "LINK=$target"; fi`,
        `else`,
        `  echo "LINK=not-a-symlink"`,
        `fi`,
        `if [ -w "${this.appDir}/storage/framework/views" ]; then echo "WRITABLE=yes"; else echo "WRITABLE=no"; fi`,
      ].join('\n'),
      { allowFailure: true, label: 'storage probe' },
    );

    const values = parseKeyValues(probe.stdout);
    const problems: string[] = [];

    if (values.SHARED !== 'ok') problems.push('shared/storage is missing');
    const linkCheck = verifySymlink({
      exists: values.LINK !== undefined && values.LINK !== 'not-a-symlink',
      isSymlink: values.LINK !== 'not-a-symlink' && values.LINK !== undefined,
      resolvesTo: values.LINK && values.LINK !== 'ok' ? values.LINK : '',
      expectedTarget: storageLayout.sharedStorage,
    });
    if (!linkCheck.ok) problems.push(`storage link: ${linkCheck.message}`);
    if (values.WRITABLE !== 'yes') problems.push('storage is not writable by the web user');

    if (problems.length === 0) {
      return { name: 'storage', status: 'pass', message: 'shared storage linked and writable', durationMs: Date.now() - started };
    }
    return {
      name: 'storage',
      status: 'fail',
      message: problems.join('; '),
      durationMs: Date.now() - started,
      remediation: ['Run `laravel-deploy storage repair` to rebuild the links.'],
    };
  }

  /** SSL: TLS must actually work. Never reported as passing without a probe. */
  async ssl(): Promise<CheckResult> {
    const started = Date.now();
    const result = await checkHttp({
      url: `https://${this.options.domain}`,
      expectStatus: this.options.config.expectStatus,
      timeoutMs: this.options.config.timeoutMs,
      attempts: this.options.config.attempts,
      retryDelayMs: this.options.config.retryDelayMs,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    if (result.status === 'pass') {
      return { name: 'ssl', status: 'pass', message: 'HTTPS verified', durationMs: Date.now() - started };
    }
    const expired = /expired|not yet valid/i.test(result.message);
    return {
      name: 'ssl',
      status: 'fail',
      message: result.message,
      durationMs: Date.now() - started,
      remediation: expired
        ? ['The certificate has expired: laravel-deploy ssl --force']
        : [
            'Check DNS resolves to this server: laravel-deploy domain check',
            'Issue the certificate: laravel-deploy ssl',
          ],
    };
  }

  /** Queue: at least one of our supervisor programs must be RUNNING. */
  async queue(): Promise<CheckResult> {
    const started = Date.now();
    const queue = this.options.queue;
    if (!queue?.enabled) return { name: 'queue', status: 'skip', message: 'queue disabled' };

    const manager = new SupervisorManager({ executor: this.executor });
    const names = queue.processName ? [queue.processName] : [this.defaultProgramName()];
    const states = await manager.status();
    const health = evaluateWorkers(states, names);

    if (health.ok) {
      return { name: 'queue', status: 'pass', message: health.detail, durationMs: Date.now() - started };
    }
    return {
      name: 'queue',
      status: 'fail',
      message: health.detail,
      durationMs: Date.now() - started,
      remediation: [`Install or restart workers: laravel-deploy queue restart`, 'Inspect logs: laravel-deploy logs queue'],
    };
  }

  /** Scheduler: our cron entry must exist and point at a live directory. */
  async schedulerCheck(): Promise<CheckResult> {
    const started = Date.now();
    const scheduler = this.options.scheduler;
    if (!scheduler?.enabled) return { name: 'scheduler', status: 'skip', message: 'scheduler disabled' };

    const cron = new CronManager(this.executor);
    const status = await cron.status({
      config: scheduler,
      siteRoot: this.layout.root,
      phpBinary: this.options.phpBinary,
    });

    if (!status.installed) {
      return {
        name: 'scheduler',
        status: 'fail',
        message: 'no cron entry for schedule:run',
        durationMs: Date.now() - started,
        remediation: ['Run `laravel-deploy scheduler install`.'],
      };
    }
    if (status.staleTarget) {
      return {
        name: 'scheduler',
        status: 'fail',
        message: 'cron entry points at a directory that no longer exists',
        durationMs: Date.now() - started,
        remediation: ['Run `laravel-deploy scheduler install` to rewrite it.'],
      };
    }
    return { name: 'scheduler', status: 'pass', message: 'cron entry installed', durationMs: Date.now() - started };
  }

  /** DNS resolution check used by `laravel-deploy domain check`. */
  async dnsCheck(): Promise<CheckResult> {
    const started = Date.now();
    try {
      const addresses = await dns.lookup(this.options.domain, { all: true });
      if (addresses.length === 0) {
        return { name: 'dns', status: 'fail', message: `${this.options.domain} does not resolve`, durationMs: Date.now() - started };
      }
      return {
        name: 'dns',
        status: 'pass',
        message: `${this.options.domain} -> ${addresses.map((a) => a.address).join(', ')}`,
        durationMs: Date.now() - started,
        details: { addresses },
      };
    } catch (error) {
      return {
        name: 'dns',
        status: 'fail',
        message: `${this.options.domain} does not resolve (${error instanceof Error ? error.message : String(error)})`,
        durationMs: Date.now() - started,
        remediation: [`Add an A record for ${this.options.domain} pointing at the server IP.`],
      };
    }
  }

  private defaultProgramName(): string {
    const slug = (this.options.projectSlug ?? 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `laravel-${slug || 'app'}-worker`;
  }
}

/**
 * Effective health-check setting.
 *
 * The config has two knobs for the same thing — `deployment.healthCheck` (a
 * top-level toggle, SPEC §7) and `healthCheck.enabled` (SPEC §29). Both must be
 * true for checks to run, so either one can switch them off.
 */
export function healthChecksEnabled(config: AppConfig): boolean {
  return config.healthCheck.enabled && config.deployment.healthCheck;
}

/** Aggregate individual results into an overall verdict. */
export function aggregate(results: readonly CheckResult[]): HealthReport {
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  const status = failed > 0 ? 'UNHEALTHY' : warnings > 0 ? 'DEGRADED' : 'HEALTHY';
  return { results: [...results], status, passed, failed, warnings };
}

/** Parse `KEY=value` lines emitted by remote probe scripts. */
export function parseKeyValues(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)=([\s\S]*)$/.exec(line);
    if (!match) continue;
    out[match[1] as string] = (match[2] ?? '').trim();
  }
  return out;
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('PHP Warning')) continue;
    return trimmed;
  }
  return '';
}

/** A release id for a new deployment. */
export function newReleaseId(clock: Clock, gitSha?: string | null): string {
  return buildReleaseId(releaseStamp(clock.now()), gitSha);
}