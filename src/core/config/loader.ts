/**
 * Configuration loading.
 *
 * Layering, lowest to highest priority:
 *   1. schema defaults
 *   2. .laravel-deploy.json
 *   3. .laravel-deploy.<env>.json   (when --env is given)
 *   4. CLI flags
 *
 * Raw secrets are never read from these files. Anything sensitive is resolved
 * from the environment or the secrets store at runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  appConfigSchema,
  globalConfigSchema,
  type AppConfig,
  type GlobalConfig,
} from './schema.js';
import { ConfigError, ConfigValidationError, type ConfigIssue } from '../errors/errors.js';
import {
  findProjectRoot,
  resolvePaths,
  PROJECT_CONFIG_BASENAME,
  type CliPaths,
} from './paths.js';
import { isPlainObject, deepMerge } from '../../utils/object.js';

export interface LoadOptions {
  cwd?: string;
  env?: string;
  /** Explicit config file; bypasses discovery. */
  configPath?: string;
  /** Require a config file to exist (init does not). */
  required?: boolean;
}

export interface LoadedConfig {
  config: AppConfig;
  paths: CliPaths;
  /** True when the project config file existed on disk. */
  exists: boolean;
  /** Files that contributed, in merge order. */
  sources: string[];
}

/** Locate the project config, honouring --env. */
export function locateConfigFile(cwd: string, env?: string): string | null {
  if (env) {
    const candidate = path.join(cwd, `.laravel-deploy.${env}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const base = path.join(cwd, PROJECT_CONFIG_BASENAME);
  return fs.existsSync(base) ? base : null;
}

export function loadProjectConfig(options: LoadOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const paths = resolvePaths(cwd);
  const root = findProjectRoot(cwd) ?? cwd;

  const file = options.configPath ?? locateConfigFile(root, options.env);
  const exists = file !== null && fs.existsSync(file);

  if (!exists) {
    if (options.required) {
      throw new ConfigError('No deployment configuration found.', {
        remediation: [
          `Run \`laravel-deploy init\` in your Laravel project to create ${PROJECT_CONFIG_BASENAME}.`,
        ],
      });
    }
    throw new ConfigError('No deployment configuration found.', {
      remediation: [
        `Run \`laravel-deploy init\` to create ${PROJECT_CONFIG_BASENAME} interactively.`,
        'Or pass --config <path> explicitly.',
      ],
    });
  }

  const sources: string[] = [];
  const layers: unknown[] = [];

  if (options.env) {
    const baseFile = path.join(root, PROJECT_CONFIG_BASENAME);
    if (fs.existsSync(baseFile)) {
      layers.push(readJson(baseFile));
      sources.push(baseFile);
    }
  }
  layers.push(readJson(file as string));
  sources.push(file as string);

  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) {
      throw new ConfigError(`Configuration file ${file} must contain a JSON object.`);
    }
    merged = deepMerge(merged, layer) as Record<string, unknown>;
  }

  // `site.domains[0]` is handled inside validateAppConfig.
  const config = validateAppConfig(merged, sources.join(', '));
  return { config, paths: { ...paths, projectRoot: root, configFile: file as string }, exists, sources };
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Unable to read ${file}.`, { cause });
  }
  try {
    // Strip // and /* */ comments so teams can annotate config files.
    return JSON.parse(stripJsonComments(raw));
  } catch (cause) {
    throw new ConfigError(`${file} is not valid JSON.`, {
      cause,
      remediation: ['Check for a trailing comma or a missing quote.'],
    });
  }
}

function normaliseDomainAlias(merged: Record<string, unknown>): void {
  const site = merged.site;
  if (!isPlainObject(site)) return;
  const domains = site.domains;
  if (Array.isArray(domains) && domains.length > 0 && !site.domain) {
    site.domain = domains[0];
  }
  delete site.domains;
}

/** Validate and produce human-readable issues (never raw Zod output). */
export function validateAppConfig(
  raw: unknown,
  sourceLabel = PROJECT_CONFIG_BASENAME,
): AppConfig {
  // `site.domains[0]` is a convenience alias for `site.domain`.
  if (isPlainObject(raw)) normaliseDomainAlias(raw as Record<string, unknown>);

  const result = appConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = fromZodError(result.error);
    throw new ConfigValidationError('Invalid deployment configuration.', issues, {
      details: { source: sourceLabel, issues },
      remediation: ['Fix the listed fields, then re-run the command.'],
    });
  }
  const config = result.data;

  // Cross-field checks the schema cannot express.
  if (config.deployment.buildCommands && config.deployment.buildCommands.length === 0) {
    throw new ConfigValidationError('Invalid deployment configuration.', [
      { path: 'deployment.buildCommands', message: 'must not be empty when provided' },
    ]);
  }
  if (config.ssl.enabled && config.ssl.provider === 'none') {
    throw new ConfigValidationError('Invalid deployment configuration.', [
      { path: 'ssl.provider', message: 'must not be "none" when ssl.enabled is true' },
    ]);
  }
  if (config.env.strategy === 'template' && !config.env.templatePath) {
    throw new ConfigValidationError('Invalid deployment configuration.', [
      { path: 'env.templatePath', message: 'required when env.strategy is "template"' },
    ]);
  }
  if (config.env.strategy === 'upload' && !config.env.uploadPath) {
    throw new ConfigValidationError('Invalid deployment configuration.', [
      { path: 'env.uploadPath', message: 'required when env.strategy is "upload"' },
    ]);
  }
  return config;
}

export function loadGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig {
  const paths = resolvePaths(process.cwd(), env);
  if (!fs.existsSync(paths.globalConfigFile)) {
    return globalConfigSchema.parse({ version: 1, servers: {} });
  }
  try {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(paths.globalConfigFile, 'utf8')));
    const result = globalConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new ConfigValidationError(
        'Invalid global server configuration.',
        fromZodError(result.error),
        { remediation: ['Fix ~/.config/laravel-deploy/config.json and retry.'] },
      );
    }
    return result.data;
  } catch (cause) {
    if (cause instanceof ConfigValidationError) throw cause;
    throw new ConfigError(`Unable to read ${paths.globalConfigFile}.`, { cause });
  }
}

export function saveGlobalConfig(config: GlobalConfig, env: NodeJS.ProcessEnv = process.env): void {
  const paths = resolvePaths(process.cwd(), env);
  fs.mkdirSync(paths.globalDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.globalConfigFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Render Zod issues as `path: message` lines. */
export function fromZodError(error: ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/** Format issues for the terminal. */
export function formatConfigIssues(issues: ConfigIssue[]): string {
  return issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n');
}

/** Remove // and /* *\/ comments outside of strings. */
export function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    const next = input[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}