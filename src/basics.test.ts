import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artisanScript, installScript, mergeEnv, storageLinkScript } from './laravel.js';
import { isExcluded } from './archive.js';

const cfg = {
  server: { host: 'h', port: 22, username: 'root', sshKey: 'k' },
  aapanel: { url: 'https://p.example.com:7800', apiKey: 'k' },
  site: { domain: 'example.com', root: '/www/wwwroot/example.com' },
  database: { name: 'db', username: 'u', password: 'p' },
  deployment: { runMigrations: true, runSeeders: false },
};

test('mergeEnv preserves unrelated vars and APP_KEY, is idempotent', () => {
  const existing = 'APP_KEY=base64:abc\nMAIL_HOST=x\nDB_HOST=old\n';
  const u = { DB_HOST: '127.0.0.1', DB_PASSWORD: 'p"w d' };
  const once = mergeEnv(existing, u);
  assert.match(once, /APP_KEY=base64:abc/);
  assert.match(once, /MAIL_HOST=x/);
  assert.match(once, /DB_HOST=127.0.0.1/);
  assert.match(once, /DB_PASSWORD="p\\"w d"/);
  assert.equal(mergeEnv(once, u), once);
});

test('archive exclusions', () => {
  assert.ok(isExcluded('./node_modules/a'));
  assert.ok(isExcluded('./.env'));
  assert.ok(isExcluded('./.git/x'));
  assert.ok(!isExcluded('./.env.example'));
  assert.ok(!isExcluded('./vendor/autoload.php'));
  assert.ok(!isExcluded('./public/build/app.js'));
});

test('storage link script repairs itself instead of failing', () => {
  const script = storageLinkScript(cfg);
  // A real directory in the site root must no longer abort the deployment...
  assert.doesNotMatch(script, /is not a symlink/);
  assert.doesNotMatch(script, /exit 1/);
  // ...it gets moved aside, never deleted.
  assert.match(script, /mv "\$LINK" "\$BACKUP"/);
  assert.doesNotMatch(script, /rm -rf/);
  assert.match(script, /MOVED_ASIDE:/);
  // The link always ends up pointing at main/storage/app/public.
  assert.match(script, /ln -s "\$TARGET" "\$LINK"/);
});

test('stale Laravel caches are cleared so providers resolve', () => {
  const artisan = artisanScript(cfg, 'migrate --force');
  // The provider manifest survives every deploy unless it is removed explicitly;
  // a stale one makes Laravel report "Class ... not found" for a moved package.
  assert.match(artisan, /rm -f bootstrap\/cache\/services\.php bootstrap\/cache\/packages\.php/);
  // ...and it must be cleared *before* artisan runs.
  assert.ok(artisan.indexOf('rm -f bootstrap/cache/') < artisan.indexOf('artisan migrate'));
  // A deliberately cached config is left alone.
  assert.doesNotMatch(artisan, /rm -f bootstrap\/cache\/config\.php/);

  const install = installScript(cfg, '/tmp/a.tar.gz');
  assert.match(install, /rm -f bootstrap\/cache\/\*\.php/);
  assert.ok(install.indexOf('rm -f bootstrap/cache/') < install.indexOf('cp -a public/'));
});

test('remote scripts are LF-only so a CRLF checkout cannot break the shell', () => {
  for (const script of [artisanScript(cfg, 'migrate --force'), installScript(cfg, '/tmp/a.tar.gz'), storageLinkScript(cfg)]) {
    assert.doesNotMatch(script, /\r/, 'script must contain no CR characters');
  }
});

test('install clears files deleted locally, keeping .env and storage', () => {
  const install = installScript(cfg, '/tmp/a.tar.gz');
  // Without this a stale config/*.php keeps referencing a package that was
  // removed, and every artisan command dies before it can run.
  assert.match(install, /find \. -mindepth 1 -maxdepth 1 ! -name \.env ! -name storage -exec rm -rf \{\} \+/);
  assert.ok(install.indexOf('find .') < install.indexOf('tar -xzf'), 'prune before extract');
  // A missing archive must fail before anything is removed.
  assert.ok(install.indexOf('[ -f ') < install.indexOf('find .'), 'archive check before prune');
});

test('server credentials round-trip in a global 0600 file', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { loadCredentials, saveCredentials, clearCredentials, credentialsPath } = await import('./credentials.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lara-cred-'));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevAppData = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.APPDATA = dir;
  try {
    assert.equal(loadCredentials(), undefined, 'nothing saved yet');
    const creds = {
      server: { host: '1.2.3.4', port: 22, username: 'root', sshKey: '~/.ssh/id' },
      aapanel: { url: 'https://p.example.com:7800', apiKey: 'k' },
    };
    const file = saveCredentials(creds);
    assert.equal(file, credentialsPath());
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadCredentials(), creds);

    fs.writeFileSync(file, '{');
    assert.throws(() => loadCredentials(), /not valid JSON/);
    fs.writeFileSync(file, JSON.stringify({ server: creds.server }));
    assert.throws(() => loadCredentials(), /Invalid/);

    fs.writeFileSync(file, JSON.stringify(creds));
    assert.equal(clearCredentials(), true);
    assert.equal(clearCredentials(), false);
    assert.equal(loadCredentials(), undefined);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveKeyPath handles ~ and environment variables on every platform', async () => {
  const { resolveKeyPath } = await import('./config.js');
  const os = await import('node:os');
  const path = await import('node:path');

  assert.equal(resolveKeyPath('~'), os.homedir());
  assert.equal(resolveKeyPath('~/.ssh/id'), path.join(os.homedir(), '.ssh/id'));
  // Windows-style backslash separator after ~
  assert.equal(resolveKeyPath('~\\.ssh\\id'), path.join(os.homedir(), '.ssh/id'));
  // Surrounding whitespace from copy/paste
  assert.equal(resolveKeyPath('  ~  '), os.homedir());

  // %VAR% (Windows) and $VAR / ${VAR} (POSIX)
  process.env.LARA_TEST_HOME = '/opt/keys';
  try {
    assert.equal(resolveKeyPath('%LARA_TEST_HOME%/k'), path.resolve('/opt/keys/k'));
    assert.equal(resolveKeyPath('$LARA_TEST_HOME/k'), path.resolve('/opt/keys/k'));
    assert.equal(resolveKeyPath('${LARA_TEST_HOME}/k'), path.resolve('/opt/keys/k'));
    // An unknown variable is left intact rather than becoming "undefined".
    assert.match(resolveKeyPath('%LARA_MISSING%/k'), /%LARA_MISSING%/);
  } finally {
    delete process.env.LARA_TEST_HOME;
  }
});
