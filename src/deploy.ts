import { AaPanel } from './aapanel.js';
import { createArchive, removeArchive, runLocal } from './archive.js';
import { saveConfig, type Config } from './config.js';
import { artisanScript, assertLaravelProject, envUpdates, hasAppKey, installScript, mergeEnv, paths, storageLinkScript } from './laravel.js';
import { Ssh, q } from './ssh.js';
import { DeployError, ok, step, warn } from './ui.js';
import { isFixableDocumentRoot, parseInspection, stripSlash, vhostInspectScript, vhostRepairScript } from './vhost.js';

export interface DeployOptions {
  skipBuild: boolean;
  seed: boolean;
  verbose: boolean;
}

const REMOTE_ARCHIVE = '/tmp/lara-deploy.tar.gz';

/**
 * The site root must be the vhost's document root; the app is served from
 * <root>/index.php. A site set up by an older tool can still point its document
 * root at <root>/current/public, where every request dies in an internal
 * redirect loop (Apache: "AH00124: Request exceeded the limit of 10 internal
 * redirects") long after the deployment itself reported success.
 */
async function ensureDocumentRoot(ssh: Ssh, config: Config): Promise<void> {
  const { root } = paths(config);
  const inspected = await ssh.exec(vhostInspectScript(config.site.domain));
  // Best effort: a failed read must not abort a deployment that may work anyway.
  if (inspected.code !== 0) return;
  const vhost = parseInspection(inspected.stdout);
  if (!vhost.webserver || !vhost.conf) {
    warn(`Could not read the web server config for ${config.site.domain}`);
    return;
  }

  const wrong = vhost.documentRoots.filter((d) => stripSlash(d) !== stripSlash(root));
  if (!wrong.length) {
    ok(`Document root is ${root}`);
    return;
  }

  const repaired = new Set<string>();
  for (const from of wrong) {
    if (!isFixableDocumentRoot(from, root)) {
      // Someone may have pointed this site somewhere on purpose; only report it.
      warn(`Document root is ${from}, not ${root} \u2014 left unchanged`);
      continue;
    }
    const r = await ssh.exec(vhostRepairScript({ webserver: vhost.webserver, conf: vhost.conf, from, to: root }));
    if (r.code !== 0 || r.stdout.includes('REVERTED=')) {
      throw new DeployError('Could not fix the website document root', [
        '',
        `${vhost.conf} points at ${from}, but the app is served from ${root}.`,
        `Set DocumentRoot/root to ${root}, reload the web server, then deploy again.`,
        ...(r.stdout.trim() ? ['', ...r.stdout.trim().split('\n').slice(-6)] : []),
      ]);
    }
    repaired.add(stripSlash(from));
    ok(`Document root repaired: ${from} -> ${root}`);
  }

  // Confirm the rewrite landed rather than trusting sed's exit code. Only the
  // values we actually changed are checked; a deliberate root is left as reported.
  if (repaired.size) {
    const after = parseInspection((await ssh.exec(vhostInspectScript(config.site.domain))).stdout).documentRoots;
    const lingering = [...repaired].filter((d) => after.map(stripSlash).includes(d));
    if (lingering.length) {
      throw new DeployError('The website document root is still wrong', [
        '',
        `${vhost.conf} still points at ${lingering.join(', ')}; expected ${root}.`,
        'Fix it in aaPanel (Website -> site -> Config) and deploy again.',
      ]);
    }
    ok(`Document root verified: ${root}`);
  }
}

async function localBuild(command: string, label: string, done: string, verbose: boolean): Promise<void> {
  step(`Running ${label}`);
  const r = await runLocal(command, verbose);
  if (r.code !== 0) {
    const tail = r.output.trim().split('\n').slice(-15);
    throw new DeployError(`${label} failed`, [...(tail[0] ? ['', ...tail] : []), '', 'Deployment stopped.', 'Nothing was uploaded to the server.']);
  }
  ok(done);
}

