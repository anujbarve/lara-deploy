/**
 * MySQL / MariaDB provider.
 *
 * Credentials never appear on a command line. They reach the server through a
 * temporary option file written over stdin with 0600 permissions, which is the
 * mechanism mysql(1) supports for exactly this reason (SPEC §9, §58).
 */

import { q, assertIdentifier } from '../../utils/shell.js';
import { RemoteCommandError, HealthCheckError } from '../../core/errors/errors.js';
import { randomHexish } from '../../utils/ids.js';
import type { RemoteExecutor } from '../exec/types.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

export interface MysqlProviderOptions {
  executor: RemoteExecutor;
  logger?: Logger;
  /** Client binary; mysql/mariadb. */
  client?: string;
  /** Dump binary; mysqldump/mariadb-dump. */
  dump?: string;
  /** Root credentials, when the SSH user can connect as root. */
  root?: { username?: string; password?: string; socket?: string };
}

export interface CreateDatabaseInput {
  name: string;
  username: string;
  password: string;
  host?: string;
}

export interface BackupResult {
  path: string;
  bytes: number;
  humanSize: string;
  durationMs: number;
}

export interface ConnectionCheck {
  ok: boolean;
  serverVersion: string | null;
  detail: string;
}

export class MysqlProvider {
  private readonly logger: Logger;

  constructor(private readonly options: MysqlProviderOptions) {
    this.logger = options.logger ?? nullLogger();
  }

  private get client(): string {
    return this.options.client ?? 'mysql';
  }

  private get dump(): string {
    return this.options.dump ?? 'mysqldump';
  }

