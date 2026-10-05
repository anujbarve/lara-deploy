import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeployError } from './ui.js';

export interface Config {
  server: { host: string; port: number; username: string; sshKey: string };
  aapanel: { url: string; apiKey: string };
  site: { domain: string; root: string };
  database: { name: string; username: string; password: string };
  deployment: { runMigrations: boolean; runSeeders: boolean };
}

export const CONFIG_FILE = '.lara-deploy.json';

const configPath = () => path.resolve(process.cwd(), CONFIG_FILE);

/**
 * Expand `%VAR%` (Windows) and `$VAR` / `${VAR}` (POSIX). Unknown names are left
 * alone so a literal `$` in a path is not silently swallowed.
 */
function expandEnv(p: string): string {
  return p
    .replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced?: string, bare?: string) => {
      const value = process.env[braced ?? bare!];
      return value ?? m;
    });
}

/** Resolve `~`, `~/x`, `~\x` and environment variables to an absolute path. */
export function resolveKeyPath(p: string): string {
  const raw = expandEnv(p.trim());
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    // A config written on Windows may use backslashes. Normalise to this
    // platform's separator, otherwise macOS/Linux get a literal '\' in the
    // filename and the key is reported as missing.
    return path.join(os.homedir(), raw.slice(2).replace(/[\\/]+/g, path.sep));
  }
  return path.resolve(raw);
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ROOT_RE = /^\/[A-Za-z0-9_.\-/]+$/;
const DB_RE = /^[A-Za-z0-9_]+$/;

/** Shared by the project config and the saved server credentials. */
export function validateServer(c: Pick<Config, 'server' | 'aapanel'>, label = CONFIG_FILE): void {
  const bad = (m: string) => {
    throw new DeployError(`Invalid ${label}: ${m}`);
  };
  if (!c.server?.host || !c.server.username) bad('server.host and server.username are required');
  if (!c.server.sshKey) bad('server.sshKey is required');
  if (!c.aapanel?.url || !c.aapanel.apiKey) bad('aapanel.url and aapanel.apiKey are required');
}

export function validate(c: Config): void {
  const bad = (m: string) => {
    throw new DeployError(`Invalid ${CONFIG_FILE}: ${m}`);
  };
  validateServer(c);
  if (!c.site?.domain || !HOST_RE.test(c.site.domain)) bad('site.domain is not a valid hostname');
  if (!ROOT_RE.test(c.site.root) || c.site.root.includes('..')) bad('site.root must be a safe absolute path');
  if (!c.database?.name || !DB_RE.test(c.database.name)) bad('database.name may only contain letters, digits and _');
  if (!c.database.username || !DB_RE.test(c.database.username)) bad('database.username may only contain letters, digits and _');
  if (!c.database.password) bad('database.password is required');
}

export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new DeployError(`${CONFIG_FILE} not found.`, ['Run `lara-deploy init` first.']);
  }
  let parsed: Config;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
  } catch {
    throw new DeployError(`${CONFIG_FILE} is not valid JSON.`);
  }
  parsed.server.port ??= 22;
  parsed.deployment ??= { runMigrations: true, runSeeders: false };
  validate(parsed);
  return parsed;
}

export function saveConfig(config: Config): void {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/** Make sure the config file (it holds secrets) is git-ignored. */
export function ensureGitignored(): void {
  const file = path.resolve(process.cwd(), '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === CONFIG_FILE)) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${sep}${CONFIG_FILE}\n`);
}
