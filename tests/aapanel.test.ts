import { describe, it, expect, beforeEach } from 'vitest';
import {
  AaPanelAdapter,
  ensureWebsite,
  ensureDatabase,
  ensureSsl,
} from '../src/providers/aapanel/adapter.js';
import { AaPanelClient } from '../src/providers/aapanel/client.js';
import { MysqlProvider } from '../src/providers/mysql/provider.js';
import { SupervisorManager } from '../src/providers/supervisor/manager.js';
import { CronManager } from '../src/providers/cron/manager.js';
import { serverProfileSchema } from '../src/core/config/schema.js';
import { PanelError } from '../src/core/errors/errors.js';
import { FakeExecutor } from './helpers.js';
import { planWorkers } from '../src/laravel/workers.js';
import { buildLayout } from '../src/core/release/layout.js';
import { q } from '../src/utils/shell.js';

const profile = serverProfileSchema.parse({
  name: 'production',
  host: '1.2.3.4',
  username: 'root',
  siteRoot: '/www/wwwroot',
  aapanel: { enabled: true, url: 'https://1.2.3.4:7800', apiKey: 'test-key' },
});

function adapterWith(executor: FakeExecutor, overrides: Record<string, unknown> = {}) {
  return new AaPanelAdapter({
    profile,
    config: profile.aapanel,
    executor,
    clientFactory: () => null, // force SSH mode unless a test overrides this
    ...overrides,
  } as never);
}

describe('aaPanel adapter', () => {
  let executor: FakeExecutor;

  beforeEach(() => {
    executor = new FakeExecutor();
  });

  it('reports the website as existing when the directory is present', async () => {
    executor.on(`test -d ${q('/www/wwwroot/example.com')}`, { exitCode: 0 });
    const adapter = adapterWith(executor);
    expect(await adapter.websiteExists('example.com')).toBe(true);
  });

  it('reports the website as missing when the directory is absent', async () => {
    executor.on('test -d', { exitCode: 1 });
    const adapter = adapterWith(executor);
    expect(await adapter.websiteExists('example.com')).toBe(false);
  });

  it('refuses to create a duplicate website', async () => {
    executor.on('test -d', { exitCode: 0 }); // it already exists
    const adapter = adapterWith(executor);
    await expect(adapter.createWebsite({ domain: 'example.com', root: '/www/wwwroot/example.com' })).rejects.toThrow(
      PanelError,
    );
  });

  it('refuses to provision when aaPanel is disabled', async () => {
    executor.on('test -d', { exitCode: 1 });
    const adapter = adapterWith(executor, { config: { ...profile.aapanel, enabled: false } });
    await expect(adapter.createWebsite({ domain: 'example.com', root: '/www/wwwroot/example.com' })).rejects.toThrow(
      /provisioning is disabled/,
    );
  });

  it('validates the hostname before touching the panel', async () => {
    const adapter = adapterWith(executor);
    await expect(adapter.websiteExists('bad host; rm -rf /')).rejects.toThrow(/not a valid hostname/);
  });

  it('validates the remote path', async () => {
    const adapter = adapterWith(executor);
    await expect(
      adapter.createWebsite({ domain: 'example.com', root: '/www/../etc' }),
    ).rejects.toThrow(/traversal/);
  });
});

describe('ensure* idempotency', () => {
  it('reuses an existing website instead of creating a second one', async () => {
    const executor = new FakeExecutor();
    const existing = {
      name: 'example.com',
      domain: 'example.com',
      port: 80,
      root: '/www/wwwroot/example.com',
      status: 'running' as const,
    };
    const adapter = {
      getWebsite: async () => existing,
      createWebsite: async () => {
        throw new Error('createWebsite must not be called when the site exists');
      },
    };
    const result = await ensureWebsite(adapter as never, {
      domain: 'example.com',
      root: '/www/wwwroot/example.com',
    });
    expect(result.created).toBe(false);
    expect(result.reused).toBe(true);
    expect(executor.commands).toHaveLength(0);
  });

  it('creates the website only when it is missing', async () => {
    let created = false;
    const adapter = {
      getWebsite: async () => null,
      createWebsite: async () => {
        created = true;
        return { name: 'example.com', domain: 'example.com', port: 80, root: '/r', status: 'running' as const };
      },
    };
    const result = await ensureWebsite(adapter as never, { domain: 'example.com', root: '/r' });
    expect(result.created).toBe(true);
    expect(created).toBe(true);
  });

  it('reuses an existing database', async () => {
    const adapter = {
      getDatabase: async () => ({ name: 'db', username: 'db', host: 'localhost', port: 3306, accept: true }),
      createDatabase: async () => {
        throw new Error('must not create a duplicate database');
      },
    };
    const result = await ensureDatabase(adapter as never, { name: 'db', username: 'db', password: 'x' });
    expect(result.reused).toBe(true);
  });

  it('reuses an existing SSL certificate unless forced', async () => {
    let enabled = false;
    const adapter = {
      getSslStatus: async () => ({ enabled: true, provider: 'letsencrypt' as const, domains: [] }),
      enableSsl: async () => {
        enabled = true;
        return { enabled: true, provider: 'letsencrypt' as const, domains: [] };
      },
    };
    const result = await ensureSsl(adapter as never, { domain: 'example.com' });
    expect(result.reused).toBe(true);
    expect(enabled).toBe(false);
  });

  it('re-issues SSL when forced', async () => {
    let enabled = false;
    const adapter = {
      getSslStatus: async () => ({ enabled: true, provider: 'letsencrypt' as const, domains: [] }),
      enableSsl: async () => {
        enabled = true;
        return { enabled: true, provider: 'letsencrypt' as const, domains: [] };
      },
    };
    await ensureSsl(adapter as never, { domain: 'example.com', force: true });
    expect(enabled).toBe(true);
  });
});

