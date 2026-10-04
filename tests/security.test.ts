import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateEnv,
  planEnvWrite,
  parseEnv,
  renderEnv,
  envWriteScript,
  DEFAULT_REQUIRED_ENV,
} from '../src/laravel/env.js';
import { q, assertHostname, assertRemotePath, assertIdentifier, assertProgramName, shellPreamble, heredoc } from '../src/utils/shell.js';
import { redact, redactOutput, isSensitiveKey } from '../src/utils/redact.js';
import { DeploymentLock } from '../src/core/release/lock.js';
import { planPermissions } from '../src/providers/webserver/provider.js';
import { StorageSecretsStore } from '../src/core/security/storage-store.js';
import { MemorySecretsStore } from '../src/core/security/secrets.js';
import { FakeExecutor } from './helpers.js';
import type { ExecOptions, ExecResult } from '../src/providers/exec/types.js';
import { SupervisorManager } from '../src/providers/supervisor/manager.js';
import { validateAppConfig } from '../src/core/config/loader.js';
import { q as shellQuote } from '../src/utils/shell.js';

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop() as string, { recursive: true, force: true });
});

describe('env validation', () => {
  it('requires the core Laravel variables by default', () => {
    const result = validateEnv({
      remoteEnv: null,
      exampleKeys: [],
      configUsages: [],
      policy: { required: [], optional: [], blockOnMissing: false },
    });
    for (const key of DEFAULT_REQUIRED_ENV) {
      expect(result.missing).toContain(key);
    }
  });

  it('reports variables by name only, never by value', () => {
    const result = validateEnv({
      remoteEnv: { APP_KEY: 'base64:secret', APP_URL: 'https://x.test', DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_DATABASE: 'd', DB_USERNAME: 'u', DB_PASSWORD: 'p' },
      exampleKeys: [],
      configUsages: [],
      policy: { required: [], optional: [], blockOnMissing: false },
    });
    expect(result.missing).toHaveLength(0);
    expect(result.present).toContain('DB_PASSWORD');
    // The result carries names, never values.
    expect(JSON.stringify(result)).not.toContain('base64:secret');
  });

  it('warns about example keys missing on the server', () => {
    const result = validateEnv({
      remoteEnv: { APP_KEY: 'k', APP_URL: 'u', DB_CONNECTION: 'mysql', DB_HOST: 'h', DB_DATABASE: 'd', DB_USERNAME: 'u', DB_PASSWORD: 'p' },
      exampleKeys: ['MAIL_HOST', 'REDIS_HOST'],
      configUsages: [],
      policy: { required: [], optional: [], blockOnMissing: false },
    });
    expect(result.warnings).toContain('MAIL_HOST');
    expect(result.warnings).toContain('REDIS_HOST');
  });

  it('blocks only when policy says so', () => {
    const base = { remoteEnv: {}, exampleKeys: [], configUsages: [] };
    expect(validateEnv({ ...base, policy: { required: [], optional: [], blockOnMissing: false } }).blocking).toBe(false);
    expect(validateEnv({ ...base, policy: { required: [], optional: [], blockOnMissing: true } }).blocking).toBe(true);
  });
});

