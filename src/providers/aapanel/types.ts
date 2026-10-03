/**
 * Panel adapter contract.
 *
 * The deployment engine only ever talks to this interface. aaPanel is one
 * implementation; Plesk, cPanel, Forge and plain VPS are others (SPEC §43, §65).
 */

export interface WebsiteInfo {
  name: string;
  domain: string;
  port: number;
  root: string;
  /** Absolute path the web server serves. */
  documentRoot?: string;
  status: 'running' | 'stopped' | 'unknown';
  phpVersion?: string;
  sslEnabled?: boolean;
  sslExpiry?: string | null;
}

export interface DatabaseInfo {
  name: string;
  username: string;
  /** Never populated with the password. */
  password?: string;
  host: string;
  port: number;
  accept: boolean;
}

export interface SslInfo {
  enabled: boolean;
  provider: 'letsencrypt' | 'other' | 'none';
  expiry?: string | null;
  domains: string[];
}

export interface SiteConfig {
  domain: string;
  documentRoot: string;
  phpVersion?: string;
  /** Force HTTPS redirect. */
  forceHttps?: boolean;
}

export interface PanelAdapter {
  /** Display name for logs. */
  readonly name: string;
  /** True when the adapter can provision; false means "read-only via SSH". */
  readonly canProvision: boolean;
  /** Probe the panel; never throws, returns a diagnostic. */
  available(): Promise<PanelAvailability>;

  createWebsite(input: { domain: string; root: string; phpVersion?: string }): Promise<WebsiteInfo>;
  websiteExists(domain: string): Promise<boolean>;
  getWebsite(domain: string): Promise<WebsiteInfo | null>;
  deleteWebsite(domain: string): Promise<boolean>;

  createDatabase(input: {
    name: string;
    username: string;
    password: string;
    host?: string;
  }): Promise<DatabaseInfo>;
  databaseExists(name: string): Promise<boolean>;
  getDatabase(name: string): Promise<DatabaseInfo | null>;

  enableSsl(input: { domain: string; altNames?: string[]; force?: boolean }): Promise<SslInfo>;
  getSslStatus(domain: string): Promise<SslInfo>;

  getSiteConfig(domain: string): Promise<SiteConfig | null>;
  updateSiteConfig(config: SiteConfig): Promise<void>;

  /** Set the PHP version the site runs under. */
  setPhpVersion(domain: string, version: string): Promise<void>;
}

export interface PanelAvailability {
  available: boolean;
  /** How the adapter is operating. */
  mode: 'api' | 'ssh' | 'unavailable';
  reason: string;
  remediation?: string[];
}

/**
 * An adapter that cannot provision. Used when the panel is unreachable and the
 * user passed --no-provision: existence checks still work via SSH, and every
 * mutating method throws with an explanation.
 */
export class ReadOnlyPanelAdapter implements PanelAdapter {
  readonly canProvision = false;

  constructor(
    readonly name: string,
    private readonly reason: string,
    private readonly remediation: string[] = [],
    private readonly probe?: Partial<PanelAdapter>,
  ) {}

  async available(): Promise<PanelAvailability> {
    return { available: false, mode: 'unavailable', reason: this.reason, remediation: this.remediation };
  }

  private unsupported<T>(): never {
    throw new Error(`${this.name}: ${this.reason}`);
  }

  async createWebsite(): Promise<WebsiteInfo> {
    this.unsupported();
  }
  async websiteExists(): Promise<boolean> {
    return (await this.probe?.websiteExists?.(undefined as never)) ?? false;
  }
  async getWebsite(): Promise<WebsiteInfo | null> {
    return (await this.probe?.getWebsite?.(undefined as never)) ?? null;
  }
  async deleteWebsite(): Promise<boolean> {
    this.unsupported();
  }
  async createDatabase(): Promise<DatabaseInfo> {
    this.unsupported();
  }
  async databaseExists(): Promise<boolean> {
    return (await this.probe?.databaseExists?.(undefined as never)) ?? false;
  }
  async getDatabase(): Promise<DatabaseInfo | null> {
    return (await this.probe?.getDatabase?.(undefined as never)) ?? null;
  }
  async enableSsl(): Promise<SslInfo> {
    this.unsupported();
  }
  async getSslStatus(): Promise<SslInfo> {
    return { enabled: false, provider: 'none', domains: [] };
  }
  async getSiteConfig(): Promise<SiteConfig | null> {
    return (await this.probe?.getSiteConfig?.(undefined as never)) ?? null;
  }
  async updateSiteConfig(): Promise<void> {
    this.unsupported();
  }
  async setPhpVersion(): Promise<void> {
    this.unsupported();
  }
}