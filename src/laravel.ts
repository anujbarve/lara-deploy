import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { DeployError } from './ui.js';
import { q } from './ssh.js';

const REQUIRED = ['artisan', 'composer.json', 'app', 'bootstrap', 'config', 'routes'];

export function assertLaravelProject(dir = process.cwd()): void {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) {
    throw new DeployError('This does not appear to be a Laravel project.', [`Missing: ${missing.join(', ')}`]);
  }
}

/** Remote paths derived from the config. */
export function paths(config: Config) {
  const root = config.site.root.replace(/\/+$/, '');
  return { root, main: `${root}/main` };
}

/**
 * Shell snippet that sets $PHP to a usable php binary. aaPanel keeps PHP under
 * /www/server/php/<version>/bin/php and it is often not on PATH for SSH.
 */
export const PHP_DETECT = [
  'PHP=$(command -v php || true)',
  '[ -n "$PHP" ] || PHP=$(ls -d /www/server/php/*/bin/php 2>/dev/null | sort | tail -n 1)',
  '[ -n "$PHP" ] || { echo "php not found on server" >&2; exit 127; }',
].join('\n');

/** Run `php artisan <args>` inside main/, then hand storage back to the web user. */
export function artisanScript(config: Config, args: string): string {
  const { main } = paths(config);
  return [
    'set -e',
    PHP_DETECT,
    `cd ${q(main)}`,
    // Rebuild the package/provider discovery cache before touching the database.
    'rm -f bootstrap/cache/services.php bootstrap/cache/packages.php',
    `rc=0; "$PHP" artisan ${args} || rc=$?`,
    `chown -R www:www storage bootstrap/cache 2>/dev/null || true`,
    'exit $rc',
  ].join('\n');
}

/** Extract the archive into main/ and publish public files into the site root. */
export function installScript(config: Config, archive: string): string {
  const { root, main } = paths(config);
  return [
    'set -e',
    `[ -f ${q(archive)} ] || { echo "archive not found: ${archive}" >&2; exit 1; }`,
    `mkdir -p ${q(main)}`,
    `cd ${q(main)}`,
    // Remove everything the archive provides before extracting it, so a file
    // deleted locally stops existing on the server too. A stale config/*.php
    // used to make Laravel abort on a class from a package that was no longer
    // installed. `.env` and `storage/` are excluded from the archive and are
    // the server's source of truth, so they are kept.
    'find . -mindepth 1 -maxdepth 1 ! -name .env ! -name storage -exec rm -rf {} +',
    `tar -xzf ${q(archive)} -C .`,
    `rm -f ${q(archive)}`,
    // Runtime dirs are excluded from the archive; make sure they exist.
    'mkdir -p storage/logs storage/app/public storage/framework/cache/data storage/framework/sessions storage/framework/views bootstrap/cache',
    // Cached files are excluded from the archive, so whatever a previous deploy left
    // here is stale. Clear it, otherwise Laravel keeps using the old provider
    // manifest and reports "Class ... not found" for packages that have moved.
    'rm -f bootstrap/cache/*.php',
    // Copy public/* into the site root, then regenerate index.php with paths pointing at main/.
    `cp -a public/. ${q(root)}/`,
    `sed 's#/\\.\\./#/main/#g' public/index.php > ${q(root + '/index.php')}`,
    `chown -R www:www ${q(root)} 2>/dev/null || true`,
    `chmod -R ug+rwX storage bootstrap/cache`,
  ].join('\n');
}

/** Point <root>/storage at main/storage/app/public, repairing a wrong link. */
export function storageLinkScript(config: Config): string {
  const { root, main } = paths(config);
  const link = `${root}/storage`;
  const target = `${main}/storage/app/public`;
  return [
    'set -e',
    `LINK=${q(link)}`,
    `TARGET=${q(target)}`,
    // Repair whatever is in the way instead of failing: a stale symlink is
    // replaced, and a leftover directory from an earlier manual setup is moved
    // aside rather than deleted, so nothing on the server is ever destroyed.
    'if [ -L "$LINK" ]; then',
    '  rm -f "$LINK"',
    'elif [ -d "$LINK" ] && [ -z "$(ls -A "$LINK" 2>/dev/null)" ]; then',
    '  rmdir "$LINK"',
    'elif [ -e "$LINK" ]; then',
    '  BACKUP="$LINK.bak.$(date +%Y%m%d%H%M%S)"',
    '  n=1',
    '  while [ -e "$BACKUP" ]; do BACKUP="$LINK.bak.$(date +%Y%m%d%H%M%S).$n"; n=$((n + 1)); done',
    '  mv "$LINK" "$BACKUP"',
    '  echo "MOVED_ASIDE:$BACKUP"',
    'fi',
    'ln -s "$TARGET" "$LINK"',
  ].join('\n');
}

/** Keys we manage in the server's .env. Everything else is preserved. */
export function envUpdates(config: Config, db: { username: string; password: string }): Record<string, string> {
  return {
    APP_ENV: 'production',
    APP_DEBUG: 'false',
    APP_URL: `https://${config.site.domain}`,
    DB_CONNECTION: 'mysql',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_DATABASE: config.database.name,
    DB_USERNAME: db.username,
    DB_PASSWORD: db.password,
  };
}

const formatValue = (v: string) => (/^[A-Za-z0-9_.:/@-]*$/.test(v) ? v : `"${v.replace(/(["\\$])/g, '\\$1')}"`);

/** Update/insert keys in .env text; unrelated lines and existing APP_KEY are untouched. */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing === '' ? [] : existing.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    const key = m?.[1];
    if (key && key in updates) {
      if (seen.has(key)) return null; // drop duplicates
      seen.add(key);
      return `${key}=${formatValue(updates[key]!)}`;
    }
    return line;
  });
  const result = out.filter((l): l is string => l !== null);
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) result.push(`${k}=${formatValue(v)}`);
  }
  return result.join('\n') + '\n';
}

export function hasAppKey(env: string): boolean {
  return /^APP_KEY=\S+/m.test(env);
}
