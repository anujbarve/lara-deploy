/**
 * Local build pipeline.
 *
 * Detected by default, overridable via config:
 *   composer install --no-dev --optimize-autoloader
 *   <pm> ci && <pm> run build
 *
 * A build failure stops the deployment immediately — nothing is packaged or
 * uploaded (SPEC §14).
 */

import type { RemoteExecutor, ExecResult } from '../providers/exec/types.js';
import type { ProjectInfo, PackageManager } from '../laravel/detector.js';
import type { AppConfig } from '../core/config/schema.js';
import { LocalCommandError, AppError } from '../core/errors/errors.js';
import type { Logger } from '../utils/logger.js';
import { nullLogger } from '../utils/logger.js';

export interface BuildStep {
  label: string;
  command: string;
  /** Executed when `enabled` is false. */
  skipReason?: string;
}

export interface BuildPlan {
  steps: BuildStep[];
  /** Steps that will actually run. */
  active: BuildPlan['steps'];
  packageManager: PackageManager | null;
  /** Commands as display strings. */
  display: string[];
}

export interface BuildResult {
  steps: Array<{
    label: string;
    command: string;
    ok: boolean;
    skipped: boolean;
    durationMs: number;
    exitCode: number;
    outputTail: string;
  }>;
  durationMs: number;
}

export interface BuilderOptions {
  executor: RemoteExecutor;
  project: ProjectInfo;
  config: AppConfig;
  logger?: Logger;
  /** Called before each step so the UI can print what is about to run. */
  onStep?: (step: BuildStep) => void;
  onStepFinish?: (step: BuildStep, result: ExecResult, skipped: boolean) => void;
}

/** Install command per package manager. */
export function installCommand(pm: PackageManager, scriptsDisabled = false): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return scriptsDisabled ? 'yarn install --frozen-lockfile' : 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
    case 'npm':
    default:
      return 'npm ci';
  }
}

export function buildScriptCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm run build';
    case 'yarn':
      return 'yarn run build';
    case 'bun':
      return 'bun run build';
    case 'npm':
    default:
      return 'npm run build';
  }
}

/** Produce the build plan. Pure: no commands are run. */
export function planBuild(project: ProjectInfo, config: AppConfig): BuildPlan {
  const build = config.build;
  const deployment = config.deployment;
  const pm = build.packageManager ?? project.packageManager;

  // An explicit override replaces detection entirely.
  if (deployment.buildCommands && deployment.buildCommands.length > 0) {
    const steps = deployment.buildCommands.map((command) => ({ label: command, command }));
    return {
      steps,
      active: steps,
      packageManager: pm,
      display: steps.map((step) => step.command),
    };
  }

  const steps: BuildStep[] = [];

  if (deployment.composer && !build.skipComposer && project.composer) {
    const flags = build.includeDev ? '' : '--no-dev ';
    steps.push({
      label: 'composer install',
      command: `composer install ${flags}--optimize-autoloader --no-interaction --no-progress`,
    });
  } else if (build.skipComposer) {
    steps.push({ label: 'composer install', command: '', skipReason: 'skipped by configuration' });
  }

  if (project.packageJson) {
    if (!pm) {
      throw new AppError('package.json exists but no package manager could be detected.', {
        remediation: [
          'Commit a lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock).',
          'Or set build.packageManager explicitly in .lar-deploy.json.',
        ],
      });
    }
    if (!deployment.frontend || build.skipFrontend) {
      steps.push({
        label: 'frontend dependencies',
        command: '',
        skipReason: build.skipFrontend ? 'skipped by configuration' : 'frontend build disabled',
      });
    } else {
      steps.push({ label: 'install dependencies', command: installCommand(pm) });
      if (project.hasFrontendBuild) {
        steps.push({ label: 'build frontend', command: buildScriptCommand(pm) });
      }
    }
  }

  for (const extra of deployment.extraBuildCommands) {
    steps.push({ label: 'extra command', command: extra });
  }

  return {
    steps,
    active: steps.filter((step) => step.skipReason === undefined),
    packageManager: pm,
    display: steps.map((step) =>
      step.skipReason ? `${step.label} (${step.skipReason})` : step.command,
    ),
  };
}

export class Builder {
  private readonly logger: Logger;

  constructor(private readonly options: BuilderOptions) {
    this.logger = options.logger ?? nullLogger();
  }

  plan(): BuildPlan {
    return planBuild(this.options.project, this.options.config);
  }

  /** Execute the plan. The first failure aborts and throws. */
  async run(plan: BuildPlan): Promise<BuildResult> {
    const started = Date.now();
    const results: BuildResult['steps'] = [];

    for (const step of plan.steps) {
      if (step.skipReason !== undefined) {
        results.push({
          label: step.label,
          command: '',
          ok: true,
          skipped: true,
          durationMs: 0,
          exitCode: 0,
          outputTail: step.skipReason,
        });
        continue;
      }

      this.options.onStep?.(step);
      this.logger.debug('Running build step.', { command: step.command });

      const stepStart = Date.now();
      let result: ExecResult;
      try {
        result = await this.options.executor.exec(step.command, {
          cwd: this.options.project.root,
          timeoutMs: this.options.config.timeouts.localBuild,
          label: step.label,
          allowFailure: true,
        });
      } catch (cause) {
        throw new LocalCommandError(`Build step "${step.label}" could not start.`, 1, {
          cause,
          command: step.command,
          liveAffected: false,
          remediation: ['Fix the local build environment, then re-run the deployment.'],
        });
      }

      const outputTail = combineTail(result);
      this.options.onStepFinish?.(step, result, false);
      results.push({
        label: step.label,
        command: step.command,
        ok: result.exitCode === 0,
        skipped: false,
        durationMs: Date.now() - stepStart,
        exitCode: result.exitCode,
        outputTail,
      });

      if (result.exitCode !== 0) {
        throw new LocalCommandError(
          `Build step "${step.label}" failed with exit code ${result.exitCode}.`,
          result.exitCode,
          {
            command: step.command,
            liveAffected: false,
            details: { output: outputTail.slice(-4000) },
            remediation: [
              'The live deployment was not changed.',
              'Fix the build locally, then re-run `laravel-deploy deploy`.',
            ],
          },
        );
      }
    }

    return { steps: results, durationMs: Date.now() - started };
  }

  /** Build and package together is the orchestrator's job; this is build only. */
  async buildAndReport(plan = this.plan()): Promise<BuildResult> {
    return this.run(plan);
  }
}

/** Last useful lines of a build step, stderr first. */
function combineTail(result: ExecResult, limit = 2000): string {
  const parts: string[] = [];
  if (result.stderr.trim() !== '') parts.push(result.stderr.trim());
  if (result.stdout.trim() !== '') parts.push(result.stdout.trim());
  const combined = parts.join('\n');
  return combined.length > limit ? `...\n${combined.slice(-limit)}` : combined;
}