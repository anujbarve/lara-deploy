/**
 * Well-known filesystem paths.
 *
 * Everything that touches the user's disk goes through here so tests can point
 * the whole CLI at a temp directory via LARAVEL_DEPLOY_HOME / LARAVEL_DEPLOY_CONFIG_DIR.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface CliPaths {
  /** Project root (where .laravel-deploy.json lives / where deploy runs). */
  projectRoot: string;
  /** Directory holding the project config file. */
  configFile: string;
  /** ~/.config/laravel-deploy (or the override). */
  globalDir: string;
  globalConfigFile: string;
  /** Secrets file, mode 0600. */
  secretsFile: string;
  /** Debug log directory. */
  logDir: string;
  historyDir: string;
  /** Local scratch space for archives. */
  cacheDir: string;
}

export const PROJECT_CONFIG_BASENAME = '.laravel-deploy.json';
export const GLOBAL_CONFIG_DIRNAME = 'laravel-deploy';

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LARAVEL_DEPLOY_CONFIG_DIR;
  if (override && override.trim() !== '') return path.resolve(override.trim());
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return path.join(xdg, GLOBAL_CONFIG_DIRNAME);
  return path.join(os.homedir(), '.config', GLOBAL_CONFIG_DIRNAME);
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LARAVEL_DEPLOY_STATE_DIR;
  if (override && override.trim() !== '') return path.resolve(override.trim());
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.trim() !== '') return path.join(xdg, GLOBAL_CONFIG_DIRNAME);
  return path.join(globalConfigDir(env), 'state');
}

export function resolvePaths(cwd: string, env: NodeJS.ProcessEnv = process.env): CliPaths {
  const projectRoot = path.resolve(cwd);
  const gdir = globalConfigDir(env);
  const sdir = stateDir(env);
  return {
    projectRoot,
    configFile: path.join(projectRoot, PROJECT_CONFIG_BASENAME),
    globalDir: gdir,
    globalConfigFile: path.join(gdir, 'config.json'),
    secretsFile: path.join(gdir, 'secrets.json'),
    logDir: path.join(gdir, 'logs'),
    historyDir: path.join(sdir, 'history'),
    cacheDir: path.join(sdir, 'cache'),
  };
}

/** Walk up from `start` looking for a project config file. */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  // Stop at the filesystem root.
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_CONFIG_BASENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The script directory shipped with the CLI, for remote script upload. */
export function remoteScriptsDir(): string {
  // dist/cli/../scripts at runtime; src/../scripts when running from source via tsx.
  const candidates = [
    path.resolve(process.cwd(), 'scripts'),
    path.resolve(new URL('../../scripts', import.meta.url).pathname),
    path.resolve(new URL('../scripts', import.meta.url).pathname),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'prepare-release.sh'))) return candidate;
  }
  return candidates[1]!;
}