describe('env write strategy', () => {
  const database = { name: 'client', username: 'client', password: 'genpass', host: '127.0.0.1', port: 3306 };
  const base = {
    remoteEnv: null as Record<string, string> | null,
    isFirstDeploy: true,
    domain: 'example.com',
    database,
    generateKeys: [],
    extraValues: {},
    initialiseFromExample: true,
  };

  it('preserves an existing server .env by default', () => {
    const plan = planEnvWrite({ ...base, strategy: 'preserve', remoteEnv: { APP_KEY: 'keep-me' } });
    expect(plan.contents).toBe(null);
    expect(plan.reason).toContain('preserved');
  });

  it('creates a minimal .env on first deploy without uploading the local one', () => {
    const plan = planEnvWrite({ ...base, strategy: 'preserve', isFirstDeploy: true, remoteEnv: null });
    expect(plan.contents).not.toBe(null);
    const parsed = parseEnv(plan.contents as string);
    expect(parsed.APP_URL).toBe('https://example.com');
    expect(parsed.APP_ENV).toBe('production');
    expect(parsed.DB_DATABASE).toBe('client');
    expect(parsed.DB_PASSWORD).toBe('genpass');
  });

  it('never writes on a non-first deploy with envStrategy=template', () => {
    const plan = planEnvWrite({
      ...base,
      strategy: 'template',
      isFirstDeploy: false,
      templateContents: 'APP_NAME=X',
    });
    expect(plan.contents).toBe(null);
  });

  it('builds from a template on first deploy', () => {
    const plan = planEnvWrite({
      ...base,
      strategy: 'template',
      templateContents: 'APP_NAME=FromTemplate\nCUSTOM=yes',
    });
    const parsed = parseEnv(plan.contents as string);
    expect(parsed.APP_NAME).toBe('FromTemplate');
    expect(parsed.CUSTOM).toBe('yes');
    expect(parsed.APP_ENV).toBe('production');
  });

  it('only generates missing keys, never overwriting existing ones', () => {
    const plan = planEnvWrite({
      ...base,
      strategy: 'generate',
      isFirstDeploy: false,
      remoteEnv: { DB_PASSWORD: 'already-set', APP_KEY: '' },
      generateKeys: ['DB_PASSWORD', 'APP_KEY'],
    });
    const parsed = parseEnv(plan.contents as string);
    expect(parsed.DB_PASSWORD).toBe('already-set');
    expect(parsed.APP_KEY?.startsWith('base64:')).toBe(true);
  });

  it('writes nothing when nothing needs generating', () => {
    const plan = planEnvWrite({
      ...base,
      strategy: 'generate',
      isFirstDeploy: false,
      remoteEnv: { DB_PASSWORD: 'set' },
      generateKeys: ['DB_PASSWORD'],
    });
    expect(plan.contents).toBe(null);
  });

  it('round-trips quoted values through render/parse', () => {
    const rendered = renderEnv({ A: 'plain', B: 'has space', C: 'has"quote', D: 'line\nbreak' });
    const parsed = parseEnv(rendered);
    expect(parsed.A).toBe('plain');
    expect(parsed.B).toBe('has space');
    expect(parsed.C).toBe('has"quote');
    expect(parsed.D).toBe('line\nbreak');
  });
});

