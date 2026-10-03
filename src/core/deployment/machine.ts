/**
 * Deployment state machine.
 *
 * The orchestrator drives this; it does not know how many `if` statements the
 * pipeline has. Every transition is recorded in the manifest, and the terminal
 * state is always COMPLETED or FAILED (SPEC §30).
 */

import {
  DEPLOYMENT_STATES,
  type DeploymentManifest,
  type DeploymentState,
  type StepRecord,
} from '../release/manifest.js';
import { AppError } from '../errors/errors.js';

/** Legal transitions. FAILED is reachable from anywhere. */
const TRANSITIONS: Record<DeploymentState, readonly DeploymentState[]> = {
  INITIALIZED: ['VALIDATED', 'FAILED'],
  VALIDATED: ['BUILT', 'FAILED'],
  BUILT: ['PACKAGED', 'FAILED'],
  PACKAGED: ['UPLOADED', 'FAILED'],
  UPLOADED: ['EXTRACTED', 'FAILED'],
  EXTRACTED: ['CONFIGURED', 'FAILED'],
  CONFIGURED: ['MIGRATED', 'FAILED'],
  // Migrations can be skipped, so OPTIMIZED is also reachable from CONFIGURED.
  MIGRATED: ['OPTIMIZED', 'FAILED'],
  OPTIMIZED: ['ACTIVATED', 'FAILED'],
  ACTIVATED: ['VERIFIED', 'FAILED'],
  VERIFIED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionInput {
  to: DeploymentState;
  step: string;
  detail?: string;
  error?: string;
  at: Date;
}

export class DeploymentMachine {
  private current: DeploymentState;
  /** States deliberately bypassed by a `--skip-*` flag. */
  private readonly skipped = new Set<DeploymentState>();

  constructor(private readonly manifest: DeploymentManifest) {
    this.current = manifest.state;
  }

  get state(): DeploymentState {
    return this.current;
  }

  get steps(): StepRecord[] {
    return this.manifest.steps;
  }

  /** Record a step that succeeded and advance the state. */
  advance(input: TransitionInput): void {
    if (!this.canReach(input.to)) {
      throw new AppError(
        `Invalid deployment transition ${this.current} -> ${input.to} (step "${input.step}").`,
        {
          details: { from: this.current, to: input.to },
          remediation: ['This is a bug in laravel-deploy; please report it with the deployment id.'],
        },
      );
    }
    this.current = input.to;
    this.manifest.state = input.to;
    this.manifest.steps.push({
      step: input.step,
      state: input.to,
      status: 'ok',
      startedAt: input.at.toISOString(),
      finishedAt: input.at.toISOString(),
      ...(input.detail ? { detail: input.detail } : {}),
    });
  }

  /**
   * A transition is legal when it is directly allowed, or when every state
   * being jumped over was explicitly skipped.
   */
  private canReach(target: DeploymentState): boolean {
    if (canTransition(this.current, target)) return true;
    const fromIndex = DEPLOYMENT_STATES.indexOf(this.current);
    const toIndex = DEPLOYMENT_STATES.indexOf(target);
    if (fromIndex === -1 || toIndex === -1 || toIndex <= fromIndex) return false;

    const crossed = DEPLOYMENT_STATES.slice(fromIndex + 1, toIndex);
    // The state immediately before the target must be a legal predecessor.
    const predecessor = DEPLOYMENT_STATES[toIndex - 1] as DeploymentState;
    if (!TRANSITIONS[predecessor].includes(target)) return false;
    // Every state jumped over must have been deliberately skipped.
    return crossed.every((state) => this.skipped.has(state));
  }

  /**
   * Record a step without changing state — used for skipped steps (e.g.
   * migrations disabled) so the manifest still shows what was considered.
   *
   * When `state` names the happy-path state the step would have reached, that
   * state is marked as intentionally skipped so the next transition may jump
   * over it. Without this, `--skip-build` would leave the machine unable to
   * move from VALIDATED to PACKAGED.
   */
  skip(step: string, detail: string, at: Date, state?: DeploymentState): void {
    if (state) this.skipped.add(state);
    this.manifest.steps.push({
      step,
      state: state ?? this.current,
      status: 'skipped',
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      detail,
    });
  }

  /** Mark the deployment as failed. Safe to call from any state. */
  fail(step: string, error: Error, at: Date): void {
    this.current = 'FAILED';
    this.manifest.state = 'FAILED';
    this.manifest.status = 'FAILED';
    this.manifest.failedStep = step;
    this.manifest.error = error.message;
    this.manifest.finishedAt = at.toISOString();
    this.manifest.steps.push({
      step,
      state: 'FAILED',
      status: 'failed',
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
      error: error.message,
    });
  }

  complete(at: Date): void {
    this.current = 'COMPLETED';
    this.manifest.state = 'COMPLETED';
    this.manifest.status = 'SUCCESS';
    this.manifest.finishedAt = at.toISOString();
  }

  /** Attach the fields the later stages fill in. */
  update(fields: Partial<DeploymentManifest>): void {
    Object.assign(this.manifest, fields);
  }

  /** Position in the happy path, for progress reporting. */
  progress(): number {
    return Math.min(100, Math.round((DEPLOYMENT_STATES.indexOf(this.current) / (DEPLOYMENT_STATES.length - 1)) * 100));
  }
}