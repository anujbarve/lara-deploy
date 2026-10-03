/**
 * Web server provider (nginx / apache).
 *
 * Responsibilities: detect the server in front of PHP, find the user it runs
 * as, report the configured document root, and verify it matches the deployment
 * strategy (SPEC §17, §39).
 */

import { q } from '../../utils/shell.js';
import type { RemoteExecutor } from '../exec/types.js';

export type WebServerKind = 'nginx' | 'apache' | 'openresty' | 'unknown';

export interface WebServerInfo {
  kind: WebServerKind;
  version: string | null;
  /** OS user the server runs as, e.g. "www". */
  webUser: string;
  webGroup: string;
  configPath: string | null;
}

export interface DocumentRootCheck {
  /** Path the server is configured to serve. */
  actual: string | null;
  /** Path the deployment expects. */
  expected: string;
  ok: boolean;
  /** Remediation when it does not match. */
  detail: string;
}

export class WebServerProvider {
  constructor(private readonly executor: RemoteExecutor) {}

  async detect(): Promise<WebServerInfo> {
    const nginxVersion = await this.version('nginx');
    if (nginxVersion !== null) {
      return {
        kind: await this.hasOpenresty() ? 'openresty' : 'nginx',
        version: nginxVersion,
        webUser: await this.detectWebUser(),
        webGroup: await this.detectWebGroup(),
        configPath: await this.nginxConfigPath(),
      };
    }
    const apacheVersion = await this.version('httpd') ?? (await this.version('apache2'));
    if (apacheVersion !== null) {
      return {
        kind: 'apache',
        version: apacheVersion,
        webUser: await this.detectWebUser(),
        webGroup: await this.detectWebGroup(),
        configPath: null,
      };
    }
    return {
      kind: 'unknown',
      version: null,
      webUser: await this.detectWebUser(),
      webGroup: await this.detectWebGroup(),
      configPath: null,
    };
  }

  /** Resolve the web user, preferring the panel's conventional answer. */
  async detectWebUser(): Promise<string> {
    for (const candidate of ['www-data', 'www', 'nginx', 'apache', 'httpd']) {
      const result = await this.executor.exec(`id -un ${q(candidate)} 2>/dev/null`, { allowFailure: true });
      if (result.exitCode === 0 && result.stdout.trim() === candidate) return candidate;
    }
    // Fall back to the user owning the panel's site root.
    const owner = await this.executor.exec(
      `stat -c %U /www/wwwroot 2>/dev/null || stat -f %Su /www/wwwroot 2>/dev/null`,
      { allowFailure: true },
    );
    const name = owner.stdout.trim();
    return name !== '' ? name : 'www-data';
  }

  private async detectWebGroup(): Promise<string> {
    const result = await this.executor.exec('id -gn', { allowFailure: true });
    return result.stdout.trim() || 'www-data';
  }

  /** Read the configured root directive from the site's vhost. */
  async documentRoot(domain: string): Promise<string | null> {
    const candidates = [
      `/www/server/panel/vhost/nginx/${domain}.conf`,
      `/www/server/panel/vhost/apache/${domain}.conf`,
      `/etc/nginx/sites-enabled/${domain}.conf`,
      `/etc/nginx/conf.d/${domain}.conf`,
    ];
    for (const file of candidates) {
      const result = await this.executor.exec(
        `test -f ${q(file)} && grep -m1 -E '^\\s*root\\s+' ${q(file)} | awk '{print $2}'`,
        { allowFailure: true },
      );
      const value = result.stdout.trim().replace(/;$/, '');
      if (value !== '') return value;
    }
    return null;
  }

  /** Compare the configured root against the deployment's expectation. */
  async checkDocumentRoot(domain: string, expected: string): Promise<DocumentRootCheck> {
    const actual = await this.documentRoot(domain);
    if (actual === null) {
      return {
        actual,
        expected,
        ok: false,
        detail: `No vhost found for ${domain}; cannot verify the document root.`,
      };
    }
    const normalisedActual = actual.replace(/\/+$/, '');
    const normalisedExpected = expected.replace(/\/+$/, '');
    const ok = normalisedActual === normalisedExpected;
    return {
      actual,
      expected,
      ok,
      detail: ok ? `root ${actual}` : `root is ${actual}, expected ${expected}`,
    };
  }

