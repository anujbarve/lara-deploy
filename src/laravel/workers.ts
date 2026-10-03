/**
 * Queue worker configuration.
 *
 * Supervisor program names must be deterministic and unique per site so that
 * (a) repeated deploys update rather than duplicate, and (b) we never restart an
 * unrelated process (SPEC §25).
 */

import type { QueueConfig } from '../core/config/schema.js';

export interface WorkerPlan {
  processName: string;
  /** Full supervisor program name including the group. */
  programName: string;
  workers: number;
  connection?: string;
  /** Extra artisan flags. */
  options: string[];
  /** Human description for the plan output. */
  display: string;
}

/** `laravel-<slug>-worker` per SPEC §25, with a `-N` suffix per extra worker. */
export function deriveProgramName(projectSlug: string, index: number): string {
  // Supervisor program names use hyphens, not the underscore slug used for
  // database identifiers — `client-site` must become `laravel-client-site-worker`.
  const slug =
    projectSlug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'app';
  return index === 0 ? `laravel-${slug}-worker` : `laravel-${slug}-worker-${index}`;
}

/** The comment header that makes a supervisor program identifiable as ours. */
export const SUPERVISOR_MARKER = '# managed-by: laravel-deploy';

export function planWorkers(projectName: string, config: QueueConfig): WorkerPlan[] {
  const plans: WorkerPlan[] = [];
  for (let i = 0; i < Math.max(1, config.workers); i += 1) {
    const name = config.processName && i === 0 ? config.processName : deriveProgramName(projectName, i);
    plans.push({
      processName: name,
      programName: name,
      workers: config.workers,
      connection: config.connection,
      options: [...config.options],
      display: `php artisan queue:work --queue=${config.connection ?? 'default'}${
        config.options.length > 0 ? ` ${config.options.join(' ')}` : ''
      }`,
    });
  }
  return plans;
}

/** Detect whether the app actually needs queue workers. */
export function shouldRunWorkers(input: {
  configEnabled: boolean;
  queueHint: boolean;
  queueConnection: string | null;
  usesHorizon: boolean;
}): { needed: boolean; reason: string } {
  if (input.configEnabled) return { needed: true, reason: 'Enabled by configuration.' };
  if (input.usesHorizon) {
    return { needed: true, reason: 'Detected Laravel Horizon; queue:work is managed by Horizon.' };
  }
  if (input.queueConnection && input.queueConnection !== 'sync') {
    return { needed: true, reason: `Detected QUEUE_CONNECTION=${input.queueConnection}.` };
  }
  if (input.queueHint) return { needed: true, reason: 'Detected queue infrastructure in the project.' };
  return { needed: false, reason: 'No queue configuration detected.' };
}

/** Parse `supervisorctl status` output for our programs. */
export interface SupervisorProcessState {
  name: string;
  state: string;
  pid: string;
  uptime: string;
}

export function parseSupervisorStatus(output: string): SupervisorProcessState[] {
  const rows: SupervisorProcessState[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('No such process') || !line.includes('RUNNING') && !line.includes('STOPPED')
      && !line.includes('FATAL') && !line.includes('EXITED') && !line.includes('STARTING')) {
      continue;
    }
    // name state pid uptime [extra]
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    rows.push({
      name: parts[0] as string,
      state: parts[1] as string,
      pid: parts[2] as string,
      uptime: parts[3] as string,
    });
  }
  return rows;
}

/** True when at least one matching process is RUNNING. */
export function workersRunning(
  states: readonly SupervisorProcessState[],
  names: readonly string[],
): boolean {
  return states.some((state) => names.includes(state.name) && state.state === 'RUNNING');
}

export interface WorkerHealth {
  ok: boolean;
  running: string[];
  expected: string[];
  missing: string[];
  detail: string;
}

export function evaluateWorkers(
  states: readonly SupervisorProcessState[],
  names: readonly string[],
): WorkerHealth {
  const running = states
    .filter((state) => names.includes(state.name) && state.state === 'RUNNING')
    .map((state) => state.name);
  const missing = names.filter((name) => !running.includes(name));
  return {
    ok: missing.length === 0 && running.length > 0,
    running,
    expected: [...names],
    missing,
    detail: missing.length === 0
      ? `${running.length}/${names.length} workers running`
      : `Not running: ${missing.join(', ')}`,
  };
}