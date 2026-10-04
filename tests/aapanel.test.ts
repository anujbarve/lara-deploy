import { describe, it, expect, beforeEach } from 'vitest';
import {
  AaPanelAdapter,
  ensureWebsite,
  ensureDatabase,
  ensureSsl,
} from '../src/providers/aapanel/adapter.js';
import { AaPanelClient, md5hex, getDataParams } from '../src/providers/aapanel/client.js';
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
  it('authenticates with the timestamped token aaPanel expects', async () => {
    // aaPanel does not accept `key=<secret>`. It wants
    // request_token = MD5(request_time + MD5(api_secret_key)); sending the bare
    // key is rejected, which is why the API path never worked.
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

    const params = new URLSearchParams(calls[0]?.body ?? '');
    const time = params.get('request_time') ?? '';
    expect(time).toMatch(/^\d{13}$/);
    expect(params.get('request_token')).toBe(
      md5hex(`${time}${md5hex('super-secret-key')}`),
    );
    expect(params.get('key')).toBeNull();
  });

  it('never puts the secret in the URL or the raw body', async () => {
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
    // The key only ever appears hashed, so a proxy log cannot recover it.
    expect(calls[0]?.body).not.toContain('super-secret-key');
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

describe('aaPanel API routing', () => {
  function recorder(responses: Record<string, unknown>) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      const action = new URL(url).searchParams.get('action') ?? '';
      return new Response(JSON.stringify(responses[action] ?? { status: 0, message: {} }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function client(fetchImpl: typeof fetch): AaPanelClient {
    return new AaPanelClient({
      baseUrl: 'https://1.2.3.4:7800',
      apiKey: 'k',
      timeoutMs: 5000,
      insecureTLS: false,
      fetchImpl,
    });
  }

  it('sends AddDatabase to the database route, not /v2/data', async () => {
    // Every /v2 route has its own action allowlist, and an action posted to the
    // wrong one is answered with "Specific parameters are invalid!" — the exact
    // message an unknown action produces, so the route is easy to get wrong.
    const { calls, fetchImpl } = recorder({ AddDatabase: { status: 0, message: { id: 7 } } });
    await client(fetchImpl).requestOn('database', 'AddDatabase', { name: 'app' });

    expect(calls[0]?.url).toContain('/v2/database?action=AddDatabase');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/v2/database');
  });

  it('sends AddSite to the site route with webname as a JSON string', async () => {
    const { calls, fetchImpl } = recorder({ AddSite: { status: 0, message: { siteId: 12 } } });
    await client(fetchImpl).requestOn('site', 'AddSite', {
      webname: JSON.stringify({ domain: 'example.com', domainlist: [] }),
    });

    expect(calls[0]?.url).toContain('/v2/site?action=AddSite');
    const params = new URLSearchParams(calls[0]?.body ?? '');
    // aaPanel json.loads() this value; a bare domain is rejected as malformed.
    expect(JSON.parse(params.get('webname') ?? '{}')).toEqual({
      domain: 'example.com',
      domainlist: [],
    });
  });

  it('reports the reason from message.result, not "unknown error"', async () => {
    // Validation failures come back as {status: -1, message: {result: "..."}}
    // with no `msg` field, so reading only `msg` hides the actual cause.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ status: -1, message: { result: 'Database name cannot contain special characters' } }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).requestOn('database', 'AddDatabase', {}),
    ).rejects.toThrow(/Database name cannot contain special characters/);
  });

  it('always sends the full getData parameter set', async () => {
    // getData validates strictly and rejects the call when any parameter is
    // missing — including when its value is empty.
    const { calls, fetchImpl } = recorder({ getData: { status: 0, message: { data: [] } } });
    await client(fetchImpl).requestOn('data', 'getData', getDataParams('databases'));

    const params = new URLSearchParams(calls[0]?.body ?? '');
    for (const key of ['p', 'limit', 'table', 'search', 'order', 'type']) {
      expect(params.has(key), `getData requires "${key}"`).toBe(true);
    }
    expect(params.get('table')).toBe('databases');
  });
});

describe('aaPanel adapter API calls', () => {
  const profile = {
    name: 'p',
    host: '1.2.3.4',
    port: 22,
    username: 'root',
    siteRoot: '/www/wwwroot',
  } as never;
  const config = {
    enabled: true,
    url: 'https://1.2.3.4:7800',
    forceSsh: false,
    fallbackToSsh: false,
    timeoutMs: 5000,
    insecureTLS: false,
  } as never;

  function adapterWith(calls: Array<{ url: string; body: string }>, messageFor: (action: string) => unknown) {
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      const action = new URL(url).searchParams.get('action') ?? '';
      return new Response(JSON.stringify(messageFor(action)), { status: 200 });
    }) as unknown as typeof fetch;
    return new AaPanelAdapter({
      profile,
      config,
      executor: new FakeExecutor(),
      clientFactory: () =>
        new AaPanelClient({
          baseUrl: 'https://1.2.3.4:7800',
          apiKey: 'k',
          timeoutMs: 5000,
          insecureTLS: false,
          fetchImpl,
        }),
    });
  }

  it('creates a database with the parameters the panel schema requires', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'AddDatabase'
        ? { status: 0, message: { id: 1 } }
        : { status: 0, message: { data: [] } },
    );

    await adapter.createDatabase({ name: 'app', username: 'app', password: 'p' });

    const add = calls.find((c) => c.url.includes('AddDatabase'));
    expect(add?.url).toContain('/v2/database');
    const params = new URLSearchParams(add?.body ?? '');
    // db_user/address/codeing/sid/active/dtype are all required by the panel's
    // validator; a missing one is answered with "<field> is required".
    for (const key of ['name', 'db_user', 'password', 'codeing', 'address', 'sid', 'active', 'dtype', 'ps']) {
      expect(params.has(key), `AddDatabase requires "${key}"`).toBe(true);
    }
    expect(params.get('db_user')).toBe('app');
    expect(params.get('address')).toBe('localhost');
  });

  it('reads the database list from getData so panel-registered databases are found', async () => {
    // A database created with raw SQL over SSH exists in MySQL but is absent
    // from the panel's own table, so it is invisible in aaPanel. Reading the
    // panel's list is what makes ensureDatabase idempotent for managed ones.
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'getData'
        ? {
            status: 0,
            message: {
              data: [{ id: 3, name: 'app', username: 'app', accept: 'localhost' }],
            },
          }
        : { status: 0, message: {} },
    );

    expect(await adapter.databaseExists('app')).toBe(true);
    expect(await adapter.databaseExists('other')).toBe(false);

    const params = new URLSearchParams(calls[0]?.body ?? '');
    expect(calls[0]?.url).toContain('action=getData');
    expect(params.get('table')).toBe('databases');
  });

  it('sets the PHP version using "version", which is the parameter the panel reads', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'getData'
        ? { status: 0, message: { data: [{ id: 9, name: 'example.com', path: '/www/wwwroot/example.com' }] } }
        : { status: 0, message: { result: 'ok' } },
    );

    await adapter.setPhpVersion('example.com', '82');

    const call = calls.find((c) => c.url.includes('SetPHPVersion'));
    const params = new URLSearchParams(call?.body ?? '');
    expect(call?.url).toContain('/v2/site');
    expect(params.get('version')).toBe('82');
    expect(params.get('siteName')).toBe('example.com');
  });

  it('sets the document root as a path relative to the site root', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'getData'
        ? { status: 0, message: { data: [{ id: 9, name: 'example.com', path: '/www/wwwroot/example.com' }] } }
        : { status: 0, message: { result: 'ok' } },
    );

    await adapter.updateSiteConfig({
      domain: 'example.com',
      documentRoot: '/www/wwwroot/example.com/current/public',
    });

    const call = calls.find((c) => c.url.includes('SetSiteRunPath'));
    const params = new URLSearchParams(call?.body ?? '');
    // SetSiteRunPath concatenates runPath onto the site's own path, so an
    // absolute path here would produce a nonsense root like /www/wwwroot/x/www/...
    expect(params.get('runPath')).toBe('/current/public');
    expect(params.get('id')).toBe('9');
  });

  it('refuses a document root outside the site root', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'getData'
        ? { status: 0, message: { data: [{ id: 9, name: 'example.com', path: '/www/wwwroot/example.com' }] } }
        : { status: 0, message: { result: 'ok' } },
    );

    await expect(
      adapter.updateSiteConfig({ domain: 'example.com', documentRoot: '/somewhere/else' }),
    ).rejects.toThrow(/outside the site root/);
  });

  it('takes the domain from "name", not from the row\'s "domain" field', async () => {
    // In a getData site row, `domain` is the NUMBER of domains bound to the
    // site. Reading it as the hostname yields "domain: 1", and every hostname
    // comparison then fails — indistinguishable from "the site is missing".
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'getData'
        ? {
            status: 0,
            message: {
              data: [
                {
                  id: 25,
                  name: 'example.com',
                  path: '/www/wwwroot/example.com',
                  domain: 1,
                  php_version: '8.3',
                },
              ],
            },
          }
        : { status: 0, message: { status: false } },
    );

    const site = await adapter.getWebsite('example.com');

    expect(site).not.toBeNull();
    expect(site?.domain).toBe('example.com');
    expect(site?.root).toBe('/www/wwwroot/example.com');
    expect(site?.phpVersion).toBe('8.3');
  });

  it('searches server-side instead of reading a capped page of sites', async () => {
    // Reading the first N sites silently reports "not found" for any site
    // beyond the page. The panel's search is a substring match, so the exact
    // match is still done locally.
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, () => ({ status: 0, message: { data: [] } }));

    expect(await adapter.websiteExists('example.com')).toBe(false);

    const params = new URLSearchParams(calls[0]?.body ?? '');
    expect(params.get('table')).toBe('sites');
    expect(params.get('search')).toBe('example.com');
  });

  it('reports the served directory, not just the webroot', async () => {
    // aaPanel stores the serving directory separately from the site's path, as
    // a run path relative to it. Reporting the webroot as the document root
    // makes a correctly configured site look misconfigured.
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) => {
      if (action === 'getData') {
        return {
          status: 0,
          message: {
            data: [{ id: 9, name: 'example.com', path: '/www/wwwroot/example.com' }],
          },
        };
      }
      if (action === 'GetSiteRunPath') {
        return { status: 0, message: { runPath: '/current/public', dirs: [] } };
      }
      return { status: 0, message: { status: false } };
    });

    const config = await adapter.getSiteConfig('example.com');

    expect(config?.documentRoot).toBe('/www/wwwroot/example.com/current/public');
  });

  it('falls back to the webroot when the run path is the site root', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) => {
      if (action === 'getData') {
        return {
          status: 0,
          message: {
            data: [{ id: 9, name: 'example.com', path: '/www/wwwroot/example.com' }],
          },
        };
      }
      if (action === 'GetSiteRunPath') {
        return { status: 0, message: { runPath: '/', dirs: [] } };
      }
      return { status: 0, message: { status: false } };
    });

    expect((await adapter.getSiteConfig('example.com'))?.documentRoot).toBe(
      '/www/wwwroot/example.com',
    );
  });

  it('refuses to create a site over a webroot that still holds a deployment', async () => {
    // aaPanel deletes the site path on creation. A previous release's
    // releases/, current symlink, shared/.env and deploy history all live
    // there, so provisioning after an upload silently destroys them.
    const calls: Array<{ url: string; body: string }> = [];
    const executor = new FakeExecutor().on('test -e', {
      stdout: '/www/wwwroot/example.com/releases\n',
    });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ status: 0, message: { data: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new AaPanelAdapter({
      profile,
      config,
      executor,
      clientFactory: () =>
        new AaPanelClient({
          baseUrl: 'https://1.2.3.4:7800',
          apiKey: 'k',
          timeoutMs: 5000,
          insecureTLS: false,
          fetchImpl,
        }),
    });

    await expect(
      adapter.createWebsite({ domain: 'example.com', root: '/www/wwwroot/example.com' }),
    ).rejects.toThrow(/not empty/);
    // The destructive call must not have been made.
    expect(calls.some((c) => c.url.includes('AddSite'))).toBe(false);
  });

  it('creates the site when the webroot is empty or absent', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const executor = new FakeExecutor().on('test -e', { exitCode: 1, stdout: '' });
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      const action = new URL(url).searchParams.get('action') ?? '';
      if (action === 'AddSite') return new Response(JSON.stringify({ status: 0, message: { siteId: 5 } }), { status: 200 });
      return new Response(JSON.stringify({ status: 0, message: { data: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new AaPanelAdapter({
      profile,
      config,
      executor,
      clientFactory: () =>
        new AaPanelClient({
          baseUrl: 'https://1.2.3.4:7800',
          apiKey: 'k',
          timeoutMs: 5000,
          insecureTLS: false,
          fetchImpl,
        }),
    });

    await adapter.createWebsite({ domain: 'example.com', root: '/www/wwwroot/example.com' });
    expect(calls.some((c) => c.url.includes('AddSite'))).toBe(true);
  });

  it('reads SSL state from cert_data, which is where the panel puts it', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, (action) =>
      action === 'GetSSL'
        ? {
            status: 0,
            message: {
              status: true,
              cert_data: {
                notAfter: '2026-12-26',
                issuer_O: "Let's Encrypt",
                dns: ['example.com'],
              },
            },
          }
        : { status: 0, message: {} },
    );

    const ssl = await adapter.getSslStatus('example.com');

    expect(ssl.enabled).toBe(true);
    expect(ssl.provider).toBe('letsencrypt');
    // The panel has no top-level endtime field; the real expiry is nested.
    expect(ssl.expiry).toBe('2026-12-26');
    expect(ssl.domains).toEqual(['example.com']);
    expect(calls[0]?.url).toContain('/v2/site?action=GetSSL');
  });

  it('reports no SSL when the panel rejects the unknown site', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = adapterWith(calls, () => ({ status: -1, message: { result: 'not found' } }));

    expect(await adapter.getSslStatus('missing.example.com')).toEqual({
      enabled: false,
      provider: 'none',
      domains: [],
    });
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

  it('finds supervisorctl where aaPanel keeps it', async () => {
    // aaPanel does not put supervisorctl on an SSH user's PATH; it ships one
    // in its bundled Python. Calling the bare name fails with "command not
    // found" even though supervisor is installed and running.
    const executor = new FakeExecutor().on('for candidate in', {
      stdout: '/www/server/panel/pyenv/bin/supervisorctl\n',
    });
    const manager = new SupervisorManager({ executor });

    await manager.restart(['laravel-client-site-worker']);

    const restart = executor.commands.find((c) => c.includes(' restart '));
    expect(restart).toContain('/www/server/panel/pyenv/bin/supervisorctl');
  });

  it('prefers supervisorctl from PATH when it is there', async () => {
    const executor = new FakeExecutor().on('for candidate in', {
      stdout: '/usr/bin/supervisorctl\n',
    });
    await new SupervisorManager({ executor }).status();
    expect(executor.commands.find((c) => c.includes(' status'))).toContain('/usr/bin/supervisorctl');
  });

  it('looks for supervisorctl only once', async () => {
    const executor = new FakeExecutor().on('for candidate in', {
      stdout: '/usr/bin/supervisorctl\n',
    });
    const manager = new SupervisorManager({ executor });
    await manager.status();
    await manager.status();
    expect(executor.commands.filter((c) => c.includes('for candidate in'))).toHaveLength(1);
  });

  it('reports a restart that leaves the workers dead', async () => {
    // `supervisorctl restart` exits 0 as soon as it has asked the daemon to
    // restart. Waiting for RUNNING is what turns that into a real check — and
    // queue.restartTimeoutSeconds is the budget it gets.
    const executor = new FakeExecutor().on('supervisorctl status', {
      stdout: 'laravel-client-site-worker  FATAL  Exited too quickly  0:00:00',
    });
    const manager = new SupervisorManager({ executor });

    expect(await manager.restart(['laravel-client-site-worker'])).toBe(true);
    expect(
      await manager.restart(['laravel-client-site-worker'], { waitSeconds: 1 }),
    ).toBe(false);
    // It really looked, rather than trusting the restart's exit code.
    expect(executor.commands.filter((c) => c.includes('supervisorctl status')).length).toBeGreaterThan(1);
  });

  it('reports a restart once every worker is RUNNING', async () => {
    const executor = new FakeExecutor().on('supervisorctl status', {
      stdout: [
        'laravel-client-site-worker    RUNNING   pid 1234, uptime 0:00:01',
        'laravel-client-site-worker-1  RUNNING   pid 1235, uptime 0:00:01',
      ].join('\n'),
    });

    expect(
      await new SupervisorManager({ executor }).restart(
        ['laravel-client-site-worker', 'laravel-client-site-worker-1'],
        { waitSeconds: 15 },
      ),
    ).toBe(true);
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
    // Restart names exactly one program — never a wildcard. The name is
    // quoted so it cannot carry shell metacharacters into supervisorctl.
    expect(executor.saw(`supervisorctl restart ${q(plan.programName)}`)).toBe(true);
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