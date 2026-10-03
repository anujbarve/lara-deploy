/**
 * Deployment manifest.
 *
 * Written to <site root>/deployment-manifest.json on the server and kept locally
 * so `laravel-deploy history` and `laravel-deploy deployment show` work after the
 * fact. The manifest is the record of what actually happened, including failure
 * (SPEC §30, §53).
 */

import fs from 'node:fs';
import path from 'node:path';

export type DeploymentState =
  | 'INITIALIZED'
  | 'VALIDATED'
  | 'BUILT'
  | 'PACKAGED'
  | 'UPLOADED'
  | 'EXTRACTED'
  | 'CONFIGURED'
  | 'MIGRATED'
  | 'OPTIMIZED'
  | 'ACTIVATED'
  | 'VERIFIED'
  | 'COMPLETED'
  | 'FAILED';

export type DeploymentStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';

/** Ordered happy path; the machine validates transitions against this. */
export const DEPLOYMENT_STATES: readonly DeploymentState[] = [
  'INITIALIZED',
  'VALIDATED',
  'BUILT',
  'PACKAGED',
  'UPLOADED',
  'EXTRACTED',
  'CONFIGURED',
  'MIGRATED',
  'OPTIMIZED',
  'ACTIVATED',
  'VERIFIED',
  'COMPLETED',
];

export interface StepRecord {
  step: string;
  state: DeploymentState;
  status: 'ok' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Redacted detail; never secrets. */
  detail?: string;
  error?: string;
}

export interface DeploymentManifest {
  deploymentId: string;
  project: string;
  domain: string;
  server: string;
  serverHost: string;
  environment: string;
  releaseId: string | null;
  gitSha: string | null;
  gitBranch: string | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: DeploymentStatus;
  state: DeploymentState;
  steps: StepRecord[];
  failedStep?: string;
  error?: string;
  /** True once the `current` symlink moved to this release. */
  activated?: boolean;
  migrationStatus?: 'pending' | 'ran' | 'skipped' | 'failed';
  seedStatus?: 'pending' | 'ran' | 'skipped';
  healthStatus?: 'pending' | 'healthy' | 'degraded' | 'failed';
  backupPath?: string;
  /** Local machine that initiated the deploy, for the lock. */
  host?: string;
  user?: string;
  /** Monotonic step counter so `current` can be reconstructed. */
  sequence?: number;
}

/** Create a manifest for a new deployment. */
export function newManifest(input: {
  deploymentId: string;
  project: string;
  domain: string;
  server: string;
  serverHost: string;
  environment: string;
  host: string;
  user: string;
  startedAt: Date;
  sequence?: number;
}): DeploymentManifest {
  return {
    deploymentId: input.deploymentId,
    project: input.project,
    domain: input.domain,
    server: input.server,
    serverHost: input.serverHost,
    environment: input.environment,
    releaseId: null,
    gitSha: null,
    gitBranch: null,
    startedAt: input.startedAt.toISOString(),
    status: 'RUNNING',
    state: 'INITIALIZED',
    steps: [],
    migrationStatus: 'pending',
    seedStatus: 'pending',
    healthStatus: 'pending',
    host: input.host,
    user: input.user,
    sequence: input.sequence ?? 1,
  };
}

/** Local history storage: one file per deployment under historyDir. */
export class ManifestStore {
  constructor(private readonly historyDir: string) {}

  private file(deploymentId: string): string {
    return path.join(this.historyDir, `${deploymentId}.json`);
  }

  save(manifest: DeploymentManifest): void {
    fs.mkdirSync(this.historyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file(manifest.deploymentId), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  load(deploymentId: string): DeploymentManifest | null {
    const file = this.file(deploymentId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentManifest;
    } catch {
      return null;
    }
  }

  /** Newest first. */
  list(limit = 20): DeploymentManifest[] {
    if (!fs.existsSync(this.historyDir)) return [];
    const files = fs
      .readdirSync(this.historyDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(this.historyDir, name));
    const manifests: DeploymentManifest[] = [];
    for (const file of files) {
      try {
        manifests.push(JSON.parse(fs.readFileSync(file, 'utf8')) as DeploymentManifest);
      } catch {
        /* skip corrupt entry */
      }
    }
    manifests.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
    return manifests.slice(0, limit);
  }

  /** Next sequence number for this site. */
  nextSequence(domain: string): number {
    return this.list(500).filter((m) => m.domain === domain).length + 1;
  }
}