describe('aaPanel HTTP client', () => {
  it('sends the API key in the body, never in the URL', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ status: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new AaPanelClient({
      baseUrl: 'https://1.2.3.4:7800',
      apiKey: 'super-secret-key',
      timeoutMs: 5000,
      insecureTLS: false,
      fetchImpl,
    });

    await client.request('GetSiteList', { name: 'example.com' });
    expect(calls[0]?.url).toContain('action=GetSiteList');
    expect(calls[0]?.url).not.toContain('super-secret-key');
    expect(calls[0]?.body).toContain('key=super-secret-key');
  });

  it('throws an actionable error on a non-JSON response', async () => {
    const fetchImpl = (async () =>
      new Response('<html>login page</html>', { status: 200 })) as unknown as typeof fetch;
    const client = new AaPanelClient({
      baseUrl: 'https://1.2.3.4:7800',
      apiKey: 'k',
      timeoutMs: 5000,
      insecureTLS: false,
      fetchImpl,
    });
    await expect(client.request('GetSiteList')).rejects.toThrow(/non-JSON/);
  });

  it('surfaces the panel error message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: false, msg: 'API key error' }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new AaPanelClient({
      baseUrl: 'https://1.2.3.4:7800',
      apiKey: 'k',
      timeoutMs: 5000,
      insecureTLS: false,
      fetchImpl,
    });
    await expect(client.request('AddSite')).rejects.toThrow(/API key error/);
  });
});

describe('mysql provider credential handling', () => {
  it('never places the password on the command line', async () => {
    const executor = new FakeExecutor().on('mysql', { stdout: '8.0.36\n' });
    const provider = new MysqlProvider({ executor });

    await provider.checkConnection({ username: 'app', password: 'sup3rs3cret', host: '127.0.0.1' });

    // The password travels in a heredoc, not in argv.
    expect(executor.saw('sup3rs3cret')).toBe(true);
    for (const command of executor.commands) {
      expect(command).not.toContain('--password=');
      expect(command).not.toContain('-psup3rs3cret');
    }
    expect(executor.saw('umask 077')).toBe(true);
    expect(executor.saw('mktemp /tmp/laravel-deploy-mysql-')).toBe(true);
    // The temp file is removed on exit.
    expect(executor.saw('trap')).toBe(true);
  });

  it('reports a failed connection without throwing when asked', async () => {
    const executor = new FakeExecutor().on('mysql', { exitCode: 1, stderr: 'Access denied for user' });
    const provider = new MysqlProvider({ executor });
    const check = await provider.checkConnection({ username: 'app', password: 'bad' });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('Access denied');
  });

  it('escapes single quotes in SQL string literals', async () => {
    const executor = new FakeExecutor().on('mysql', { stdout: '' });
    const provider = new MysqlProvider({ executor });
    // A database name with a quote must not be able to break out of the literal.
    await expect(provider.databaseExists("evil'; DROP DATABASE x; --")).rejects.toThrow(/Invalid database name/);
  });

  it('rejects invalid database identifiers', async () => {
    const provider = new MysqlProvider({ executor: new FakeExecutor() });
    await expect(provider.dropDatabase('bad;name')).rejects.toThrow(/Invalid/);
  });
});

