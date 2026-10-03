/**
 * aaPanel adapter.
 *
 * Two operating modes behind one interface:
 *  - `api` — the panel's HTTP API, used when an API key is configured;
 *  - `ssh` — the aaPanel/bt CLI and its on-disk configuration, used when no key
 *    is available or when the user forces SSH mode.
 *
 * Both modes are idempotent: `ensureWebsite` / `ensureDatabase` check existence
 * first and reuse whatever is already there (SPEC §10).
 */

import { PanelError, MissingCredentialError } from '../../core/errors/errors.js';
import { q, assertRemotePath, assertHostname } from '../../utils/shell.js';
import { AaPanelClient, assertPanelUrl } from './client.js';
import type {
  PanelAdapter,
  PanelAvailability,
  WebsiteInfo,
  DatabaseInfo,
  SslInfo,
  SiteConfig,
} from './types.js';
import type { RemoteExecutor } from '../exec/types.js';
import type { AaPanelConfig, ServerProfile } from '../../core/config/schema.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

export interface AaPanelAdapterOptions {
  profile: ServerProfile;
  config: AaPanelConfig;
  executor: RemoteExecutor;
  logger?: Logger;
  /** Panel base path, normally `/www/server/panel`. */
  panelRoot?: string;
  /** Injectable for tests. */
  clientFactory?: (config: AaPanelConfig, logger: Logger) => AaPanelClient | null;
}

export class AaPanelAdapter implements PanelAdapter {
  readonly name = 'aaPanel';
  readonly canProvision: boolean;

  private readonly logger: Logger;
  private readonly panelRoot: string;
  private readonly client: AaPanelClient | null;

  constructor(private readonly options: AaPanelAdapterOptions) {
    this.logger = options.logger ?? nullLogger();
    this.panelRoot = options.panelRoot ?? '/www/server/panel';
    const apiKey = this.resolveApiKey();
    const useApi = !options.config.forceSsh && !!apiKey && !!options.config.url;

    if (options.clientFactory) {
      this.client = options.clientFactory(options.config, this.logger);
    } else if (useApi) {
      assertPanelUrl(options.config.url as string);
      this.client = new AaPanelClient({
        baseUrl: options.config.url as string,
        apiKey: apiKey as string,
        timeoutMs: options.config.timeoutMs,
        insecureTLS: options.config.insecureTLS,
        logger: this.logger,
      });
    } else {
      this.client = null;
    }

    this.canProvision = options.config.enabled;
  }

  private resolveApiKey(): string | undefined {
    const fromEnv = process.env.LARAVEL_DEPLOY_AAPANEL_KEY;
    if (fromEnv && fromEnv !== '') return fromEnv;
    return this.options.config.apiKey;
  }

  private get mode(): 'api' | 'ssh' {
    return this.client ? 'api' : 'ssh';
  }

  private requireClient(): AaPanelClient {
    if (!this.client) {
      throw new MissingCredentialError('aaPanel API access is not configured.', {
        remediation: [
          'Set the API key: laravel-deploy server set <name> --aapanel-key <key>',
          'Or export LARAVEL_DEPLOY_AAPANEL_KEY=<key>.',
          'Or run with --no-provision to assume the website and database already exist.',
        ],
      });
    }
    return this.client;
  }