describe('env file transport', () => {
  it('passes contents through a heredoc, never argv', () => {
    const script = envWriteScript('/www/wwwroot/example.com/shared/.env', 'APP_KEY=base64:xyz\n', '0640');
    expect(script).toContain("<<'LARAVELDEPLOYENV");
    expect(script).toContain('umask 077');
    expect(script).toContain('chmod 0640');
    // The payload appears in the heredoc body, not as a quoted argument.
    expect(script).not.toMatch(/echo 'APP_KEY=/);
  });

  it('uses a unique tag per call to avoid collision', () => {
    const a = envWriteScript('/x/.env', 'A=1');
    const b = envWriteScript('/x/.env', 'A=1');
    expect(a).not.toBe(b);
  });
});

describe('shell quoting', () => {
  it('single-quotes values safely', () => {
    expect(q('simple')).toBe("'simple'");
    expect(q("it's")).toBe(`'it'\\''s'`);
    expect(q('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(q('`whoami`')).toBe("'`whoami`'");
    expect(q(null)).toBe("''");
    expect(q(42)).toBe("'42'");
  });

  it('rejects newlines in values used for paths', () => {
    expect(() => assertRemotePath('/www/wwwroot\nrm -rf /')).toThrow(/newline/);
  });

  it('rejects relative and traversing remote paths', () => {
    expect(() => assertRemotePath('relative/path')).toThrow(/absolute/);
    expect(() => assertRemotePath('/www/../etc')).toThrow(/traversal/);
    expect(assertRemotePath('/www/wwwroot/example.com')).toBe('/www/wwwroot/example.com');
  });

  it('validates hostnames and IPs', () => {
    expect(assertHostname('example.com')).toBe('example.com');
    expect(assertHostname('sub.example.co.uk')).toBe('sub.example.co.uk');
    expect(assertHostname('123.45.67.89')).toBe('123.45.67.89');
    expect(() => assertHostname('not a host')).toThrow(/not a valid hostname/);
    expect(() => assertHostname('evil.com; rm -rf /')).toThrow(/not a valid hostname/);
  });

  it('validates SQL identifiers', () => {
    expect(assertIdentifier('client_site')).toBe('client_site');
    expect(() => assertIdentifier('a; DROP DATABASE x')).toThrow(/Invalid/);
    expect(() => assertIdentifier("quote'injection")).toThrow(/Invalid/);
  });

  it('emits a strict preamble for remote scripts', () => {
    expect(shellPreamble()).toContain('set -Eeuo pipefail');
    expect(shellPreamble()).toContain('trap');
  });

  it('builds a quoted heredoc', () => {
    // The tag is sanitised to alphanumeric, which is what a shell accepts.
    const tag = heredoc('EOF-x', 'body');
    expect(tag).toContain("<<'EOFx'");
    expect(tag).toContain('body');
    expect(tag.trimEnd().endsWith('EOFx')).toBe(true);
  });
});

describe('redaction', () => {
  it('identifies sensitive keys', () => {
    for (const key of ['password', 'DB_PASSWORD', 'apiKey', 'APP_KEY', 'token', 'private_key']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey('username')).toBe(false);
    expect(isSensitiveKey('domain')).toBe(false);
  });

  it('redacts nested secrets in objects', () => {
    const redacted = redact({
      username: 'root',
      password: 'hunter2',
      nested: { apiKey: 'abc', safe: 'value' },
      list: [{ db_password: 'x' }],
    }) as Record<string, unknown>;
    expect(redacted.username).toBe('root');
    expect(redacted.password).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).safe).toBe('value');
    expect(((redacted.list as unknown[])[0]) as Record<string, unknown>).toMatchObject({
      db_password: '[redacted]',
    });
  });

  it('redacts whole values that look like keys or tokens', () => {
    expect(redact({ note: '-----BEGIN RSA PRIVATE KEY-----' })).toMatchObject({
      note: '[redacted]',
    });
    expect(redact({ jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.x' })).toMatchObject({
      jwt: '[redacted]',
    });
  });

  it('survives cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it('redacts KEY=value lines in remote output', () => {
    const output = redactOutput(['APP_ENV=production', 'DB_PASSWORD=secret', 'plain text'].join('\n'));
    expect(output).toContain('APP_ENV=production');
    expect(output).toContain('DB_PASSWORD=[redacted]');
    expect(output).not.toContain('secret');
  });
});

describe('secrets store', () => {
  it('stores, reads and lists without exposing values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-secrets-'));
    created.push(dir);
    const file = path.join(dir, 'secrets.json');

    const store = new StorageSecretsStore(file);
    store.set('servers.production.db.password', 'hunter2');
    expect(store.get('servers.production.db.password')).toBe('hunter2');
    expect(store.keys()).toEqual(['servers.production.db.password']);

    // File mode must be 0600.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('hunter2');
  });

  it('removes a secret', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-secrets-'));
    created.push(dir);
    const store = new StorageSecretsStore(path.join(dir, 'secrets.json'));
    store.set('a', '1');
    expect(store.remove('a')).toBe(true);
    expect(store.get('a')).toBe(undefined);
    expect(store.remove('a')).toBe(false);
  });

  it('encrypts values at rest when a passphrase is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-secrets-'));
    created.push(dir);
    const file = path.join(dir, 'secrets.json');
    const store = new StorageSecretsStore(file, {
      LARAVEL_DEPLOY_SECRET_PASSPHRASE: 'correct horse',
    });
    expect(store.encrypted).toBe(true);
    store.set('a', 'hunter2');
    // The plaintext must not be on disk.
    expect(fs.readFileSync(file, 'utf8')).not.toContain('hunter2');
    expect(store.get('a')).toBe('hunter2');
  });

  it('cannot read an encrypted value without the passphrase', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-secrets-'));
    created.push(dir);
    const file = path.join(dir, 'secrets.json');
    new StorageSecretsStore(file, { LARAVEL_DEPLOY_SECRET_PASSPHRASE: 'pass-a' }).set('a', 'x');
    const noPass = new StorageSecretsStore(file, {});
    expect(noPass.get('a')).toBe(undefined);
    const wrongPass = new StorageSecretsStore(file, { LARAVEL_DEPLOY_SECRET_PASSPHRASE: 'wrong' });
    expect(wrongPass.get('a')).toBe(undefined);
  });

  it('the in-memory store never writes to disk', () => {
    const store = new MemorySecretsStore();
    store.set('a', 'b');
    expect(store.get('a')).toBe('b');
    expect(store.location).toBe('(memory)');
  });
});