export async function deploy(config: Config, opts: DeployOptions): Promise<void> {
  step('Checking Laravel project');
  assertLaravelProject();
  ok('Laravel project detected');

  // 1. aaPanel: website + database
  step('Connecting to aaPanel');
  const panel = new AaPanel(config);
  await panel.connect();
  ok('aaPanel connected');

  step('Checking website');
  let siteCreated = false;
  const site = await panel.findSite(config.site.domain);
  if (site) {
    ok('Website already exists');
    if (site.path && site.path.replace(/\/+$/, '') !== config.site.root.replace(/\/+$/, '')) {
      config.site.root = site.path;
      saveConfig(config);
      ok(`Using aaPanel's site root ${site.path} (config updated)`);
    }
  } else {
    console.log('→ Creating website');
    await panel.createSite(config.site.domain, config.site.root);
    siteCreated = true;
    ok('Website created');
  }

  step('Checking database');
  const db = { username: config.database.username, password: config.database.password };
  const existing = await panel.findDatabase(config.database.name);
  if (existing) {
    ok('Database already exists');
    // Use what aaPanel has on record so .env matches the real database user.
    if (existing.username && existing.username !== db.username) {
      db.username = existing.username;
      if (existing.password) db.password = existing.password;
      config.database.username = db.username;
      config.database.password = db.password;
      saveConfig(config);
      ok('Database credentials taken from aaPanel (config updated)');
    }
  } else {
    console.log('→ Creating database');
    await panel.createDatabase(config.database.name, db.username, db.password);
    ok('Database created');
  }

  // 2. Local build
  if (opts.skipBuild) {
    step('Skipping build (--skip-build)');
  } else {
    await localBuild('composer install', 'composer install', 'Composer complete', opts.verbose);
    await localBuild('npm run build', 'npm run build', 'Frontend build complete', opts.verbose);
  }

  step('Creating archive');
  const archive = await createArchive(process.cwd());
  ok('Archive created');

  const { root, main } = paths(config);
  let ssh: Ssh | undefined;
  try {
    ssh = await Ssh.connect(config.server);

    step('Checking website document root');
    await ensureDocumentRoot(ssh, config);

    step('Uploading application');
    await ssh.run(`mkdir -p ${q(root)}`, 'Could not create the site root on the server');
    try {
      await ssh.upload(archive, REMOTE_ARCHIVE);
    } catch (e) {
      throw new DeployError(`Upload failed: ${(e as Error).message}`);
    }
    ok('Upload complete');

    step('Extracting application');
    await ssh.run(installScript(config, REMOTE_ARCHIVE), 'Extracting the application failed', 'tar / cp / sed (install step)');
    ok('Application extracted');
    ok('Public files copied');
    ok('index.php configured');
    if (siteCreated) await ssh.exec(`rm -f ${q(root + '/index.html')}`);

    step('Configuring .env');
    const current = (await ssh.exec(`cat ${q(main + '/.env')} 2>/dev/null`)).stdout;
    let base = current;
    if (!base) base = (await ssh.exec(`cat ${q(main + '/.env.example')} 2>/dev/null`)).stdout;
    const merged = mergeEnv(base, envUpdates(config, db));
    await ssh.writeFile(merged, `${main}/.env`);
    if (!hasAppKey(merged)) {
      await ssh.run(artisanScript(config, 'key:generate --force'), 'Generating APP_KEY failed', 'php artisan key:generate --force');
      ok('APP_KEY generated');
    }
    // PHP-FPM runs as www, but the SFTP write leaves .env owned by root (0640),
    // so on a fresh site Laravel cannot read it and every request fails with
    // "No application encryption key has been specified".
    await ssh.exec(`chown www:www ${q(`${main}/.env`)} 2>/dev/null || true`);
    ok('Environment configured');

    step('Creating storage link');
    const linked = await ssh.run(
      storageLinkScript(config),
      'Creating the storage link failed',
      `ln -s ${main}/storage/app/public ${root}/storage`,
    );
    const moved = linked.stdout.match(/^MOVED_ASIDE:(.+)$/m);
    if (moved) warn(`A real ${root}/storage was in the way; kept as ${moved[1]!.trim()}`);
    ok('Storage linked');

    if (config.deployment.runMigrations) {
      step('Running migrations');
      await migrateRemote(ssh, config);
      ok('Migrations complete');
    }
    if (opts.seed || config.deployment.runSeeders) {
      step('Running seeders');
      await seedRemote(ssh, config);
      ok('Seeders complete');
    }
  } finally {
    removeArchive(archive);
    ssh?.close();
  }

  step('Deployment complete');
  console.log(`\nhttps://${config.site.domain}`);
}

function failureOutput(r: { stdout: string; stderr: string }): string[] {
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    // PHP writes these to stderr with a "PHP " prefix and to stdout without it;
    // both are noise that would bury the real error.
    .filter((l) => l.trim() && !/^(PHP )?(Deprecated|Notice|Warning):/.test(l.trim()));
  return lines.slice(-15);
}

export async function migrateRemote(ssh: Ssh, config: Config, status = false): Promise<string> {
  const args = status ? 'migrate:status' : 'migrate --force';
  const r = await ssh.exec(artisanScript(config, args));
  if (r.code !== 0) {
    throw new DeployError(status ? 'migrate:status failed' : 'Migration failed', [
      '',
      'Command:',
      `php artisan ${args}`,
      '',
      ...failureOutput(r),
      '',
      ...(status ? [] : ['The uploaded application remains on the server.', 'The current application was not intentionally removed.']),
    ]);
  }
  return r.stdout;
}

export async function seedRemote(ssh: Ssh, config: Config): Promise<void> {
  const r = await ssh.exec(artisanScript(config, 'db:seed --force'));
  if (r.code !== 0) {
    throw new DeployError('Seeding failed', ['', 'Command:', 'php artisan db:seed --force', '', ...(r.stderr || r.stdout).trim().split('\n').slice(-15)]);
  }
}
