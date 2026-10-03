/**
 * Cron manager.
 *
 * The scheduler entry is identified by a marker comment, so installation is
 * idempotent and removal only ever deletes our own line (SPEC §26).
 */

import { q } from '../../utils/shell.js';
import type { RemoteExecutor } from '../exec/types.js';
import type { SchedulerConfig } from '../../core/config/schema.js';

export interface CronInstallResult {
  installed: boolean;
  /** True when an identical entry already existed. */
  reused: boolean;
  entry: string;
  crontabPath: string;
}

export interface CronStatus {
  installed: boolean;
  entry: string | null;
  /** True when the entry points at a path that no longer exists. */
  staleTarget: boolean;
  crontabPath: string;
}

export class CronManager {
  constructor(private readonly executor: RemoteExecutor) {}

  private marker(config: SchedulerConfig): string {
    return `# ${config.comment}`;
  }

  /** The exact line we manage. */
  buildEntry(input: {
    config: SchedulerConfig;
    siteRoot: string;
    phpBinary: string;
  }): string {
    const { config, siteRoot, phpBinary } = input;
    const parts = [
      input.config.schedule,
      `cd ${q(`${siteRoot}/current`)}`,
      `&& ${phpBinary} artisan schedule:run`,
      config.runAs ? `>> ${q(`${siteRoot}/shared/logs/scheduler.log`)} 2>&1` : '',
    ];
    return `${this.marker(config)} ${parts.filter(Boolean).join(' ')}`;
  }

  /**
   * Install idempotently: if a line with our marker exists, replace it; if an
   * identical line exists, do nothing; otherwise append.
   */
  async install(input: {
    config: SchedulerConfig;
    siteRoot: string;
    phpBinary: string;
  }): Promise<CronInstallResult> {
    const entry = this.buildEntry(input);
    const marker = this.marker(input.config);
    const current = await this.readCrontab();

    // Already there and identical?
    if (current.includes(entry)) {
      return { installed: true, reused: true, entry, crontabPath: this.crontabPath(input.config.runAs) };
    }

    const filtered = current.filter((line) => !line.includes(marker));
    const rebuilt = [...filtered, entry].join('\n');
    await this.writeCrontab(`${rebuilt}\n`, input.config.runAs);

    return { installed: true, reused: false, entry, crontabPath: this.crontabPath(input.config.runAs) };
  }

  /** Remove our entry only. */
  async remove(config: SchedulerConfig): Promise<boolean> {
    const marker = this.marker(config);
    const current = await this.readCrontab();
    const filtered = current.filter((line) => !line.includes(marker));
    if (filtered.length === current.length) return false;
    await this.writeCrontab(filtered.length > 0 ? `${filtered.join('\n')}\n` : '', config.runAs);
    return true;
  }

  async status(input: { config: SchedulerConfig; siteRoot: string; phpBinary: string }): Promise<CronStatus> {
    const expected = this.buildEntry(input);
    const marker = this.marker(input.config);
    const current = await this.readCrontab();
    const existing = current.find((line) => line.includes(marker));
    const crontabPath = this.crontabPath(input.config.runAs);

    if (!existing) {
      return { installed: false, entry: null, staleTarget: false, crontabPath };
    }
    // Our entry may reference a php binary or path that no longer exists.
    const target = /cd '([^']+)'/.exec(existing)?.[1];
    let staleTarget = false;
    if (target) {
      const check = await this.executor.exec(`test -d ${q(target)}`, { allowFailure: true });
      staleTarget = check.exitCode !== 0;
    }
    return { installed: true, entry: existing, staleTarget, crontabPath };
  }

  /** True when any cron entry references this app's schedule:run. */
  async detectScheduleRun(siteRoot: string): Promise<string | null> {
    const current = await this.readCrontab();
    const match = current.find((line) => line.includes('schedule:run') && line.includes(siteRoot));
    return match ?? null;
  }

  private crontabPath(runAs?: string): string {
    if (runAs) return `/var/spool/cron/crontabs/${runAs}`;
    return '/var/spool/cron/crontabs/root';
  }

  private async readCrontab(): Promise<string[]> {
    const result = await this.executor.exec('crontab -l 2>/dev/null || true', {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  }

  private async writeCrontab(contents: string, runAs?: string): Promise<void> {
    const tag = `LDCRON${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const apply = runAs ? `crontab -u ${q(runAs)} -` : 'crontab -';
    const script = [
      'set -Eeuo pipefail',
      `cat <<'${tag}' | ${apply}`,
      contents.replace(/\n?$/, ''),
      `${tag}`,
    ].join('\n');
    const result = await this.executor.exec(script, { label: 'install crontab entry' });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to write the crontab (exit ${result.exitCode}).`);
    }
  }
}