describe('deployment lock', () => {
  it('acquires the lock when free', async () => {
    const executor = new FakeExecutor();
    const lock = new DeploymentLock(executor);
    await lock.acquire({
      lockFile: '/www/wwwroot/example.com/.deploy/deployment.lock',
      deploymentId: 'DEPLOY-1',
      startedAt: '2026-10-03 10:32:10',
      host: 'laptop',
      user: 'root',
    });
    expect(executor.saw('mkdir')).toBe(true);
    expect(executor.saw('DEPLOY-1')).toBe(true);
    expect(executor.saw('chmod 0600')).toBe(true);
  });

  it('creates the .deploy directory before the atomic lock mkdir', async () => {
    // On a first deploy <root>/.deploy does not exist yet, and a bare `mkdir`
    // of the lock directory would fail with ENOENT — indistinguishable from
    // the lock being held.
    const executor = new FakeExecutor();
    const lock = new DeploymentLock(executor);
    await lock.acquire({
      lockFile: '/www/wwwroot/example.com/.deploy/deployment.lock',
      deploymentId: 'DEPLOY-1',
      startedAt: new Date().toISOString(),
      host: 'laptop',
      user: 'root',
    });
    const script = executor.commands[executor.commands.length - 1] as string;
    expect(script).toContain("mkdir -p '/www/wwwroot/example.com/.deploy'");
    expect(script.indexOf('mkdir -p')).toBeLessThan(script.indexOf('lockdir='));
  });

  it('reports exit code 3 as a locked error, not a generic remote failure', async () => {
    // The lock script exits 3 when it loses the race; the executor must be
    // allowed to return that code so acquire() can translate it.
    const executor = new FakeExecutor();
    let sawAllowFailure: boolean | undefined;
    executor.on('mkdir "$lockdir"', { exitCode: 3, stdout: 'LOCKED' });
    const original = executor.exec.bind(executor);
    executor.exec = async (command: string, options?: ExecOptions): Promise<ExecResult> => {
      if (command.includes('LDLOCK')) sawAllowFailure = options?.allowFailure;
      return original(command, options);
    };

    await expect(
      new DeploymentLock(executor).acquire({
        lockFile: '/www/wwwroot/example.com/.deploy/deployment.lock',
        deploymentId: 'DEPLOY-1',
        startedAt: new Date().toISOString(),
        host: 'laptop',
        user: 'root',
      }),
    ).rejects.toThrow(/Another deployment acquired the lock first/);
    expect(sawAllowFailure).toBe(true);
  });

  it('does not report a permission failure as lock contention', async () => {
    // A mkdir that fails for any reason other than the directory existing means
    // something is wrong with the server, not that a deploy is running.
    const script = await new DeploymentLock(new FakeExecutor()).buildAcquireScript(
      '/www/wwwroot/example.com/.deploy/deployment.lock',
      { deploymentId: 'DEPLOY-1', startedAt: '2026-10-03 10:32:10', host: 'laptop', user: 'root' },
    );
    expect(script).toContain('if [ -d "$lockdir" ]; then echo "LOCKED"; exit 3; fi');
    expect(script).toContain('exit 4');
  });

  it('reports exit code 4 as a lock-directory problem, not contention', async () => {
    const executor = new FakeExecutor().on('mkdir "$lockdir"', { exitCode: 4, stderr: 'Permission denied' });
    await expect(
      new DeploymentLock(executor).acquire({
        lockFile: '/www/wwwroot/example.com/.deploy/deployment.lock',
        deploymentId: 'DEPLOY-1',
        startedAt: new Date().toISOString(),
        host: 'laptop',
        user: 'root',
      }),
    ).rejects.toThrow(/Unable to create the lock directory/);
  });

  it('omits the parent mkdir when the lock path has no directory', async () => {
    // `mkdir -p ''` exits non-zero and, under `set -e`, would abort the whole
    // acquire script rather than reporting a lock problem.
    const executor = new FakeExecutor();
    await new DeploymentLock(executor).acquire({
      lockFile: '/deployment.lock',
      deploymentId: 'DEPLOY-1',
      startedAt: new Date().toISOString(),
      host: 'laptop',
      user: 'root',
    });
    const script = executor.commands[executor.commands.length - 1] as string;
    expect(script).not.toContain('mkdir -p');
    expect(script).toContain("lockdir='/deployment.lock'.d");
  });

  it('refuses to deploy while another lock is held', async () => {
    const executor = new FakeExecutor().on('cat', {
      stdout: JSON.stringify({ deploymentId: 'DEPLOY-OTHER', startedAt: new Date().toISOString(), host: 'ci', user: 'deploy' }),
    });
    const lock = new DeploymentLock(executor);
    await expect(
      lock.acquire({
        lockFile: '/l',
        deploymentId: 'DEPLOY-1',
        startedAt: new Date().toISOString(),
        host: 'laptop',
        user: 'root',
      }),
    ).rejects.toThrow(/already running/);
  });

  it('breaks a lock when forced', async () => {
    const executor = new FakeExecutor().on('cat', {
      stdout: JSON.stringify({ deploymentId: 'DEPLOY-OTHER', startedAt: new Date().toISOString(), host: 'ci', user: 'deploy' }),
    });
    const lock = new DeploymentLock(executor);
    await lock.acquire({
      lockFile: '/l',
      deploymentId: 'DEPLOY-1',
      startedAt: new Date().toISOString(),
      host: 'laptop',
      user: 'root',
      force: true,
    });
    expect(executor.saw('rm -f')).toBe(true);
  });

  it('treats a corrupt lock as stale rather than blocking forever', async () => {
    const executor = new FakeExecutor().on('cat', { stdout: 'not json at all' });
    const lock = new DeploymentLock(executor);
    await lock.acquire({
      lockFile: '/l',
      deploymentId: 'DEPLOY-1',
      startedAt: new Date().toISOString(),
      host: 'laptop',
      user: 'root',
    });
    expect(executor.saw('mkdir')).toBe(true);
  });

  it('recognises a lock older than the stale threshold', async () => {
    const lock = new DeploymentLock(new FakeExecutor());
    const old = { deploymentId: 'x', startedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), host: 'h', user: 'u' };
    expect(lock.isStale(old, 3 * 3600 * 1000)).toBe(true);
    expect(
      lock.isStale({ ...old, startedAt: new Date().toISOString() }, 3 * 3600 * 1000),
    ).toBe(false);
  });

  it('guards the release with a grep on the deployment id', async () => {
    const executor = new FakeExecutor().on('cat', { stdout: '{"deploymentId":"DEPLOY-OTHER"}' });
    await new DeploymentLock(executor).release('/l', 'DEPLOY-MINE');
    // The removal only runs when the lock still names us.
    expect(executor.saw('grep -q')).toBe(true);
    expect(executor.saw("rm -f \"$lockfile\"")).toBe(true);
  });
});

