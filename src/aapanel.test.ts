import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AaPanel } from './aapanel.js';
import { setVerbose } from './ui.js';
import type { Config } from './config.js';

const API_KEY = 'secret-key';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const config = (url: string): Config => ({
  server: { host: '1.2.3.4', port: 22, username: 'root', sshKey: '~/.ssh/id' },
  aapanel: { url, apiKey: API_KEY },
  site: { domain: 'example.com', root: '/www/wwwroot/example.com' },
  database: { name: 'example_db', username: 'example_user', password: 's3cret-pass' },
  deployment: { runMigrations: true, runSeeders: false },
});

interface Hit {
  path: string;
  action: string;
  params: Record<string, string>;
  ua: string;
}

interface Options {
  /** Routes (with prefix) that answer 404, like an older panel without the /v2 routes. */
  missing?: string[];
  /** Answer every path with the panel's HTML shell, like the wrong virtual host. */
  htmlForEverything?: boolean;
  /** Return getData rows wrapped the way /v2/data does instead of /data. */
  wrapV2Rows?: boolean;
  /** Return GetPHPVersion as a bare array, the way current aaPanel panels do. */
  barePhpVersionArray?: boolean;
}

/**
 * A mock reproducing the response shapes captured from a live aaPanel panel:
 * nginx 403s anything without a Mozilla User-Agent, /v2/data wraps rows in
 * `message`, and GetPHPVersion answers with a bare array.
 */
async function withPanel(fn: (hits: Hit[], panel: AaPanel) => Promise<void>, options: Options = {}) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://panel');
      const ua = String(req.headers['user-agent'] ?? '');

      // nginx rejects non-browser clients before aaPanel ever sees them.
      if (!ua.includes('Mozilla')) {
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<html><head><title>403 Forbidden</title></head><body>nginx</body></html>');
      }

      if (options.htmlForEverything) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><html><head><title>{0}</title></head><body></body></html>');
      }

      const params: Record<string, string> = Object.fromEntries(url.searchParams);
      // aaPanel merges query args and form data; the token may arrive in either.
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString())) params[k] = v;

      if (params.request_token !== md5(params.request_time! + md5(API_KEY))) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: false, msg: 'Secret key verification failed' }));
      }

      const action = url.searchParams.get('action')!;
      hits.push({ path: url.pathname, action, params, ua });

      if (options.missing?.includes(url.pathname)) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html>404 Not Found</html>');
      }

      const json = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const sites = [{ id: 1, name: 'example.com', path: '/www/wwwroot/example.com' }];
      // Real rows carry the database password.
      const databases = [{ id: 2, name: 'example_db', username: 'example_user', password: 's3cret-pass' }];

      if (url.pathname.endsWith('/data') && action === 'getData') {
        const rows = params.table === 'sites' ? sites : databases;
        const body: Record<string, unknown> = { where: '', page: '', data: rows };
        // /v2/data wraps everything in { status, timestamp, message }.
        return json(url.pathname.startsWith('/v2/') && options.wrapV2Rows ? { status: 0, timestamp: 1, message: body } : body);
      }

      if (url.pathname.endsWith('/site') && action === 'GetPHPVersion') {
        const versions = [{ version: '00', name: 'Static' }, { version: '74' }, { version: '82' }, { version: '85' }];
        return json(options.barePhpVersionArray ? versions : { status: 0, message: versions });
      }

      if (url.pathname.endsWith('/site') && action === 'AddSite') {
        // aaPanel silently turns a missing/empty version into "00" = a Static site.
        if (!params.version || params.version === '00') {
          return json({ status: -1, message: { result: 'Requested PHP version does NOT exist!' } });
        }
        return json({ status: 0, message: { result: 'ok' } });
      }

      if (url.pathname.endsWith('/database') && action === 'AddDatabase') {
        return json({ status: true, msg: 'Setup successfully!' });
      }

      json({ status: false, msg: 'Specific parameters are invalid!' });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(hits, new AaPanel(config(url)));
  } finally {
    server.close();
  }
}

