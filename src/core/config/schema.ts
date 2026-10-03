/**
 * Configuration schema.
 *
 * Zod validates the shape; `applyConfigDefaults` fills in the smart defaults
 * (SPEC §47) so downstream code can rely on every field being present.
 */

import { z } from 'zod';
import { assertHostname, assertRemotePath } from '../../utils/shell.js';
import { SafetyError } from '../errors/errors.js';

export type DocumentRootStrategy = 'public' | 'legacy-root-copy';
export type EnvStrategy = 'preserve' | 'generate' | 'template' | 'upload';

const hostname = z
  .string()
  .min(1, 'required')
  .refine((value) => {
    try {
      assertHostname(value);
      return true;
    } catch {
      return false;
    }
  }, 'invalid hostname');

const remotePath = z.string().refine(
  (value) => {
    try {
      assertRemotePath(value, 'site.root');
      return true;
    } catch {
      return false;
    }
  },
  'must be an absolute path without traversal segments',
);

// ---------------------------------------------------------------------------
// Project configuration (.laravel-deploy.json)
// ---------------------------------------------------------------------------

export const siteConfigSchema = z.object({
  domain: hostname,
  /** Alias accepted for convenience; merged into domain by the loader. */
  domains: z.array(hostname).default([]),
  /**
   * `public`             → web root is <root>/current/public
   * `legacy-root-copy`   → aaPanel style: <root>/main plus copied public assets
   */
  documentRootStrategy: z.enum(['public', 'legacy-root-copy']).default('public'),
  /** Absolute remote directory holding releases/shared/current. */
  root: remotePath.optional(),
  /** PHP version the panel should use, e.g. "8.3". */
  phpVersion: z.string().regex(/^\d+\.\d+$/, 'must look like 8.3').optional(),
  /** Extra server names (www, aliases). */
  serverNames: z.array(hostname).default([]),
});

export const deploymentConfigSchema = z.object({
  build: z.boolean().default(true),
  composer: z.boolean().default(true),
  frontend: z.boolean().default(true),
  migrations: z.boolean().default(true),
  seeders: z.boolean().default(false),
  optimize: z.boolean().default(true),
  healthCheck: z.boolean().default(true),
  backupDatabaseBeforeMigration: z.boolean().default(true),
  keepReleases: z.number().int().min(1).max(100).default(5),
  /** Extra commands appended after the detected build pipeline. */
  extraBuildCommands: z.array(z.string()).default([]),
  /** Override the entire detected pipeline. */
  buildCommands: z.array(z.string()).optional(),
  /** Restart queue workers after activation. Defaults to queue.enabled. */
  restartWorkers: z.boolean().optional(),
  /** Roll back automatically when the live health check fails after activation. */
  rollbackOnHealthFailure: z.boolean().default(true),
  /** Seconds to wait for HTTP stabilisation after the symlink switch. */
  activationSettleSeconds: z.number().int().min(0).max(120).default(2),
});

export const buildConfigSchema = z.object({
  commands: z.array(z.string().min(1)).optional(),
  /** Override lockfile detection. */
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).optional(),
  /** Skip the frontend step entirely. */
  skipFrontend: z.boolean().default(false),
  /** Skip the composer step entirely. */
  skipComposer: z.boolean().default(false),
  /** Also run the dev install (vendor with dev deps). Default false. */
  includeDev: z.boolean().default(false),
});

export const phpConfigSchema = z.object({
  binary: z.string().min(1).default('php'),
  /** Binary used for remote artisan invocations; often version-pinned. */
  remoteBinary: z.string().min(1).optional(),
  /** Hard requirement check against composer.json. Default true. */
  enforceVersion: z.boolean().default(true),
});

export const databaseConfigSchema = z.object({
  driver: z.enum(['mysql', 'mariadb']).default('mysql'),
  createIfMissing: z.boolean().default(true),
  /** Defaults to the project slug. */
  name: z.string().min(1).optional(),
  /** Defaults to `name`. */
  username: z.string().min(1).optional(),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3306),
  /** Retain backups under <root>/deploy-backups. */
  backupPath: remotePath.optional(),
  /** Keep this many backups; oldest pruned. */
  keepBackups: z.number().int().min(1).max(100).default(10),
});

export const queueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  driver: z.string().default('database'),
  connection: z.string().optional(),
  workers: z.number().int().min(1).max(64).default(1),
  /** Supervisor program name; derived from the project slug when absent. */
  processName: z.string().min(1).optional(),
  /** Extra artisan flags appended to `queue:work`. */
  options: z.array(z.string()).default([]),
  /** Seconds to wait for workers after restart. */
  restartTimeoutSeconds: z.number().int().min(1).max(600).default(15),
});