describe('permission planning', () => {
  it('keeps application code non-writable by the web user', () => {
    const plan = planPermissions({
      releasePath: '/www/wwwroot/example.com/current',
      sharedPath: '/www/wwwroot/example.com/shared',
      webUser: 'www',
      webGroup: 'www',
      writableDirs: ['storage', 'bootstrap/cache'],
      dirMode: '0755',
      fileMode: '0644',
      chown: true,
      chownShared: true,
      chmod777: false,
    });

    const script = plan.steps.join('\n');
    expect(script).toContain('chown -R root:www');
    expect(script).toContain('chmod -R 0775');
    expect(script).not.toContain('chmod -R 777');
    expect(script).not.toContain('chmod 777');
  });

  it('makes shared storage writable by the web user', () => {
    const plan = planPermissions({
      releasePath: '/r',
      sharedPath: '/www/wwwroot/example.com/shared',
      webUser: 'www',
      webGroup: 'www',
      writableDirs: ['storage', 'bootstrap/cache'],
      dirMode: '0755',
      fileMode: '0644',
      chown: true,
      chownShared: true,
      chmod777: false,
    });
    expect(plan.writable).toContain('/www/wwwroot/example.com/shared/storage');
    expect(plan.steps.join('\n')).toContain('chown -R www:www');
  });

  it('quotes every path it touches', () => {
    const plan = planPermissions({
      releasePath: "/weird path/release",
      sharedPath: '/s',
      webUser: 'www',
      webGroup: 'www',
      writableDirs: ['storage'],
      dirMode: '0755',
      fileMode: '0644',
      chown: true,
      chownShared: true,
      chmod777: false,
    });
    expect(plan.steps.join('\n')).toContain(shellQuote("/weird path/release"));
  });

  it('applies 0777 and says so, when the chmod777 escape hatch is set', () => {
    const plan = planPermissions({
      releasePath: '/r',
      sharedPath: '/s',
      webUser: 'www',
      webGroup: 'www',
      writableDirs: ['storage'],
      dirMode: '0755',
      fileMode: '0644',
      chown: true,
      chownShared: true,
      chmod777: true,
    });

    expect(plan.steps.join('\n')).toContain('chmod -R 0777');
    // The mode sweep that would narrow it back to 0755/0644 must not run.
    expect(plan.steps.join('\n')).not.toContain('find /r');
    // And the operator is told, rather than discovering it later.
    expect(plan.warnings.join(' ')).toMatch(/world-writable/);
  });
});
/**
 * Supervisor program names.
 *
 * `queue.processName` reaches the server two ways: interpolated into a
 * `supervisorctl` command, and used to build a path under
 * /etc/supervisor/conf.d. `.laravel-deploy.json` is read from the repository
 * being deployed and is designed to be committed, so it is not trusted input —
 * a name of `evil; rm -rf /` used to split the command and run the rest on the
 * server as root.
 */