  /** Build a temporary defaults-file script. Credentials stay in stdin. */
  private credentialsScript(credentials: {
    username: string;
    password: string;
    host?: string;
    port?: number;
    socket?: string;
  }, body: string): string {
    const tag = `MYCNF${randomHexish(10).toUpperCase()}`;
    const cnf = [
      '[client]',
      `user=${credentials.username}`,
      `password=${credentials.password}`,
      credentials.socket ? `socket=${credentials.socket}` : `host=${credentials.host ?? 'localhost'}`,
      credentials.socket ? '' : `port=${credentials.port ?? 3306}`,
      'protocol=tcp',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n');

    return [
      'set -Eeuo pipefail',
      'umask 077',
      `tmp=$(mktemp /tmp/laravel-deploy-mysql-XXXXXX.cnf)`,
      `trap 'rm -f "$tmp"' EXIT`,
      `cat > "$tmp" <<'${tag}'`,
      cnf,
      `${tag}`,
      // @MYCNF expands to the quoted temp path; the caller must not quote it.
      body
        .replaceAll('@@MYCNF@@', '"$tmp"')
        .replaceAll('@@CLIENT@@', this.client)
        .replaceAll('@@DUMP@@', this.dump),
    ].join('\n');
  }

  /** Run SQL as the application user (read-only queries). */
  async query(
    sql: string,
    credentials: { username: string; password: string; host?: string; port?: number; socket?: string },
    options: { timeoutMs?: number; allowFailure?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const script = this.credentialsScript(
      credentials,
      `@@CLIENT@@ --defaults-file=@@MYCNF@@ --batch --skip-column-names -e ${q(sql)}`,
    );
    const result = await this.options.executor.exec(script, {
      label: 'mysql query',
      timeoutMs: options.timeoutMs ?? 60_000,
      allowFailure: true,
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new RemoteCommandError('MySQL query failed.', result.exitCode, {
        command: `mysql -e <redacted query>`,
        details: { stderr: result.stderr.slice(-2000) },
        remediation: ['Verify the database credentials stored in the server profile.'],
      });
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  /** Safe liveness probe used by health checks and doctor. */
  async checkConnection(
    credentials: { username: string; password: string; host?: string; port?: number; socket?: string },
  ): Promise<ConnectionCheck> {
    const result = await this.query('SELECT VERSION();', credentials, { allowFailure: true });
    if (result.exitCode === 0) {
      return {
        ok: true,
        serverVersion: result.stdout.trim() || null,
        detail: result.stdout.trim() || 'connected',
      };
    }
    return {
      ok: false,
      serverVersion: null,
      detail: result.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'connection failed',
    };
  }

  async databaseExists(name: string): Promise<boolean> {
    assertIdentifier(name, 'database name');
    const sql = `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ${sqlString(name)};`;
    const credentials = this.rootCredentials();
    const result = await this.query(sql, credentials, { allowFailure: true });
    return result.exitCode === 0 && result.stdout.includes(name);
  }

  /**
   * Create the database and its user, then grant the privileges Laravel needs.
   * Idempotent: existing objects are reused, never duplicated.
   */
  async createDatabaseAndUser(input: CreateDatabaseInput): Promise<{ created: boolean }> {
    assertIdentifier(input.name, 'database name');
    assertIdentifier(input.username, 'database username');
    const exists = await this.databaseExists(input.name);
    if (exists) return { created: false };

    const host = input.host ?? 'localhost';
    const statements = [
      `CREATE DATABASE IF NOT EXISTS \`${input.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS ${quoteUser(input.username)}@${sqlString(host)} IDENTIFIED BY ${sqlString(input.password)};`,
      `ALTER USER ${quoteUser(input.username)}@${sqlString(host)} IDENTIFIED BY ${sqlString(input.password)};`,
      `GRANT ALL PRIVILEGES ON \`${input.name}\`.* TO ${quoteUser(input.username)}@${sqlString(host)};`,
      'FLUSH PRIVILEGES;',
    ].join('\n');

    const script = this.credentialsScript(
      this.rootCredentials(),
      `@@CLIENT@@ --defaults-file=@@MYCNF@@ <<'SQL'\n${statements}\nSQL`,
    );
    const result = await this.options.executor.exec(script, {
      label: 'create database',
      timeoutMs: 60_000,
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      throw new RemoteCommandError(`Unable to create database "${input.name}".`, result.exitCode, {
        command: 'mysql <create database>',
        details: { stderr: result.stderr.slice(-2000) },
        remediation: [
          'The SSH user may lack CREATE privileges. Run as a MySQL root, or create the database in aaPanel.',
        ],
      });
    }
    return { created: true };
  }

  /** Drop a database. Never called automatically — explicit intent only. */
  async dropDatabase(name: string): Promise<void> {
    assertIdentifier(name, 'database name');
    const script = this.credentialsScript(
      this.rootCredentials(),
      `@@CLIENT@@ --defaults-file=@@MYCNF@@ -e ${q(`DROP DATABASE IF EXISTS \`${name}\`;`)}`,
    );
    const result = await this.options.executor.exec(script, { label: 'drop database' });
    if (result.exitCode !== 0) {
      throw new RemoteCommandError(`Unable to drop database "${name}".`, result.exitCode, {
        details: { stderr: result.stderr.slice(-2000) },
      });
    }
  }

  /**
   * Dump a database to a gzipped file under `backupDir`.
   * Returns the remote path; the caller reports and prunes it.
   */
  async backup(input: {
    database: string;
    backupDir: string;
    fileName: string;
    credentials: { username: string; password: string; host?: string; port?: number; socket?: string };
    timeoutMs?: number;
  }): Promise<BackupResult> {
    assertIdentifier(input.database, 'database name');
    if (input.fileName.includes('/') || input.fileName.includes('..')) {
      throw new Error('Invalid backup file name.');
    }
    const started = Date.now();
    const target = `${input.backupDir.replace(/\/$/, '')}/${input.fileName}`;

    const script = this.credentialsScript(
      input.credentials,
      [
        'set -Eeuo pipefail',
        `mkdir -p ${q(input.backupDir)}`,
        `@@DUMP@@ --defaults-file=@@MYCNF@@ --single-transaction --quick --routines --triggers --events ${q(input.database)} | gzip -9 > ${q(target)}`,
        `test -s ${q(target)}`,
      ].join('\n'),
    );

    const result = await this.options.executor.exec(script, {
      label: 'mysqldump backup',
      timeoutMs: input.timeoutMs ?? 600_000,
    });

    const size = await this.fileSize(target);
    return {
      path: target,
      bytes: size,
      humanSize: formatBytesSafe(size),
      durationMs: Date.now() - started,
    };
  }

  /** Restore a backup. Explicit, never automatic (SPEC §20). */
  async restore(input: {
    backupFile: string;
    database: string;
    credentials: { username: string; password: string; host?: string; port?: number; socket?: string };
    timeoutMs?: number;
  }): Promise<void> {
    assertIdentifier(input.database, 'database name');
    const script = this.credentialsScript(
      input.credentials,
      [
        'set -Eeuo pipefail',
        `test -f ${q(input.backupFile)}`,
        `gunzip -c ${q(input.backupFile)} | @@CLIENT@@ --defaults-file=@@MYCNF@@ ${q(input.database)}`,
      ].join('\n'),
    );
    const result = await this.options.executor.exec(script, {
      label: 'restore backup',
      timeoutMs: input.timeoutMs ?? 900_000,
    });
    if (result.exitCode !== 0) {
      throw new RemoteCommandError('Database restore failed.', result.exitCode, {
        details: { stderr: result.stderr.slice(-2000) },
        remediation: ['Inspect the dump with `zcat <file> | head` before retrying.'],
      });
    }
  }

  /** Count rows in the migrations table. Safe read-only probe. */
  async migrationCount(credentials: { username: string; password: string; host?: string; port?: number }): Promise<number | null> {
    const sql =
      'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ' +
      sqlString('migrations') +
      ';';
    const result = await this.query(sql, credentials, { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) ? count : null;
  }

  private async fileSize(path: string): Promise<number> {
    const result = await this.options.executor.exec(`stat -c %s ${q(path)} 2>/dev/null || echo 0`, {
      allowFailure: true,
    });
    const size = Number(result.stdout.trim());
    return Number.isFinite(size) ? size : 0;
  }

  private rootCredentials(): {
    username: string;
    password: string;
    host?: string;
    port?: number;
    socket?: string;
  } {
    const root = this.options.root;
    if (root) {
      return {
        username: root.username ?? 'root',
        password: root.password ?? '',
        socket: root.socket,
        host: root.socket ? undefined : 'localhost',
      };
    }
    // aaPanel's default: root authenticates over the socket with no password.
    return { username: 'root', password: '', socket: '/tmp/mysql.sock' };
  }
}

/** Quote a MySQL identifier safely. */
function quoteUser(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** Escape a SQL string literal. */
function sqlString(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case "'":
        out += "''";
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\0':
        out += '\\0';
        break;
      default:
        out += ch;
    }
  }
  return `'${out}'`;
}

function formatBytesSafe(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Assert the application can reach the database with the given credentials. */
export async function assertDatabaseUsable(
  provider: MysqlProvider,
  credentials: { username: string; password: string; host?: string; port?: number },
): Promise<void> {
  const check = await provider.checkConnection(credentials);
  if (!check.ok) {
    throw new HealthCheckError('Cannot connect to the database with the configured credentials.', {
      details: { detail: check.detail },
      liveAffected: false,
      remediation: [
        'Check DB_USERNAME / DB_PASSWORD in the server .env.',
        'Confirm the user was granted privileges on the database.',
      ],
    });
  }
}