export const schedulerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Cron expression; defaults to every minute. */
  schedule: z.string().min(1).default('* * * * *'),
  /** Run as this OS user instead of the SSH user. */
  runAs: z.string().min(1).optional(),
  /** Comment marker used to make installation idempotent. */
  comment: z.string().min(1).default('laravel-deploy'),
});

export const seedersConfigSchema = z.object({
  enabled: z.boolean().default(false),
  class: z.string().min(1).default('Database\\Seeders\\DatabaseSeeder'),
  /** Extra `db:seed --class=` invocations. */
  extraClasses: z.array(z.string()).default([]),
});

export const sslConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['letsencrypt', 'none']).default('letsencrypt'),
  /** Extra domains to include in the certificate. */
  altNames: z.array(hostname).default([]),
  /** Force renewal even if the panel reports a valid certificate. */
  force: z.boolean().default(false),
  /** Abort deployment when HTTPS cannot be verified. Default false. */
  required: z.boolean().default(false),
});

export const envConfigSchema = z.object({
  /** preserve: never touch the server .env. Default. */
  strategy: z.enum(['preserve', 'generate', 'template', 'upload']).default('preserve'),
  /** Used by `template`: path to a local .env template. */
  templatePath: z.string().min(1).optional(),
  /** Used by `upload`: path to a local .env. Never uploaded by default. */
  uploadPath: z.string().min(1).optional(),
  /** Generate these when they are absent from the server .env. */
  generate: z.array(z.string()).default([]),
  /** Create the server .env from .env.example when missing. */
  initialiseFromExample: z.boolean().default(true),
  /** Extra key=value pairs written on first provisioning. */
  values: z.record(z.string()).default({}),
});

export const healthCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Laravel health endpoint. `/up` exists from Laravel 11. */
  url: z.string().min(1).default('/up'),
  /** Probe the live domain over HTTP(S). */
  http: z.boolean().default(true),
  /** Laravel `about` bootstrap check. */
  artisan: z.boolean().default(true),
  database: z.boolean().default(true),
  storage: z.boolean().default(true),
  ssl: z.boolean().default(true),
  queue: z.boolean().default(true),
  scheduler: z.boolean().default(true),
  /** Accepted HTTP status codes. */
  expectStatus: z.array(z.number().int()).default([200, 201, 202, 204, 301, 302, 307, 308]),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  attempts: z.number().int().min(1).max(10).default(3),
  /** Seconds to wait between attempts. */
  retryDelayMs: z.number().int().min(0).max(60_000).default(2_000),
});

export const timeoutsSchema = z.object({
  ssh: z.number().int().min(1000).default(30_000),
  upload: z.number().int().min(1000).default(300_000),
  healthCheck: z.number().int().min(1000).default(30_000),
  artisan: z.number().int().min(1000).default(300_000),
  panel: z.number().int().min(1000).default(30_000),
  localBuild: z.number().int().min(1000).default(1_800_000),
  databaseBackup: z.number().int().min(1000).default(600_000),
});

export const packagingConfigSchema = z.object({
  /** Additional glob patterns to exclude from the archive. */
  exclude: z.array(z.string()).default([]),
  /** Patterns that must be included even if normally excluded. */
  include: z.array(z.string()).default([]),
  /** Archive format. */
  format: z.enum(['tar.gz', 'zip']).default('tar.gz'),
  /** Compression level 0-9. */
  level: z.number().int().min(0).max(9).default(6),
  /** Local scratch directory for the built archive. */
  tempDir: z.string().min(1).optional(),
});

export const permissionsConfigSchema = z.object({
  /** OS user owning the web server process; detected when possible. */
  webUser: z.string().min(1).optional(),
  /** Overrides the panel default. */
  forceWebUser: z.boolean().default(false),
  /** `chown -R` the release to webUser:group. Default true. */
  chown: z.boolean().default(true),
  /** Extra directories to chown (release + shared storage). */
  chownShared: z.boolean().default(true),
  /** Directories that must be group-writable. */
  writable: z.array(z.string()).default(['storage', 'bootstrap/cache']),
  /** Explicit file mode for the release. Default 0755. */
  dirMode: z.string().regex(/^0?\d{3,4}$/).default('0755'),
  fileMode: z.string().regex(/^0?\d{3,4}$/).default('0644'),
  /** Escape hatch. Default false and loudly warned about. */
  chmod777: z.boolean().default(false),
});

