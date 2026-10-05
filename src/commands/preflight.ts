import { AaPanel } from '../aapanel.js';
import { loadConfig, type Config } from '../config.js';
import { assertLaravelProject, paths, PHP_DETECT } from '../laravel.js';
import { Ssh } from '../ssh.js';
import { isFixableDocumentRoot, parseInspection, stripSlash, vhostInspectScript } from '../vhost.js';
import { fail, ok, step, title, warn } from '../ui.js';

const finish = (ready: boolean): void => {
  console.log('');
  if (ready) {
    console.log('Ready to deploy: lara-deploy deploy');
    return;
  }
  console.log('Not ready \u2014 fix the problems above, then try again.');
  process.exitCode = 1;
};

/**
 * Read-only checks run before `deploy`: everything a deployment needs, verified
 * without changing anything on the server.
 */
export async function preflightCommand(): Promise<void> {
  title();

  step('Local project');
  try {
    assertLaravelProject();
    ok('Laravel project detected');
  } catch (e) {
    fail((e as Error).message);
    return finish(false);
  }

  let config: Config;
  try {
    config = loadConfig();
    ok(`Configuration found for ${config.site.domain}`);
  } catch (e) {
    fail((e as Error).message);
    return finish(false);
  }

  step('Server');
  const { host, port, username } = config.server;
  let ssh: Ssh;
  try {
    ssh = await Ssh.connect(config.server);
    ok(`SSH ${username}@${host}:${port}`);
  } catch (e) {
    fail((e as Error).message);
    return finish(false);
  }

  try {
    const php = await ssh.exec(`${PHP_DETECT}\n"$PHP" -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;'`);
    const version = php.stdout.trim();
    if (php.code === 0 && version) {
      ok(`PHP ${version} on the server`);
    } else {
      fail('No PHP found on the server');
      console.log('  Install PHP from the aaPanel App Store, then try again.');
      return finish(false);
    }

    step('aaPanel');
    const panel = new AaPanel(config);
    try {
      await panel.connect();
    } catch (e) {
      fail((e as Error).message);
      return finish(false);
    }
    ok(`API authenticated at ${config.aapanel.url}`);

    // A missing site or database is not a problem: `deploy` creates both.
    try {
      const site = await panel.findSite(config.site.domain);
      if (site) ok(`Website exists (${site.path})`);
      else warn(`Website ${config.site.domain} does not exist yet \u2014 deploy will create it`);
    } catch (e) {
      fail(`Could not read the website list: ${(e as Error).message}`);
      return finish(false);
    }

    // A vhost left pointing at a Laravel public directory is the classic reason a
    // successful deployment still returns 500. Read-only here; deploy repairs it.
    try {
      const { root } = paths(config);
      const vhost = parseInspection((await ssh.exec(vhostInspectScript(config.site.domain))).stdout);
      const wrong = vhost.documentRoots.filter((d) => stripSlash(d) !== stripSlash(root));
      if (!vhost.webserver || !vhost.conf) {
        warn('Could not read the web server configuration');
      } else if (!wrong.length) {
        ok(`Document root matches the site root (${root})`);
      } else if (wrong.every((d) => isFixableDocumentRoot(d, root))) {
        warn(`Document root is ${wrong.join(', ')} \u2014 deploy will point it at ${root}`);
      } else {
        warn(`Document root is ${wrong.join(', ')} (expected ${root})`);
      }
    } catch (e) {
      warn(`Could not check the web server configuration: ${(e as Error).message}`);
    }

    try {
      const database = await panel.findDatabase(config.database.name);
      // Only the username is safe to print; rows also carry the password.
      if (database) ok(`Database exists (${database.username})`);
      else warn(`Database ${config.database.name} does not exist yet \u2014 deploy will create it`);
    } catch (e) {
      fail(`Could not read the database list: ${(e as Error).message}`);
      return finish(false);
    }
  } finally {
    ssh.close();
  }

  return finish(true);
}