  /** Reload the web server after a vhost change. */
  async reload(): Promise<void> {
    const script = [
      'set -Eeuo pipefail',
      'if command -v nginx >/dev/null 2>&1; then',
      '  nginx -t',
      '  nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null || true',
      'elif command -v apachectl >/dev/null 2>&1; then',
      '  apachectl configtest && systemctl reload httpd 2>/dev/null || true',
      'fi',
    ].join('\n');
    await this.executor.exec(script, { label: 'reload web server', allowFailure: true, timeoutMs: 60_000 });
  }

  private async version(binary: string): Promise<string | null> {
    const result = await this.executor.exec(`${binary} -v 2>&1 | head -1`, { allowFailure: true });
    const line = result.stdout.trim();
    return line === '' ? null : line;
  }

  private async hasOpenresty(): Promise<boolean> {
    const result = await this.executor.exec('command -v openresty', { allowFailure: true });
    return result.exitCode === 0;
  }

  private async nginxConfigPath(): Promise<string | null> {
    const result = await this.executor.exec('nginx -V 2>&1 | tr " " "\\n" | grep -- "--conf-path" | cut -d= -f2', {
      allowFailure: true,
    });
    const value = result.stdout.trim();
    return value === '' ? null : value;
  }
}

/**
 * Map a configured writable entry to an absolute path.
 *
 * `storage` means the release's storage symlink target — shared storage — not
 * the symlink itself, so uploads persist across releases.
 */
function resolveWritable(input: PermissionPlanInput, dir: string): string {
  if (dir.startsWith('/')) return dir.replace(/\/$/, '');
  const clean = dir.replace(/^\/+|\/+$/g, '');
  if (clean === 'storage') return `${input.sharedPath}/storage`;
  if (clean.startsWith('storage/')) return `${input.sharedPath}/${clean}`;
  if (clean === 'bootstrap/cache' || clean.startsWith('bootstrap/')) {
    return `${input.releasePath}/${clean}`;
  }
  return `${input.releasePath}/${clean}`;
}

/** Plan permission changes; never recursive chmod 777 (SPEC §17, §39). */
export interface PermissionPlanInput {
  releasePath: string;
  sharedPath: string;
  webUser: string;
  webGroup: string;
  writableDirs: readonly string[];
  dirMode: string;
  fileMode: string;
  chown: boolean;
  chownShared: boolean;
}

export interface PermissionPlan {
  steps: string[];
  /** Directories that will be group-writable. */
  writable: string[];
  /** True when the plan is a no-op. */
  empty: boolean;
}

export function planPermissions(input: PermissionPlanInput): PermissionPlan {
  const steps: string[] = [];
  const writable: string[] = [];

  if (input.chown) {
    // Application code is owned by root and not writable by the web user.
    steps.push(
      `chown -R root:${input.webGroup} ${q(input.releasePath)}`,
      `chmod -R ${input.dirMode} ${q(input.releasePath)}`,
    );
    for (const file of ['artisan', 'composer.json', 'composer.lock', 'package.json']) {
      steps.push(`[ -f ${q(`${input.releasePath}/${file}`)} ] && chmod ${input.fileMode} ${q(`${input.releasePath}/${file}`)} || true`);
    }
    steps.push(`find ${q(input.releasePath)} -type d -exec chmod ${input.dirMode} {} +`);
    steps.push(`find ${q(input.releasePath)} -type f -exec chmod ${input.fileMode} {} +`);
  }

  if (input.chownShared) {
    steps.push(`chown -R ${input.webUser}:${input.webGroup} ${q(input.sharedPath)}`);
  }

  for (const dir of input.writableDirs) {
    const target = resolveWritable(input, dir);
    writable.push(target);
    // 0775 + ownership: writable by owner and group, never by everyone.
    steps.push(
      `mkdir -p ${q(target)}`,
      `chown -R ${input.webUser}:${input.webGroup} ${q(target)}`,
      `chmod -R 0775 ${q(target)}`,
    );
  }

  return { steps, writable, empty: steps.length === 0 };
}