test('sends a browser User-Agent and authenticates', async () => {
  await withPanel(async (hits, panel) => {
    await panel.connect();
    assert.ok(hits.length > 0, 'the request reached aaPanel');
    assert.ok(hits.every((h) => h.ua.includes('Mozilla')), 'every request carries a browser UA');
  });
});

test('creates a site on the newest real PHP version', async () => {
  await withPanel(async (hits, panel) => {
    await panel.createSite('example.com', '/www/wwwroot/example.com');
    const add = hits.find((h) => h.action === 'AddSite')!;
    assert.equal(add.params.version, '85', 'must not send the "Static" version 00');
    assert.equal(JSON.parse(add.params.webname!).domain, 'example.com');
  });
});

test('reads GetPHPVersion whether it is a bare array or wrapped', async () => {
  for (const barePhpVersionArray of [true, false]) {
    await withPanel(
      async (hits, panel) => {
        await panel.createSite('example.com', '/www/wwwroot/example.com');
        const add = hits.find((h) => h.action === 'AddSite')!;
        assert.equal(add.params.version, '85');
      },
      { barePhpVersionArray },
    );
  }
});

test('reads getData rows from both /data and /v2/data envelopes', async () => {
  for (const wrapV2Rows of [true, false]) {
    await withPanel(
      async (_hits, panel) => {
        assert.equal((await panel.findSite('example.com'))?.path, '/www/wwwroot/example.com');
        assert.equal((await panel.findDatabase('example_db'))?.username, 'example_user');
      },
      { wrapV2Rows },
    );
  }
});

test('falls back to the unprefixed route when /v2 is missing', async () => {
  await withPanel(
    async (hits, panel) => {
      await panel.createSite('example.com', '/www/wwwroot/example.com');
      assert.ok(hits.some((h) => h.path === '/v2/site'), 'tried /v2 first');
      const addSite = hits.filter((h) => h.action === 'AddSite');
      assert.deepEqual(addSite.map((h) => h.path), ['/site'], 'reused the working route');
    },
    { missing: ['/v2/site'] },
  );
});

test('creates a database with a grant host that matches DB_HOST', async () => {
  await withPanel(async (hits, panel) => {
    await panel.createDatabase('example_db', 'example_user', 's3cret-pass');
    const add = hits.find((h) => h.action === 'AddDatabase')!;
    assert.equal(add.params.address, '127.0.0.1');
    assert.equal(add.params.dtype, 'MySQL');
    assert.equal(add.params.sid, '0');
    assert.equal(add.params.active, 'true');
  });
});

test('explains a panel address that serves a web page instead of the API', async () => {
  await withPanel(
    async (_hits, panel) => {
      await assert.rejects(() => panel.connect(), (e: Error) => {
        assert.match(e.message, /web page instead of API data/);
        assert.match(e.message + (e as any).details.join(' '), /bare IP/);
        return true;
      });
    },
    { htmlForEverything: true },
  );
});

test('reports an unusable panel instead of hanging', async () => {
  const panel = new AaPanel(config('http://127.0.0.1:1'));
  await assert.rejects(() => panel.connect());
});

test('verbose output never prints the database password or the request token', async () => {
  const logged: string[] = [];
  const original = console.log;
  setVerbose(true);
  console.log = (m: string) => logged.push(String(m));
  try {
    await withPanel(async (_hits, panel) => {
      await panel.createDatabase('example_db', 'example_user', 's3cret-pass');
      await panel.findDatabase('example_db');
    });
  } finally {
    console.log = original;
    setVerbose(false);
  }
  const out = logged.join('\n');
  assert.ok(!out.includes('s3cret-pass'), 'database password leaked');
  assert.ok(!/\b[0-9a-f]{32}\b/.test(out), 'request token leaked');
});