describe('supervisor program name safety', () => {
  it('accepts the names the CLI itself generates', () => {
    expect(assertProgramName('laravel-my-app-worker')).toBe('laravel-my-app-worker');
    expect(assertProgramName('laravel-my-app-worker-1')).toBe('laravel-my-app-worker-1');
    expect(assertProgramName('client_site.worker')).toBe('client_site.worker');
  });

  it.each([
    'evil; rm -rf /',
    'a | tee /etc/passwd',
    'a && b',
    'a `id`',
    'a $(id)',
    'a\nb',
    '../escape',
    'a/../../escape',
    'has space',
    'quote\'s',
    '',
  ])('rejects %j', (value) => {
    expect(() => assertProgramName(value)).toThrow();
  });

  it('rejects a leading dash so a name cannot become a supervisorctl flag', () => {
    // assertIdentifier permits this; a program name must not.
    expect(() => assertProgramName('-n')).toThrow();
    expect(() => assertProgramName('--help')).toThrow();
  });

  it('quotes names in the supervisorctl command it builds', async () => {
    const executor = new FakeExecutor();
    const manager = new SupervisorManager({ executor });
    await manager.restart(['laravel-app-worker', 'laravel-app-worker-1']);

    const command = executor.commands[0] as string;
    expect(command).toContain(shellQuote('laravel-app-worker'));
    expect(command).not.toMatch(/restart [a-z]/);
  });

  it('refuses to build a program path from an unsafe name', () => {
    const manager = new SupervisorManager({ executor: new FakeExecutor() });
    expect(() => manager.programFile('evil; rm -rf /')).toThrow();
    expect(manager.programFile('laravel-app-worker')).toBe(
      '/etc/supervisor/conf.d/laravel-app-worker.conf',
    );
  });

  it('rejects an unsafe processName at config load, not at deploy time', () => {
    expect(() =>
      validateAppConfig({
        server: 'test',
        site: { domain: 'example.com' },
        queue: { processName: 'evil; echo PWNED > /tmp/pwned' },
      }),
    ).toThrow();
  });

  it('still accepts a legitimate processName', () => {
    const config = validateAppConfig({
      server: 'test',
      site: { domain: 'example.com' },
      queue: { processName: 'client-site-worker' },
    });
    expect(config.queue.processName).toBe('client-site-worker');
  });
});
