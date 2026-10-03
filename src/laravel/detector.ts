/**
 * Laravel project detection.
 *
 * Everything the deployment needs to know about the local project is derived
 * here, from files on disk — never from assumption. In particular the package
 * manager is detected from lockfiles (SPEC §6).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ProjectError } from '../core/errors/errors.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ComposerJson {
  name?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProjectInfo {
  root: string;
  name: string;
  isLaravel: boolean;
  /** Semver-ish major.minor, e.g. "11" or "10". */
  laravelMajor: number | null;
  /** Raw requirement string from composer.json. */
  laravelRequirement: string | null;
  composer: ComposerJson | null;
  packageJson: PackageJson | null;
  /** Minimum PHP from composer.json's `php` constraint. */
  phpRequirement: string | null;
  usesVite: boolean;
  usesMix: boolean;
  packageManager: PackageManager | null;
  hasFrontendBuild: boolean;
  /** Directories that must exist in a release. */
  hasMigrations: boolean;
  hasSeeders: boolean;
  hasRoutes: boolean;
  hasBootstrapDir: boolean;
  hasConfigDir: boolean;
  /** Laravel 11+ ships a `/up` health endpoint. */
  hasHealthEndpoint: boolean;
  /** Broadcast driver configured. */
  broadcastConnection: string | null;
  /** `QUEUE_CONNECTION` from .env.example, when present. */
  queueConnection: string | null;
  /** Composer scripts that suggest the app needs a scheduler. */
  hints: ProjectHints;
}

export interface ProjectHints {
  queue: boolean;
  scheduler: boolean;
  broadcasting: boolean;
  storage: boolean;
}

/** Files that together indicate a Laravel application. */
const LARAVEL_MARKERS = ['artisan', 'composer.json'] as const;
const LARAVEL_DIRS = ['app', 'bootstrap', 'config', 'routes'] as const;

export function looksLikeLaravel(root: string): boolean {
  if (!isDir(root)) return false;
  const hasMarkers = LARAVEL_MARKERS.every((file) => fs.existsSync(path.join(root, file)));
  if (!hasMarkers) return false;
  // A bare Laravel app has at least two of the standard directories.
  return LARAVEL_DIRS.filter((dir) => isDir(path.join(root, dir))).length >= 2;
}

export function assertLaravelProject(root: string): void {
  if (!looksLikeLaravel(root)) {
    throw new ProjectError(`Not a Laravel project: ${root}`, {
      remediation: [
        'Run this command from the root of a Laravel application.',
        'Expected to find artisan, composer.json and app/ bootstrap/ config/ routes/.',
      ],
    });
  }
}

export function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))) as T;
  } catch {
    return null;
  }
}

/** Inspect a project directory. Never throws for non-Laravel directories. */
export function inspectProject(root: string): ProjectInfo {
  const resolved = path.resolve(root);
  const composer = readJsonSafe<ComposerJson>(path.join(resolved, 'composer.json'));
  const packageJson = readJsonSafe<PackageJson>(path.join(resolved, 'package.json'));
  const envExample = readEnvFile(path.join(resolved, '.env.example'));

  const laravelReq = composer?.require?.['laravel/framework'] ?? null;
  const laravelMajor = parseMajor(laravelReq);

  const usesVite =
    fs.existsSync(path.join(resolved, 'vite.config.ts')) ||
    fs.existsSync(path.join(resolved, 'vite.config.js')) ||
    hasDependency(packageJson, 'vite') ||
    hasDependency(composer, 'laravel/vite-plugin');
  const usesMix =
    fs.existsSync(path.join(resolved, 'webpack.mix.js')) || hasDependency(packageJson, 'laravel-mix');

  const buildScript = packageJson?.scripts?.build ?? '';
  const hasFrontendBuild = usesVite || usesMix || buildScript !== '';

  const queueConnection = envExample?.QUEUE_CONNECTION ?? null;
  const hints = detectHints(resolved, composer, envExample);

  return {
    root: resolved,
    name: projectName(resolved, composer, packageJson),
    isLaravel: looksLikeLaravel(resolved),
    laravelMajor,
    laravelRequirement: laravelReq,
    composer,
    packageJson,
    phpRequirement: composer?.require?.php ?? null,
    usesVite,
    usesMix,
    packageManager: detectPackageManager(resolved),
    hasFrontendBuild,
    hasMigrations: isDir(path.join(resolved, 'database', 'migrations')),
    hasSeeders:
      isDir(path.join(resolved, 'database', 'seeders')) ||
      isDir(path.join(resolved, 'database', 'seeds')),
    hasRoutes: isDir(path.join(resolved, 'routes')),
    hasBootstrapDir: isDir(path.join(resolved, 'bootstrap')),
    hasConfigDir: isDir(path.join(resolved, 'config')),
    // /up arrived in Laravel 11 and is registered by the framework skeleton.
    hasHealthEndpoint: (laravelMajor ?? 0) >= 11,
    broadcastConnection: envExample?.BROADCAST_CONNECTION ?? null,
    queueConnection,
    hints,
  };
}

