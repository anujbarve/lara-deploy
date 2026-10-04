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
import { AaPanelClient, assertPanelUrl, getDataParams, isSuccess } from './client.js';
import type { AaPanelResponse } from './client.js';
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

/** aaPanel's SQLite config database, where it keeps the MySQL root password. */
const AA_PANEL_DB = '/www/server/panel/data/default.db';
/** The socket aaPanel's MySQL listens on. */
const AA_PANEL_MYSQL_SOCKET = '/tmp/mysql.sock';

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
        ...(options.config.hostHeader ? { hostHeader: options.config.hostHeader } : {}),
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
      const list = await this.siteListApi(domain);
      return list.some((site) => site.name === domain);
    }
    // SSH discovery: the panel writes one directory per site.
    const base = `${this.options.profile.siteRoot}/${domain}`;
    const result = await this.options.executor.exec(`test -d ${q(base)}`, { allowFailure: true });
    return result.exitCode === 0;
  }

  async getWebsite(domain: string): Promise<WebsiteInfo | null> {
    assertHostname(domain);
    if (this.client) {
      const list = await this.siteListApi(domain);
      const found = list.find((site) => site.name === domain);
      if (!found) return null;
      const ssl = await this.getSslStatus(domain);
      return {
        name: found.name,
        domain: found.name,
        port: 80,
        root: found.path,
        documentRoot: found.path,
        status: 'running',
        phpVersion: found.php_version,
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
    await this.assertWebrootIsSafe(input.root, input.domain);

    if (this.client) {
      // AddSite lives on /v2/site, not /v2/data, and validates `webname` as a
      // JSON string — not a bare `domain` field. Every declared parameter is
      // sent: the panel rejects the whole call if one is absent.
      const response = await this.client.requestOn('site', 'AddSite', {
        webname: JSON.stringify({ domain: input.domain, domainlist: [] }),
        path: input.root,
        port: 80,
        version: input.phpVersion ?? '',
        ps: input.domain,
        type: '',
        sql: '',
        datapassword: '',
        codeing: 'utf8mb4',
        type_id: 0,
        force_ssl: 0,
        ftp: 'false',
        is_create_default_file: 'true',
        ssl_auto: 0,
        sub_dir: '',
        project_type: 'PHP',
      });
      const payload = response.message as { siteId?: unknown } | undefined;
      const siteId = typeof payload?.siteId === 'number' ? payload.siteId : undefined;
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

  /**
   * Refuse to create a site over a webroot that already holds something.
   *
   * aaPanel deletes the contents of the site path when it creates a website —
   * there is no "directory is not empty" guard on the API path, unlike the
   * panel UI which asks first. A previous deployment's `releases/`, `current`
   * symlink, `shared/.env` and deploy history all live under this directory, so
   * creating the site after an upload silently destroys the deployed release.
   * This must be checked before calling AddSite, and must also work when the
   * panel API is unavailable (the SSH path creates the site too).
   */
  private async assertWebrootIsSafe(root: string, domain: string): Promise<void> {
    const marker = `${root.replace(/\/+$/, '')}/.deploy`;
    const result = await this.options.executor.exec(
      `test -e ${q(marker)} && echo DEPLOY_MARKER || { test -d ${q(root)} && find ${q(root)} -mindepth 1 -maxdepth 1 | head -1; }`,
      { allowFailure: true, timeoutMs: 15_000 },
    );
    // A non-zero exit means the directory does not exist, which is the safe case.
    if (result.exitCode !== 0) return;
    const output = result.stdout.trim();
    if (output === '') return;
    throw new PanelError(
      `Refusing to create the website for ${domain}: ${root} is not empty.`,
      {
        details: { firstEntry: output },
        remediation: [
          `aaPanel deletes the site path on creation, which would destroy ${output}.`,
          'Move the directory aside, or create the website in aaPanel first so the deploy reuses it.',
          'If this webroot is unrelated to the deploy, set site.root to a dedicated directory.',
        ],
      },
    );
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
      const list = await this.siteListApi(domain);
      const found = list.find((site) => site.name === domain);
      if (!found) return false;
      await this.client.requestOn('site', 'DeleteSite', { id: found.id });
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
      const list = await this.databaseListApi(name);
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
      const list = await this.databaseListApi(name);
      const found = list.find((db) => db.name === name);
      if (!found) return null;
      return {
        name: found.name,
        username: found.username,
        // aaPanel records the granted access hosts rather than a single host.
        host: found.host ?? found.accept ?? 'localhost',
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
      // AddDatabase lives on /v2/database. Its parameters are validated by a
      // strict schema: `db_user` (not `user`), `address` (not `access`), plus
      // `codeing`, `sid`, `active` and `dtype`. A missing one is answered with
      // "<field> is required", which this client used to report as a bare
      // "Specific parameters are invalid!" — the same message as an action the
      // panel does not know, so the cause was impossible to see from the error.
      await this.client.requestOn('database', 'AddDatabase', {
        name: input.name,
        db_user: input.username,
        password: input.password,
        codeing: 'utf8mb4',
        address: input.host ?? 'localhost',
        sid: 0,
        active: 'true',
        dtype: 'mysql',
        ps: input.name,
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
    // aaPanel stores the MySQL root password in its own SQLite database, and
    // it is not empty on every install. MysqlProvider's default assumes a
    // passwordless socket, which fails with "Access denied for user root" on
    // any server that has actually set one.
    const root = await this.mysqlRootCredentials();
    return new MysqlProvider({ executor: this.options.executor, logger: this.logger, ...(root ? { root } : {}) });
  }

  /**
   * The root credentials aaPanel uses, read from its config database. Returns
   * null when they cannot be read, leaving the caller's defaults in place
   * rather than inventing credentials.
   */
  private async mysqlRootCredentials(): Promise<{ username: string; password: string; socket: string } | null> {
    const result = await this.options.executor.exec(
      `sqlite3 ${q(AA_PANEL_DB)} ${q(`SELECT mysql_root FROM config LIMIT 1;`)} 2>/dev/null`,
      { allowFailure: true, timeoutMs: 15_000 },
    );
    const password = result.exitCode === 0 ? result.stdout.trim() : '';
    if (password === '') return null;
    return { username: 'root', password, socket: AA_PANEL_MYSQL_SOCKET };
  }

  // -------------------------------------------------------------------------
  // SSL
  // -------------------------------------------------------------------------

  async getSslStatus(domain: string): Promise<SslInfo> {
    assertHostname(domain);
    if (this.client) {
      // GetSSL takes `siteName`, and its payload has no `endtime`/`ca`/`ishttps`
      // fields — the real expiry is nested under `cert_data.notAfter` and the
      // issuer under `cert_data.issuer_O`. An unknown site comes back with a
      // non-zero status, which is how "no certificate" is distinguished from
      // "certificate present".
      const response = await this.client.requestOn<{
        status?: boolean;
        cert_data?: { notAfter?: string; issuer_O?: string; dns?: string[] };
      }>('site', 'GetSSL', { siteName: domain }, { allowFailure: true });
      if (!isSuccess(response.status)) return { enabled: false, provider: 'none', domains: [] };
      const payload = response.message;
      if (!payload?.status) return { enabled: false, provider: 'none', domains: [] };
      const issuer = payload.cert_data?.issuer_O ?? '';
      return {
        enabled: true,
        provider: issuer === "Let's Encrypt" ? 'letsencrypt' : 'other',
        expiry: payload.cert_data?.notAfter ?? null,
        domains: payload.cert_data?.dns ?? [],
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
      // SetSSL wants `domain` and `domains`; `type` is "letsencrypt" and `force`
      // is "y"/"n". Additional names go in `domains` as a comma-separated list.
      await this.client.requestOn('site', 'SetSSL', {
        domain: input.domain,
        domains: [input.domain, ...(input.altNames ?? [])].join(','),
        type: 'letsencrypt',
        force: input.force ? 'y' : 'n',
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
      documentRoot: await this.documentRootOf(domain, website.root),
      phpVersion: website.phpVersion,
    };
  }

  /**
   * The directory nginx actually serves.
   *
   * The site's `path` is only the webroot; the panel stores the serving
   * directory separately as a run path relative to it. Reporting the webroot
   * as the document root makes a correctly-configured site look misconfigured.
   */
  private async documentRootOf(domain: string, siteRoot: string): Promise<string> {
    if (!this.client) return siteRoot;
    const list = await this.siteListApi(domain);
    const found = list.find((site) => site.name === domain);
    if (!found) return siteRoot;
    const response = await this.client.requestOn<{ runPath?: string }>(
      'site',
      'GetSiteRunPath',
      { id: found.id },
      { allowFailure: true },
    );
    const runPath = response.message?.runPath;
    if (!isSuccess(response.status) || typeof runPath !== 'string' || runPath === '/' || runPath === '') {
      return siteRoot;
    }
    return `${siteRoot.replace(/\/+$/, '')}${runPath.startsWith('/') ? runPath : `/${runPath}`}`;
  }

  async updateSiteConfig(config: SiteConfig): Promise<void> {
    assertHostname(config.domain);
    if (this.client) {
      const list = await this.siteListApi(config.domain);
      const found = list.find((site) => site.name === config.domain);
      if (!found) throw new PanelError(`Website "${config.domain}" not found; cannot set its document root.`);
      // SetSiteRunPath takes a path RELATIVE to the site root (the panel
      // concatenates it onto the site's own path), not an absolute one. There is
      // no `SiteConfig` action on this panel version.
      const siteRoot = found.path.replace(/\/+$/, '');
      const documentRoot = config.documentRoot.replace(/\/+$/, '');
      if (!documentRoot.startsWith(`${siteRoot}/`)) {
        throw new PanelError(
          `Document root ${documentRoot} is outside the site root ${siteRoot} for ${config.domain}.`,
          {
            remediation: [
              `Set site.root to ${siteRoot} so the deploy layout lives inside the website directory.`,
            ],
          },
        );
      }
      await this.client.requestOn('site', 'SetSiteRunPath', {
        id: found.id,
        runPath: documentRoot.slice(siteRoot.length),
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
      const list = await this.siteListApi(domain);
      const found = list.find((site) => site.name === domain);
      if (!found) throw new PanelError(`Website "${domain}" not found; cannot set PHP version.`);
      // SetPHPVersion reads `version`, not `phpVersion`; passing `phpVersion`
      // leaves the version unset and the panel answers with an HTML 404.
      await this.client.requestOn('site', 'SetPHPVersion', { siteName: domain, version, other: '' });
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

  /**
   * Sites known to the panel, read through the generic table endpoint.
   *
   * There is no `GetSiteList` action on this panel version; the listing that
   * does exist, `/v2/site?action=get_site_list`, answers with an empty list for
   * a site that the panel clearly has. `/v2/data?action=getData&table=sites`
   * returns the real rows, which is what this reads.
   */
  private async siteListApi(search?: string): Promise<ApiSite[]> {
    const response = await this.requireClient().requestOn<unknown>(
      'data',
      'getData',
      getDataParams('sites', 200, search ?? ''),
    );
    return rowsOf(response).filter((row): row is ApiSite => isRecord(row) && typeof row.name === 'string');
  }

  /**
   * Databases registered with the panel.
   *
   * Reading this is what makes a database visible in aaPanel at all: a database
   * created with raw SQL over SSH exists in MySQL but is absent from the
   * panel's `databases` table, so it is unmanaged and invisible in the UI.
   */
  private async databaseListApi(search?: string): Promise<ApiDatabase[]> {
    const response = await this.requireClient().requestOn<unknown>(
      'data',
      'getData',
      getDataParams('databases', 200, search ?? ''),
    );
    return rowsOf(response).filter(
      (row): row is ApiDatabase => isRecord(row) && typeof row.name === 'string',
    );
  }
}

/** Unwrap the `message.data` rows that `/v2/data?action=getData` returns. */
function rowsOf(response: AaPanelResponse<unknown>): unknown[] {
  const message = response.message;
  if (Array.isArray(message)) return message;
  if (isRecord(message) && Array.isArray(message.data)) return message.data;
  if (Array.isArray(response.data)) return response.data;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The site shape returned by `/v2/data?action=getData&table=sites`.
 *
 * Note the trap: the row's `domain` field is the *number* of domains bound to
 * the site, not the domain itself. Reading it as the domain yields `domain: 1`
 * and every hostname comparison fails, which looks like "the site does not
 * exist" for a site that plainly does.
 */
interface ApiSite {
  id: number;
  /** The primary domain. */
  name: string;
  /** Absolute webroot. */
  path: string;
  /** e.g. "8.3". */
  php_version?: string;
}

/** The database shape returned by the aaPanel API. */
interface ApiDatabase {
  id: number;
  name: string;
  username: string;
  /** The access hosts aaPanel grants, e.g. "localhost". */
  accept?: string;
  host?: string;
  port?: number;
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