/**
 * Well-known filesystem paths.
 *
 * Everything that touches the user's disk goes through here so tests can point
 * the whole CLI at a temp directory via LARAVEL_DEPLOY_HOME / LARAVEL_DEPLOY_CONFIG_DIR.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IS_WINDOWS, envValue } from '../../utils/platform.js';

export interface CliPaths {
  /** Project root (where .laravel-deploy.json lives / where deploy runs). */
  projectRoot: string;
  /** Directory holding the project config file. */
  configFile: string;
  /**
   * The global config directory: `%APPDATA%\laravel-deploy` on Windows,
   * `~/.config/laravel-deploy` elsewhere, or the explicit override.
   */
  globalDir: string;
  globalConfigFile: string;
  /** Secrets file. Written 0600 where a POSIX mode bit means something. */
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
  // Windows has no XDG convention; %APPDATA% is where a per-user application is
  // meant to keep its settings.
  if (IS_WINDOWS) {
    const appData = envValue(env, 'APPDATA');
    if (appData && appData.trim() !== '') return path.join(appData.trim(), GLOBAL_CONFIG_DIRNAME);
  }
  const xdg = envValue(env, 'XDG_CONFIG_HOME');
  if (xdg && xdg.trim() !== '') return path.join(xdg, GLOBAL_CONFIG_DIRNAME);
  return path.join(os.homedir(), '.config', GLOBAL_CONFIG_DIRNAME);
}

/**
 * The pre-Windows-native location, still honoured as a migration source.
 *
 * Earlier versions always used `~/.config/laravel-deploy`, including on Windows.
 * On Windows that directory is no longer where new state is written, but an
 * existing one is copied across on first run rather than left to rot.
 */
export function legacyGlobalConfigDir(env: NodeJS.ProcessEnv = process.env): string | null {
  // An explicit override means "use exactly this directory". Treating the
  // historical location as a migration source there would copy the real
  // ~/.config/laravel-deploy — config, secrets and state — into whatever
  // directory the caller pointed at, which is never what an override intends.
  const override = envValue(env, 'LARAVEL_DEPLOY_CONFIG_DIR');
  if (override && override.trim() !== '') return null;
  const xdg = envValue(env, 'XDG_CONFIG_HOME');
  if (xdg && xdg.trim() !== '') return path.join(xdg, GLOBAL_CONFIG_DIRNAME);
  return path.join(os.homedir(), '.config', GLOBAL_CONFIG_DIRNAME);
}

/** Files worth carrying across when the config directory moves. */
const MIGRATED_FILES = ['config.json', 'secrets.json', 'state'] as const;

/**
 * Copy a config directory into place, skipping anything already present.
 *
 * Split out from `migrateLegacyConfigDir` so the copy semantics can be tested
 * directly. Returns the names of the entries that were copied.
 */
export function copyConfigDir(from: string | null, to: string): string[] {
  if (from === null) return [];
  if (path.resolve(from) === path.resolve(to)) return [];

  const copied: string[] = [];
  for (const name of MIGRATED_FILES) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    if (fs.existsSync(target) || !fs.existsSync(source)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.cpSync(source, target, { recursive: true });
      copied.push(name);
    } catch {
      /* best effort: an unmigrated directory is recoverable by hand */
    }
  }
  return copied;
}

/**
 * Copy an existing legacy config directory to the platform-native location.
 *
 * Runs on every load but is a no-op once the native directory exists, so the
 * cost is one or two `existsSync` calls. Deliberately best-effort and silent:
 * failing to migrate must never stop someone from deploying, and the legacy
 * directory is left untouched as a backup.
 */
export function migrateLegacyConfigDir(env: NodeJS.ProcessEnv = process.env): string[] {
  return copyConfigDir(legacyGlobalConfigDir(env), globalConfigDir(env));
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
  // fileURLToPath, not URL#pathname: the latter yields a percent-encoded
  // POSIX-style string that becomes "/C:/Program%20Files/..." on Windows.
  const candidates = [
    path.resolve(process.cwd(), 'scripts'),
    path.resolve(fileURLToPath(new URL('../../scripts', import.meta.url))),
    path.resolve(fileURLToPath(new URL('../scripts', import.meta.url))),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'prepare-release.sh'))) return candidate;
  }
  return candidates[1]!;
}