  async available(): Promise<PanelAvailability> {
    if (!this.options.config.enabled) {
      return {
        available: true,
        mode: 'ssh',
        reason: 'aaPanel provisioning disabled; using SSH for discovery only.',
      };
    }
    if (this.client) {
      const ok = await this.client.ping();
      if (ok) return { available: true, mode: 'api', reason: 'aaPanel API reachable.' };
      if (this.options.config.fallbackToSsh) {
        return {
          available: true,
          mode: 'ssh',
          reason: 'aaPanel API unreachable; falling back to SSH.',
          remediation: ['Verify the API key and panel URL for full provisioning.'],
        };
      }
      return {
        available: false,
        mode: 'unavailable',
        reason: 'aaPanel API is not reachable and SSH fallback is disabled.',
        remediation: ['Set aaPanel.fallbackToSsh = true, or fix the panel credentials.'],
      };
    }
    if (this.options.config.fallbackToSsh) {
      return {
        available: true,
        mode: 'ssh',
        reason: 'No aaPanel API key configured; using the panel CLI over SSH.',
      };
    }
    return {
      available: false,
      mode: 'unavailable',
      reason: 'aaPanel is enabled but no API key is configured and SSH fallback is disabled.',
      remediation: [
        'laravel-deploy server set <name> --aapanel-key <key>',
        'Or set aaPanel.fallbackToSsh = true to provision over SSH.',
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Websites
  // -------------------------------------------------------------------------

  async websiteExists(domain: string): Promise<boolean> {
    assertHostname(domain);
    if (this.client) {
      const list = await this.siteListApi();
      return list.some((site) => site.domain === domain || site.name === domain);
    }
    // SSH discovery: the panel writes one directory per site.
    const base = `${this.options.profile.siteRoot}/${domain}`;
    const result = await this.options.executor.exec(`test -d ${q(base)}`, { allowFailure: true });
    return result.exitCode === 0;
  }

  async getWebsite(domain: string): Promise<WebsiteInfo | null> {
    assertHostname(domain);
    if (this.client) {
      const list = await this.siteListApi();
      const found = list.find((site) => site.domain === domain || site.name === domain);
      if (!found) return null;
      const ssl = await this.getSslStatus(domain);
      return {
        name: found.name,
        domain: found.domain ?? found.name,
        port: found.port ?? 80,
        root: found.path,
        documentRoot: found.path,
        status: 'running',
        phpVersion: found.phpVersion,
        sslEnabled: ssl.enabled,
        sslExpiry: ssl.expiry ?? null,
      };
    }
    const exists = await this.websiteExists(domain);
    if (!exists) return null;
    const root = `${this.options.profile.siteRoot}/${domain}`;
    const ssl = await this.getSslStatus(domain);
    return {
      name: domain,
      domain,
      port: 80,
      root,
      documentRoot: root,
      status: 'unknown',
      sslEnabled: ssl.enabled,
      sslExpiry: ssl.expiry ?? null,
    };
  }

  async createWebsite(input: {
    domain: string;
    root: string;
    phpVersion?: string;
  }): Promise<WebsiteInfo> {
    assertHostname(input.domain);
    assertRemotePath(input.root, 'site root');

    if (await this.websiteExists(input.domain)) {
      throw new PanelError(`Website "${input.domain}" already exists.`, {
        remediation: ['Nothing to do — the deployment will reuse the existing website.'],
      });
    }
    if (!this.canProvision) {
      throw new PanelError('Refusing to create a website while provisioning is disabled.', {
        remediation: ['Remove --no-provision, or create the website in aaPanel manually.'],
      });
    }

    if (this.client) {
      const response = await this.client.request('AddSite', {
        domain: input.domain,
        path: input.root,
        port: 80,
        psr: input.phpVersion,
        type: 'php',
      });
      const siteId = typeof response.siteId === 'number' ? response.siteId : undefined;
      if (siteId !== undefined && input.phpVersion) {
        await this.setPhpVersion(input.domain, input.phpVersion);
      }
      return {
        name: input.domain,
        domain: input.domain,
        port: 80,
        root: input.root,
        documentRoot: input.root,
        status: 'running',
        phpVersion: input.phpVersion,
      };
    }

    await this.createWebsiteViaSsh(input);
    return {
      name: input.domain,
      domain: input.domain,
      port: 80,
      root: input.root,
      documentRoot: input.root,
      status: 'running',
      phpVersion: input.phpVersion,
    };
  }

  private async createWebsiteViaSsh(input: { domain: string; root: string; phpVersion?: string }): Promise<void> {
    const { executor } = this.options;
    const root = assertRemotePath(input.root, 'site root');
    // aaPanel's CLI wraps site creation; bt is the legacy alias and always present.
    const script = [
      'set -Eeuo pipefail',
      `mkdir -p ${q(root)}`,
      `if command -v bt >/dev/null 2>&1; then`,
      `  bt 1 >/dev/null || true`, // start nginx + php-fpm so the site can be created
      `fi`,
      `cd ${q(this.panelRoot)}`,
      // bt default adds a site with its own index page; index.html is expected.
      `bt ${[String(12), q(input.domain), q(root), 'php', input.phpVersion ?? '82'].join(' ')} >/dev/null`,
    ].join('\n');
    const result = await executor.exec(script, { label: 'aaPanel create website', timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new PanelError(`aaPanel failed to create the website for ${input.domain}.`, {
        command: 'bt 12 <domain> <root> php <version>',
        details: { stderr: result.stderr.slice(-2000) },
        remediation: ['Check that bt is installed and the SSH user can reach the panel CLI.'],
      });
    }
  }

  async deleteWebsite(domain: string): Promise<boolean> {
    assertHostname(domain);
    if (!this.canProvision) {
      throw new PanelError('Refusing to delete a website while provisioning is disabled.');
    }
    if (this.client) {
      const list = await this.siteListApi();
      const found = list.find((site) => site.domain === domain);
      if (!found) return false;
      await this.client.request('DeleteSite', { id: found.id });
      return true;
    }
    const result = await this.options.executor.exec(
      `cd ${q(this.panelRoot)} && bt 27 ${q(domain)}`,
      { label: 'aaPanel delete website' },
    );
    return result.exitCode === 0;
  }

  // -------------------------------------------------------------------------
  // Databases
  // -------------------------------------------------------------------------

  async databaseExists(name: string): Promise<boolean> {
    if (this.client) {
      const list = await this.databaseListApi();
      return list.some((db) => db.name === name);
    }
    const result = await this.options.executor.exec(
      `mysql -N -B -e ${q(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${name.replace(/'/g, "''")}'`)}`,
      { allowFailure: true, timeoutMs: 30_000 },
    );
    return result.exitCode === 0 && result.stdout.includes(name);
  }

  async getDatabase(name: string): Promise<DatabaseInfo | null> {
    if (this.client) {
      const list = await this.databaseListApi();
      const found = list.find((db) => db.name === name);
      if (!found) return null;
      return {
        name: found.name,
        username: found.username,
        host: found.host ?? 'localhost',
        port: found.port ?? 3306,
        accept: true,
      };
    }
    const exists = await this.databaseExists(name);
    if (!exists) return null;
    return { name, username: name, host: 'localhost', port: 3306, accept: true };
  }

  async createDatabase(input: {
    name: string;
    username: string;
    password: string;
    host?: string;
  }): Promise<DatabaseInfo> {
    if (await this.databaseExists(input.name)) {
      throw new PanelError(`Database "${input.name}" already exists.`, {
        remediation: ['Nothing to do — the deployment will reuse the existing database.'],
      });
    }
    if (!this.canProvision) {
      throw new PanelError('Refusing to create a database while provisioning is disabled.');
    }

    if (this.client) {
      await this.client.request('AddDatabase', {
        name: input.name,
        user: input.username,
        password: input.password,
        access: '127.0.0.1',
        psw: input.password,
      });
    } else {
      // MysqlProvider owns SQL execution; the adapter delegates.
      const mysql = await this.mysqlProvider();
      await mysql.createDatabaseAndUser({
        name: input.name,
        username: input.username,
        password: input.password,
      });
    }

    return {
      name: input.name,
      username: input.username,
      host: input.host ?? 'localhost',
      port: 3306,
      accept: true,
    };
  }

  private async mysqlProvider() {
    const { MysqlProvider } = await import('../mysql/provider.js');
    return new MysqlProvider({ executor: this.options.executor, logger: this.logger });
  }

  // -------------------------------------------------------------------------
  // SSL
  // -------------------------------------------------------------------------

  async getSslStatus(domain: string): Promise<SslInfo> {
    assertHostname(domain);
    if (this.client) {
      const response = await this.client.request('GetSSLInfo', { domain }, { allowFailure: true });
      if (response.status !== true) return { enabled: false, provider: 'none', domains: [] };
      return {
        enabled: Boolean(response.status === true && (response.ishttps === 'y' || response.ishttps === true)),
        provider: response.ca === 'letsencrypt' ? 'letsencrypt' : 'other',
        expiry: typeof response.endtime === 'string' ? response.endtime : null,
        domains: [],
      };
    }
    const certDir = `/www/server/panel/vhost/cert/${domain}`;
    const result = await this.options.executor.exec(
      `test -d ${q(certDir)} && ls ${q(certDir)}`,
      { allowFailure: true },
    );
    return { enabled: result.exitCode === 0, provider: result.exitCode === 0 ? 'letsencrypt' : 'none', domains: [] };
  }

  async enableSsl(input: { domain: string; altNames?: string[]; force?: boolean }): Promise<SslInfo> {
    assertHostname(input.domain);
    const current = await this.getSslStatus(input.domain);
    if (current.enabled && !input.force) {
      return current;
    }
    if (!this.canProvision) {
      throw new PanelError('Refusing to enable SSL while provisioning is disabled.', {
        remediation: ['Remove --no-provision, or issue the certificate in aaPanel manually.'],
      });
    }

    if (this.client) {
      await this.client.request('SetSSL', {
        domain: input.domain,
        type: 'letsencrypt',
        force: input.force ? 'y' : 'n',
        // aaPanel accepts additional domains as a JSON array string.
        domains: JSON.stringify([input.domain, ...(input.altNames ?? [])]),
      });
    } else {
      await this.options.executor.exec(
        `cd ${q(this.panelRoot)} && bt ${[String(21), q(input.domain), 'letsencrypt'].join(' ')}`,
        { label: 'aaPanel enable SSL', timeoutMs: 180_000 },
      );
    }

    const after = await this.getSslStatus(input.domain);
    return after;
  }

  // -------------------------------------------------------------------------
  // Site configuration
  // -------------------------------------------------------------------------

  async getSiteConfig(domain: string): Promise<SiteConfig | null> {
    const website = await this.getWebsite(domain);
    if (!website) return null;
    return {
      domain: website.domain,
      documentRoot: website.documentRoot ?? website.root,
      phpVersion: website.phpVersion,
    };
  }

  async updateSiteConfig(config: SiteConfig): Promise<void> {
    assertHostname(config.domain);
    if (this.client) {
      await this.client.request('SiteConfig', {
        name: config.domain,
        webroot: config.documentRoot,
      });
      return;
    }
    // SSH: patch the vhost's root directive.
    const vhost = `/www/server/panel/vhost/nginx/${config.domain}.conf`;
    const result = await this.options.executor.exec(
      [
        'set -Eeuo pipefail',
        `conf=${q(vhost)}`,
        `test -f "$conf" || { echo "missing $conf"; exit 1; }`,
        `tmp=$(mktemp)`,
        `sed -E 's#^(\\s*root\\s+).*$#\\1${config.documentRoot.replace(/\//g, '\\/')};#' "$conf" > "$tmp"`,
        `cat "$tmp" > "$conf"`,
        `rm -f "$tmp"`,
        `nginx -t`,
        `nginx -s reload || systemctl reload nginx || true`,
      ].join('\n'),
      { label: 'aaPanel update site config', timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      throw new PanelError(`Unable to update the vhost for ${config.domain}.`, {
        details: { stderr: result.stderr.slice(-2000) },
        remediation: ['Check nginx -t output; the vhost template may differ on this panel version.'],
      });
    }
  }

  async setPhpVersion(domain: string, version: string): Promise<void> {
    if (this.client) {
      const list = await this.siteListApi();
      const found = list.find((site) => site.domain === domain);
      if (!found) throw new PanelError(`Website "${domain}" not found; cannot set PHP version.`);
      await this.client.request('SetPHPVersion', { siteName: domain, phpVersion: version });
      return;
    }
    await this.options.executor.exec(
      `cd ${q(this.panelRoot)} && bt ${String(125)} ${q(domain)} ${q(version)}`,
      { label: 'aaPanel set PHP version', timeoutMs: 60_000 },
    );
  }

  // -------------------------------------------------------------------------
  // API list helpers
  // -------------------------------------------------------------------------

  private async siteListApi(): Promise<ApiSite[]> {
    const response = await this.requireClient().request<unknown>('GetSiteList', {});
    // aaPanel returns either `data` (newer) or the list at the top level (older).
    const raw = (Array.isArray(response) ? response : (response.data ?? response)) as unknown;
    if (Array.isArray(raw)) return raw as ApiSite[];
    if (Array.isArray((raw as { SITE?: unknown[] })?.SITE)) {
      return (raw as { SITE: ApiSite[] }).SITE;
    }
    return [];
  }

  private async databaseListApi(): Promise<Array<{ id: number; name: string; username: string; host?: string; port?: number }>> {
    const response = await this.requireClient().request<unknown>('GetDatabases', {});
    const raw = (Array.isArray(response) ? response : (response.data ?? response)) as unknown;
    if (Array.isArray(raw)) return raw as Array<{ id: number; name: string; username: string }>;
    return [];
  }
}

/** The site shape returned by the aaPanel API. */
interface ApiSite {
  id: number;
  name: string;
  domain?: string;
  path: string;
  port?: number;
  phpVersion?: string;
}

/**
 * Idempotent provisioning facade used by the orchestrator. Existence is always
 * checked first; nothing here ever creates a duplicate (SPEC §10).
 */
export interface EnsureResult<T> {
  created: boolean;
  reused: boolean;
  value: T;
  message: string;
}

export async function ensureWebsite(
  adapter: PanelAdapter,
  input: { domain: string; root: string; phpVersion?: string },
): Promise<EnsureResult<WebsiteInfo>> {
  const existing = await adapter.getWebsite(input.domain);
  if (existing) {
    return {
      created: false,
      reused: true,
      value: existing,
      message: `Website ${input.domain} exists; reusing it.`,
    };
  }
  const created = await adapter.createWebsite(input);
  return { created: true, reused: false, value: created, message: `Created website ${input.domain}.` };
}

export async function ensureDatabase(
  adapter: PanelAdapter,
  input: { name: string; username: string; password: string; host?: string },
): Promise<EnsureResult<DatabaseInfo>> {
  const existing = await adapter.getDatabase(input.name);
  if (existing) {
    return {
      created: false,
      reused: true,
      value: existing,
      message: `Database ${input.name} exists; reusing it.`,
    };
  }
  const created = await adapter.createDatabase(input);
  return { created: true, reused: false, value: created, message: `Created database ${input.name}.` };
}

export async function ensureSsl(
  adapter: PanelAdapter,
  input: { domain: string; altNames?: string[]; force?: boolean },
): Promise<EnsureResult<SslInfo>> {
  const current = await adapter.getSslStatus(input.domain);
  if (current.enabled && !input.force) {
    return { created: false, reused: true, value: current, message: `SSL already enabled for ${input.domain}.` };
  }
  const enabled = await adapter.enableSsl(input);
  return { created: true, reused: false, value: enabled, message: `Enabled SSL for ${input.domain}.` };
}