function detectHints(
  root: string,
  composer: ComposerJson | null,
  envExample: Record<string, string> | null,
): ProjectHints {
  const routesDir = path.join(root, 'routes');
  let scheduler = false;
  const consoleRoutes = path.join(routesDir, 'console.php');
  if (fs.existsSync(consoleRoutes)) {
    const contents = fs.readFileSync(consoleRoutes, 'utf8');
    scheduler = /Schedule::|->(daily|hourly|cron|everyMinutes|everyHour)\s*\(/.test(contents);
  }
  if (composer?.scripts?.['schedule:work'] !== undefined) scheduler = true;

  const broadcasting =
    isDir(path.join(root, 'routes', 'channels.php')) ||
    (envExample?.BROADCAST_CONNECTION != null && envExample.BROADCAST_CONNECTION !== 'null') ||
    (composer?.require?.['pusher/pusher-php-server'] !== undefined) ||
    (composer?.require?.['laravel/reverb'] !== undefined);

  const queueEnv = envExample?.QUEUE_CONNECTION ?? null;
  const queue =
    (queueEnv !== null && queueEnv !== 'null' && queueEnv !== 'sync') ||
    composer?.require?.['laravel/horizon'] !== undefined ||
    fs.existsSync(path.join(root, 'app', 'Jobs'));

  const storage = isDir(path.join(root, 'storage', 'app'));

  return { queue, scheduler, broadcasting, storage };
}

function projectName(
  root: string,
  composer: ComposerJson | null,
  packageJson: PackageJson | null,
): string {
  const composerName = composer?.name;
  if (typeof composerName === 'string') {
    const slug = composerName.split('/').pop();
    if (slug) return slug;
  }
  if (packageJson?.name) return String(packageJson.name).replace(/^@[^/]+\//, '');
  return path.basename(root);
}

/** Convert a directory name into a filesystem/DB-safe slug. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Lockfile detection, in priority order (SPEC §6). */
export function detectPackageManager(root: string): PackageManager | null {
  const checks: Array<[PackageManager, string]> = [
    ['bun', 'bun.lock'],
    ['bun', 'bun.lockb'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['npm', 'package-lock.json'],
  ];
  for (const [manager, lockfile] of checks) {
    if (fs.existsSync(path.join(root, lockfile))) return manager;
  }
  // A package.json with no lockfile still needs a manager to install with.
  if (fs.existsSync(path.join(root, 'package.json'))) return 'npm';
  return null;
}

export function hasDependency(pkg: { dependencies?: Record<string, string>; 'require-dev'?: Record<string, string> } | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg['require-dev']?.[name]);
}

function parseMajor(requirement: string | null): number | null {
  if (!requirement) return null;
  const match = /(\d+)(?:\.\d+)?/.exec(requirement);
  return match?.[1] ? Number(match[1]) : null;
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Parse a `.env`-style file into key/value pairs (no interpolation). */
export function readEnvFile(file: string): Record<string, string> | null {
  if (!fs.existsSync(file)) return null;
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}