export const legacyConfigSchema = z.object({
  /** Directory name holding the extracted app in legacy mode. */
  mainDir: z.string().min(1).default('main'),
  /** Copy public/* into the site root. */
  copyPublic: z.boolean().default(true),
  /** Rewrite index.php require paths to ../main/. */
  rewriteIndexPhp: z.boolean().default(true),
  /** Files at the site root that must never be overwritten. */
  preserveRootFiles: z.array(z.string()).default(['.user.ini', '.htaccess', '.well-known']),
});

export const appConfigSchema = z.object({
  server: z.string().min(1, 'required'),
  site: siteConfigSchema,
  deployment: deploymentConfigSchema.default({}),
  build: buildConfigSchema.default({}),
  php: phpConfigSchema.default({}),
  database: databaseConfigSchema.default({}),
  queue: queueConfigSchema.default({}),
  scheduler: schedulerConfigSchema.default({}),
  seeders: seedersConfigSchema.default({}),
  ssl: sslConfigSchema.default({}),
  env: envConfigSchema.default({}),
  healthCheck: healthCheckConfigSchema.default({}),
  packaging: packagingConfigSchema.default({}),
  permissions: permissionsConfigSchema.default({}),
  legacy: legacyConfigSchema.default({}),
  timeouts: timeoutsSchema.default({}),
  /** Required/optional env var policy for validation. */
  envValidation: z
    .object({
      required: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
      /** Stop the deploy when a required var is missing. Default false. */
      blockOnMissing: z.boolean().default(false),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Global configuration (the global config directory: %APPDATA% on Windows,
// ~/.config elsewhere)
// ---------------------------------------------------------------------------

export const aapanelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Base URL of the panel, e.g. https://1.2.3.4:7800 */
  url: z
    .string()
    .url()
    .optional(),
  /** API key. Prefer the env var LARAVEL_DEPLOY_AAPANEL_KEY. */
  apiKey: z.string().optional(),
  /** Panel request timeout. */
  timeoutMs: z.number().int().min(1000).default(30_000),
  /** SSL verification for the panel's self-signed certificate. */
  insecureTLS: z.boolean().default(false),
  /** Skip the panel API and drive panel behaviour over SSH instead. */
  fallbackToSsh: z.boolean().default(true),
  /** Force SSH mode even when an API key is present. */
  forceSsh: z.boolean().default(false),
});

export const serverProfileSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1, 'required'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, 'required'),
  /** Path to a private key. */
  sshKey: z.string().min(1).optional(),
  /** Password auth is supported but discouraged; prefer sshKey. */
  password: z.string().optional(),
  passphrase: z.string().optional(),
  /** Use an ssh-agent identity instead of a key file. */
  agent: z.boolean().default(false),
  /** Strict host key checking; unknown hosts are rejected by default. */
  strictHostKeyChecking: z.boolean().default(true),
  /** Explicit known_hosts file path. */
  knownHosts: z.string().min(1).optional(),
  /** aaPanel site root base, usually /www/wwwroot. */
  siteRoot: remotePath.default('/www/wwwroot'),
  aapanel: aapanelConfigSchema.default({}),
  /** Extra SSH options string. */
  sshOptions: z.string().optional(),
  notes: z.string().optional(),
});

export const globalConfigSchema = z.object({
  version: z.literal(1).default(1),
  defaultServer: z.string().optional(),
  servers: z.record(z.string(), serverProfileSchema).default({}),
});

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ServerProfile = z.infer<typeof serverProfileSchema>;
export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type AaPanelConfig = z.infer<typeof aapanelConfigSchema>;
export type HealthCheckConfig = z.infer<typeof healthCheckConfigSchema>;
export type QueueConfig = z.infer<typeof queueConfigSchema>;
export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type PermissionsConfig = z.infer<typeof permissionsConfigSchema>;
export type SeedersConfig = z.infer<typeof seedersConfigSchema>;
export type EnvConfig = z.infer<typeof envConfigSchema>;
export type SiteConfig = z.infer<typeof siteConfigSchema>;
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export type LegacyConfig = z.infer<typeof legacyConfigSchema>;
export type BuildConfig = z.infer<typeof buildConfigSchema>;
export type PhpConfig = z.infer<typeof phpConfigSchema>;
export type SslConfig = z.infer<typeof sslConfigSchema>;
export type PackagingConfig = z.infer<typeof packagingConfigSchema>;

/** Guard used by the loader before trusting a user-supplied root. */
export function assertRootUsable(root: string): string {
  if (root.includes(' ')) {
    throw new SafetyError('The site root may not contain spaces.');
  }
  return root;
}