import { confirm, input, password } from '@inquirer/prompts';
import { clearCredentials, credentialsPath, loadCredentials, saveCredentials, type ServerCredentials } from '../credentials.js';
import { validateServer } from '../config.js';
import { ok, title, warn } from '../ui.js';

/** Mask a secret for display, keeping only its length visible. */
const mask = (v: string) => (v ? '*'.repeat(Math.min(v.length, 12)) : '(not set)');

function show(creds: ServerCredentials): void {
  const { server, aapanel } = creds;
  console.log(`  SSH:     ${server.username}@${server.host}:${server.port}`);
  console.log(`  Key:     ${server.sshKey}`);
  console.log(`  aaPanel: ${aapanel.url}`);
  console.log(`  API key: ${mask(aapanel.apiKey)}`);
  console.log(`\n  ${credentialsPath()}`);
}

/**
 * Store the VPS and aaPanel credentials once, globally, so `init` only has to
 * ask about the website. `--show` prints what is saved, `--forget` removes it.
 */
export async function serverCommand(opts: { show?: boolean; forget?: boolean }): Promise<void> {
  title();
  console.log('');

  if (opts.show) {
    const creds = loadCredentials();
    if (!creds) {
      warn(`No server credentials saved (${credentialsPath()})`);
      console.log('  Run `lara-deploy server` to add them.');
      return;
    }
    console.log(`Server credentials in ${credentialsPath()}:`);
    show(creds);
    return;
  }

  if (opts.forget) {
    const removed = clearCredentials();
    if (removed) ok('Server credentials removed');
    else warn('No server credentials to remove');
    return;
  }

  const existing = loadCredentials();
  if (existing) {
    console.log(`Existing credentials for ${existing.server.username}@${existing.server.host}:${existing.server.port} (${credentialsPath()})`);
    const replace = await confirm({ message: 'Replace them?', default: false });
    if (!replace) {
      ok('Kept existing server credentials');
      return;
    }
    console.log('');
  }

  const host = await input({ message: 'VPS host', required: true, default: existing?.server.host });
  const username = await input({ message: 'SSH username', default: existing?.server.username ?? 'root' });
  const port = Number(await input({ message: 'SSH port', default: String(existing?.server.port ?? 22) }));
  const sshKey = await input({ message: 'SSH private key path', default: existing?.server.sshKey ?? '~/.ssh/id_ed25519' });
  const url = await input({ message: 'aaPanel URL', default: existing?.aapanel.url ?? `https://${host}:7800` });
  const apiKey = await password({
    message: 'aaPanel API key',
    mask: '*',
    validate: (v) => (v.trim() ? true : 'Required'),
  });

  const creds: ServerCredentials = {
    server: { host, port, username, sshKey },
    aapanel: { url, apiKey },
  };
  validateServer(creds, 'server credentials');
  const file = saveCredentials(creds);
  ok(`Saved server credentials to ${file}`);
  console.log('  Run `lara-deploy init` in a Laravel project to configure a site.');
}