describe('supervisor manager', () => {
  const queueConfig = {
    enabled: true,
    driver: 'database',
    workers: 2,
    connection: 'database',
    options: ['--tries=3'],
    processName: undefined,
    restartTimeoutSeconds: 15,
  };

  it('derives deterministic, unique program names', () => {
    const plans = planWorkers('client-site', queueConfig);
    expect(plans.map((p) => p.programName)).toEqual([
      'laravel-client-site-worker',
      'laravel-client-site-worker-1',
    ]);
    // Deterministic across runs.
    expect(planWorkers('client-site', queueConfig)[0]?.programName).toBe(plans[0]?.programName);
  });

  it('writes a program file tagged as ours', () => {
    const manager = new SupervisorManager({ executor: new FakeExecutor() });
    const contents = manager.renderProgram({
      plan: planWorkers('client-site', queueConfig)[0]!,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    expect(contents).toContain('# managed-by: laravel-deploy');
    expect(contents).toContain('[program:laravel-client-site-worker]');
    // `directory` must point at current/ so workers follow the symlink.
    expect(contents).toContain('directory=/www/wwwroot/example.com/current');
    expect(contents).toContain('--queue=database');
    // Never world-writable or root-owned-forever.
    expect(contents).not.toContain('777');
  });

  it('does not restart an unchanged program', async () => {
    const plan = planWorkers('client-site', queueConfig)[0]!;
    const contents = new SupervisorManager({ executor: new FakeExecutor() }).renderProgram({
      plan,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });

    // The file exists and already contains exactly what we would write.
    const executor = new FakeExecutor()
      .on('test -f', { exitCode: 0 })
      .on('cat', { stdout: contents });

    const result = await new SupervisorManager({ executor }).install([plan], {
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });

    expect(result.unchanged).toEqual([plan.programName]);
    expect(result.updated).toHaveLength(0);
    expect(result.restart).toBe(false);
    expect(executor.saw('supervisorctl restart')).toBe(false);
  });

  it('creates a missing program and restarts only it', async () => {
    const executor = new FakeExecutor().on('test -f', { exitCode: 1 });
    const manager = new SupervisorManager({ executor });
    const plan = planWorkers('client-site', queueConfig)[0]!;

    const result = await manager.install([plan], {
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });

    expect(result.written).toEqual([plan.programName]);
    // Restart names exactly one program — never a wildcard.
    expect(executor.saw('supervisorctl restart laravel-client-site-worker')).toBe(true);
    expect(executor.saw('supervisorctl restart all')).toBe(false);
    expect(executor.saw('supervisorctl restart *')).toBe(false);
  });

  it('refuses to remove a program it does not manage', async () => {
    const executor = new FakeExecutor().on('cat', {
      stdout: '[program:someone-elses-worker]\ncommand=/usr/bin/php artisan queue:work\n',
    });
    const manager = new SupervisorManager({ executor });
    await expect(manager.remove(['someone-elses-worker'])).rejects.toThrow(/not managed by laravel-deploy/);
    expect(executor.saw('rm -f')).toBe(false);
  });
});

describe('cron manager', () => {
  const schedulerConfig = {
    enabled: true,
    schedule: '* * * * *',
    comment: 'laravel-deploy',
    runAs: undefined,
  };

  it('builds an entry that points at current/', () => {
    const cron = new CronManager(new FakeExecutor());
    const entry = cron.buildEntry({
      config: schedulerConfig,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    expect(entry).toContain('# laravel-deploy');
    expect(entry).toContain("cd '/www/wwwroot/example.com/current'");
    expect(entry).toContain('php artisan schedule:run');
  });

  it('does not duplicate an entry that already exists', async () => {
    const cron = new CronManager(new FakeExecutor());
    const entry = cron.buildEntry({
      config: schedulerConfig,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    const executor = new FakeExecutor().on('crontab -l', { stdout: entry });

    const manager = new CronManager(executor);
    const result = await manager.install({
      config: schedulerConfig,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    expect(result.reused).toBe(true);
    expect(executor.saw('cat <<')).toBe(false);
  });

  it('replaces only its own entry, leaving other crontabs alone', async () => {
    const executor = new FakeExecutor().on('crontab -l', {
      stdout: '@reboot /usr/local/bin/backup.sh\n# laravel-deploy * * * * * cd \'/old/path\' && php artisan schedule:run',
    });
    const manager = new CronManager(executor);
    await manager.install({
      config: schedulerConfig,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    // The unrelated entry is preserved in the rewritten crontab.
    expect(executor.saw('@reboot /usr/local/bin/backup.sh')).toBe(true);
  });

  it('removes only its own entry', async () => {
    const executor = new FakeExecutor().on('crontab -l', {
      stdout: '@daily /usr/bin/thing\n# laravel-deploy * * * * * cd /x && php artisan schedule:run',
    });
    const manager = new CronManager(executor);
    const removed = await manager.remove(schedulerConfig);
    expect(removed).toBe(true);
    expect(executor.saw('@daily /usr/bin/thing')).toBe(true);
    expect(executor.saw('# laravel-deploy')).toBe(false);
  });

  it('reports a stale entry whose target has vanished', async () => {
    const executor = new FakeExecutor()
      .on('crontab -l', {
        stdout: "# laravel-deploy * * * * * cd '/www/wwwroot/example.com/current' && php artisan schedule:run",
      })
      .on('test -d', { exitCode: 1 });

    const manager = new CronManager(executor);
    const status = await manager.status({
      config: schedulerConfig,
      siteRoot: '/www/wwwroot/example.com',
      phpBinary: 'php',
    });
    expect(status.installed).toBe(true);
    expect(status.staleTarget).toBe(true);
  });
});

describe('layout-aware release paths', () => {
  it('keeps uploads and backups outside individual releases', () => {
    const layout = buildLayout({ root: '/www/wwwroot/example.com', strategy: 'public' });
    expect(layout.sharedStorageDir.startsWith(layout.releasesDir)).toBe(false);
    expect(layout.backupsDir.startsWith(layout.releasesDir)).toBe(false);
    expect(layout.envPath).toBe(`${layout.sharedDir}/.env`);
  });
});