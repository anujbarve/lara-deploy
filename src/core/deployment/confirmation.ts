/**
 * Confirmation.
 *
 * Abstracted so the orchestrator never imports a prompt library and so tests
 * can auto-confirm or auto-deny. Destructive operations require a typed
 * confirmation (the domain name), not just a yes/no (SPEC §21, §48).
 */

import type { DeploymentPlan } from './plan.js';

export interface ConfirmPlanInput {
  database: string;
  environment: string;
  pending: number | null;
  release: string;
  /** True when the plan includes anything irreversible. */
  destructive: boolean;
}

export interface Confirmation {
  confirmPlan(plan: DeploymentPlan, input: ConfirmPlanInput): Promise<boolean>;
  /** Typed confirmation for destructive database operations. */
  confirmDestructive(reason: string, expectedText: string): Promise<boolean>;
}

export class AutoYes implements Confirmation {
  async confirmPlan(): Promise<boolean> {
    return true;
  }
  async confirmDestructive(): Promise<boolean> {
    return true;
  }
}

export class AutoNo implements Confirmation {
  async confirmPlan(): Promise<boolean> {
    return false;
  }
  async confirmDestructive(): Promise<boolean> {
    return false;
  }
}