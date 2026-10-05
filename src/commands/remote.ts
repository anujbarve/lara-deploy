import https from 'node:https';
import http from 'node:http';
import { loadConfig } from '../config.js';
import { migrateRemote, seedRemote } from '../deploy.js';
import { artisanScript, paths } from '../laravel.js';
import { Ssh, q } from '../ssh.js';
import { fail, ok, title } from '../ui.js';

async function withSsh<T>(fn: (ssh: Ssh, config: ReturnType<typeof loadConfig>) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const ssh = await Ssh.connect(config.server);
  try {
    return await fn(ssh, config);
  } finally {
    ssh.close();
  }
}

export async function migrateCommand(opts: { status?: boolean }): Promise<void> {
  title();
  await withSsh(async (ssh, config) => {
    const out = await migrateRemote(ssh, config, !!opts.status);
    if (out.trim()) console.log(out.trim());
    ok(opts.status ? 'Migration status shown' : 'Migrations complete');
  });
}

export async function seedCommand(): Promise<void> {
  title();
  await withSsh(async (ssh, config) => {
    await seedRemote(ssh, config);
    ok('Seeders complete');
  });
}

function httpStatus(url: string): Promise<number> {
  const transport = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(url, { timeout: 15_000, rejectUnauthorized: false } as https.RequestOptions, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function statusCommand(): Promise<void> {
  title();
  console.log('');
  const config = loadConfig();
  let healthy = true;
  const check = (pass: boolean, label: string) => {
    if (!pass) healthy = false;
    (pass ? ok : fail)(label);
  };

  let ssh: Ssh | undefined;
  try {
    ssh = await Ssh.connect(config.server);
    check(true, 'SSH connection');
  } catch (e) {
    check(false, 'SSH connection');
    console.log(`  ${(e as Error).message}`);
  }

  try {
    const code = await httpStatus(`https://${config.site.domain}`);
    check(true, 'Website reachable');
    check(code >= 200 && code < 400, `HTTP ${code}`);
  } catch {
    check(false, 'Website reachable');
  }

  if (ssh) {
    const { root, main } = paths(config);
    const art = await ssh.exec(artisanScript(config, '--version'));
    check(art.code === 0 && art.stdout.includes('Laravel'), 'Laravel OK');
    const db = await ssh.exec(artisanScript(config, 'migrate:status'));
    check(db.code === 0, 'Database connection');
    const link = await ssh.exec(`[ "$(readlink ${q(root + '/storage')})" = ${q(main + '/storage/app/public')} ]`);
    check(link.code === 0, 'Storage link OK');
    ssh.close();
  }

  console.log(`\nStatus: ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`);
  if (!healthy) process.exitCode = 1;
}

