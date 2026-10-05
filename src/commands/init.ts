import { input, password } from '@inquirer/prompts';
import { CONFIG_FILE, ensureGitignored, saveConfig, validate, type Config } from '../config.js';
import { credentialsPath, loadCredentials } from '../credentials.js';
import { DeployError, ok, title } from '../ui.js';

/**
 * Configure the website. The VPS and aaPanel details come from the global
 * credentials saved by `lara-deploy server`, so this only asks about the site.
 */
export async function initCommand(): Promise<void> {
  title();
  console.log('');

  const creds = loadCredentials();
  if (!creds) {
    throw new DeployError('No server credentials saved.', [
      'Run `lara-deploy server` once to store the VPS host, SSH key and aaPanel API key,',
      'then run `lara-deploy init` again to configure this site.',
    ]);
  }
  const { server, aapanel } = creds;
  console.log(`Using saved server ${server.username}@${server.host}:${server.port} (${credentialsPath()})`);
  console.log('');

  const domain = await input({ message: 'Domain', required: true });
  const slug = domain.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
  const dbName = await input({ message: 'Database name', default: slug });
  const dbUser = await input({ message: 'Database username', default: slug });
  const dbPass = await password({ message: 'Database password', mask: '*' });

  const config: Config = {
    server,
    aapanel,
    site: { domain, root: `/www/wwwroot/${domain}` },
    database: { name: dbName, username: dbUser, password: dbPass },
    deployment: { runMigrations: true, runSeeders: false },
  };
  validate(config);
  saveConfig(config);
  ensureGitignored();
  ok(`Saved ${CONFIG_FILE} (added to .gitignore)`);
}
