/**
 * `laravel-deploy server` — manage server profiles.
 *
 * Credentials live in ~/.config/laravel-deploy/config.json and secrets.json;
 * nothing sensitive is ever printed back (SPEC §8).
 */

import { Command } from 'commander';
import { input, select, confirm, password } from '@inquirer/prompts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadGlobalConfig, saveGlobalConfig } from '../../core/config/loader.js';
import { globalConfigDir } from '../../core/config/paths.js';
import { serverProfileSchema, type ServerProfile } from '../../core/config/schema.js';
import { createSecretsStore } from '../../core/security/secrets.js';
import { emitJson, runCommand, type GlobalOptions } from '../context.js';
import { TerminalUi } from '../ui/ui.js';
import { expandHome } from '../../providers/exec/ssh.js';
import { redactOutput } from '../../utils/redact.js';

export function registerServerCommand(program: Command): void {
  const server = program.command('server').description('Manage server profiles');

  // ------------------------------------------------------------------ add
  server
    .command('add')
    .description('Add a server profile')
    .argument('[name]', 'profile name')
    .option('--json', 'machine-readable output')
    .action(async (nameArg: string | undefined, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        ui.section('Add server');

        const name =
          nameArg ??
          (await input({
            message: 'Profile name:',
            validate: (value: string) => (value.trim() === '' ? 'A name is required.' : true),
          }));

        const existing = loadGlobalConfig();
        if (existing.servers[name]) {
          const overwrite = await confirm({
            message: `Server "${name}" already exists. Overwrite?`,
            default: false,
          });
          if (!overwrite) return 1;
        }

        const host = await input({
          message: 'Host or IP:',
          validate: (value: string) => (value.trim() === '' ? 'A host is required.' : true),
        });
        const port = await input({ message: 'SSH port:', default: '22' });
        const username = await input({
          message: 'SSH username:',
          default: 'root',
          validate: (value: string) => (value.trim() === '' ? 'A username is required.' : true),
        });

        const authMethod = await select({
          message: 'Authentication method:',
          choices: [
            { name: 'SSH key (recommended)', value: 'key' },
            { name: 'SSH agent', value: 'agent' },
            { name: 'Password', value: 'password' },
          ],
        });

        let sshKey: string | undefined;
        let agent = false;
        let storedPassword: string | undefined;
        let passphrase: string | undefined;

        if (authMethod === 'key') {
          sshKey = expandHome(
            await input({ message: 'Path to the private key:', default: '~/.ssh/id_ed25519' }),
          );
          if (!fs.existsSync(sshKey)) {
            ui.warn(`Key file not found: ${sshKey}`, 'The profile was saved anyway.');
          } else {
            try {
              fs.chmodSync(sshKey, 0o600);
              ui.ok('Key permissions normalised', 'chmod 600');
            } catch {
              /* best effort */
            }
          }
        } else if (authMethod === 'password') {
          storedPassword = await password({ message: 'SSH password:' });
        } else {
          agent = true;
        }

        const usePanel = await confirm({ message: 'Is this an aaPanel server?', default: true });
        const panelDefaults = {
          timeoutMs: 30_000,
          insecureTLS: false,
          fallbackToSsh: true,
          forceSsh: false,
        };
        let aapanel: ServerProfile['aapanel'] = { ...panelDefaults, enabled: false };

        if (usePanel) {
          const panelUrl = await input({
            message: 'Panel URL:',
            default: `https://${host.trim()}:7800`,
          });
          const apiKey = await password({
            message: 'Panel API key (leave blank to use SSH fallback):',
          });
          const insecureTLS = await confirm({
            message: 'The panel uses a self-signed certificate?',
            default: true,
          });
          const forceSsh = await confirm({
            message: 'Always provision over SSH instead of the panel API?',
            default: false,
          });
          aapanel = {
            ...panelDefaults,
            enabled: true,
            url: panelUrl.trim(),
            ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
            insecureTLS,
            fallbackToSsh: true,
            forceSsh,
          };
        }

        const siteRoot = await input({ message: 'Site root base path:', default: '/www/wwwroot' });

        const profile = serverProfileSchema.parse({
          name,
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          ...(sshKey ? { sshKey } : {}),
          ...(passphrase ? { passphrase } : {}),
          agent,
          strictHostKeyChecking: true,
          siteRoot: siteRoot.trim(),
          aapanel,
        });

        saveGlobalConfig(
          { ...existing, servers: { ...existing.servers, [name]: profile } },
        );

        // Secrets go to the secrets store, never the config file.
        const secrets = createSecretsStore(path.join(globalConfigDir(), 'secrets.json'));
        if (storedPassword) secrets.set(`servers.${name}.ssh.password`, storedPassword);
        if (aapanel.apiKey) secrets.set(`servers.${name}.aapanel.apiKey`, aapanel.apiKey);
        delete (profile.aapanel as { apiKey?: string }).apiKey;
        saveGlobalConfig({ ...existing, servers: { ...existing.servers, [name]: profile } });

        ui.section('Saved');
        ui.ok(name, `${profile.host}:${profile.port} as ${profile.username}`);
        ui.info(`Profile:  ${path.join(globalConfigDir(), 'config.json')}`);
        ui.info('Next:    laravel-deploy init');
        if (flags.json) {
          emitJson({
            success: true,
            name,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            aapanel: { enabled: aapanel.enabled, mode: aapanel.apiKey ? 'api' : 'ssh' },
          });
        }
        return 0;
      });
    });

  // ----------------------------------------------------------------- list
  server
    .command('list')
    .alias('ls')
    .description('List configured servers')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        const global = loadGlobalConfig();
        const names = Object.keys(global.servers);

        if (names.length === 0) {
          ui.warn('No servers configured.', 'Add one with `laravel-deploy server add`.');
          if (flags.json) emitJson({ servers: [] });
          return 1;
        }

        ui.section('Servers');
        const rows: Array<Record<string, unknown>> = [];
        for (const name of names) {
          const profile = global.servers[name] as ServerProfile;
          const panel = profile.aapanel.enabled
            ? profile.aapanel.forceSsh || !profile.aapanel.apiKey
              ? 'ssh'
              : 'api'
            : 'off';
          ui.ok(name.padEnd(16), `${profile.host}:${profile.port} · ${profile.username} · aaPanel: ${panel}`);
          rows.push({
            name,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            siteRoot: profile.siteRoot,
            aapanel: panel,
            isDefault: global.defaultServer === name,
          });
        }
        if (global.defaultServer) {
          ui.info('');
          ui.info(`Default: ${global.defaultServer}`);
        }
        if (flags.json) emitJson({ servers: rows, default: global.defaultServer ?? null });
        return 0;
      });
    });

  // ------------------------------------------------------------------ set
  server
    .command('set')
    .description('Update a server profile field')
    .argument('<name>', 'profile name')
    .argument('<field>', 'field to set (host, port, username, sshKey, siteRoot, strictHostKeyChecking)')
    .argument('<value>', 'new value')
    .option('--json', 'machine-readable output')
    .action(async (name: string, field: string, value: string, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        const global = loadGlobalConfig();
        const profile = global.servers[name];
        if (!profile) throw new Error(`Unknown server "${name}".`);

        const allowed = new Set([
          'host',
          'port',
          'username',
          'sshKey',
          'siteRoot',
          'strictHostKeyChecking',
          'default',
        ]);
        if (!allowed.has(field)) {
          throw new Error(`Unknown field "${field}". Allowed: ${[...allowed].join(', ')}`);
        }

        if (field === 'default') {
          saveGlobalConfig({ ...global, defaultServer: value });
          ui.ok(`Default server set to ${value}`);
          if (flags.json) emitJson({ success: true, defaultServer: value });
          return 0;
        }

        const parsed =
          field === 'port'
            ? Number(value)
            : field === 'strictHostKeyChecking'
              ? value === 'true' || value === '1'
              : field === 'sshKey'
                ? expandHome(value)
                : value;

        const updated = serverProfileSchema.parse({ ...profile, [field]: parsed });
        saveGlobalConfig({ ...global, servers: { ...global.servers, [name]: updated } });
        ui.ok(`Updated ${name}.${field}`, String(parsed));
        if (flags.json) emitJson({ success: true, name, field, value: parsed });
        return 0;
      });
    });

  // ----------------------------------------------------------------- show
  server
    .command('show')
    .description('Show one server profile')
    .argument('[name]', 'profile name')
    .option('--json', 'machine-readable output')
    .action(async (nameArg: string | undefined, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        const global = loadGlobalConfig();
        const name = nameArg ?? global.defaultServer ?? Object.keys(global.servers)[0];
        if (!name) throw new Error('No server configured.');
        const profile = global.servers[name];
        if (!profile) throw new Error(`Unknown server "${name}".`);

        ui.section(name);
        ui.status('Host', `${profile.host}:${profile.port}`);
        ui.status('User', profile.username);
        ui.status('Auth', profile.sshKey ? `key (${profile.sshKey})` : profile.agent ? 'agent' : 'password');
        ui.status('Host checking', profile.strictHostKeyChecking ? 'strict' : 'disabled');
        ui.status('Site root', profile.siteRoot);
        ui.status('aaPanel', profile.aapanel.enabled ? 'enabled' : 'disabled');
        if (profile.notes) ui.note(profile.notes);
        if (flags.json) emitJson({ success: true, ...profile, password: undefined, aapanel: { ...profile.aapanel, apiKey: undefined } });
        return 0;
      });
    });

  // ---------------------------------------------------------- connection
  server
    .command('test')
    .description('Test SSH connectivity to a server')
    .argument('[name]', 'profile name')
    .option('--json', 'machine-readable output')
    .action(async (nameArg: string | undefined, flags: GlobalOptions) => {
      await runCommand(async () => {
        const ui = new TerminalUi({ color: process.env.NO_COLOR === undefined });
        const global = loadGlobalConfig();
        const name = nameArg ?? global.defaultServer ?? Object.keys(global.servers)[0];
        if (!name) throw new Error('No server configured.');
        const profile = global.servers[name];
        if (!profile) throw new Error(`Unknown server "${name}".`);

        const { SshExecutor } = await import('../../providers/exec/ssh.js');
        const executor = new SshExecutor({ profile });
        ui.section(`Connecting to ${name}`);
        try {
          const info = await executor.info();
          const result = await executor.exec('php -v 2>&1 | head -1; df -h / | tail -1', {
            allowFailure: true,
          });
          ui.ok('SSH connection', `${info.hostname} as ${info.user}`);
          ui.info(redactOutput(result.stdout).trim());
          if (flags.json) emitJson({ success: true, name, info, output: redactOutput(result.stdout) });
          return 0;
        } finally {
          await executor.close();
        }
      });
    });
}

/** `laravel-deploy secrets` — manage the secrets store. */
export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('Manage the encrypted secrets store');

  secrets
    .command('set')
    .description('Store a secret')
    .argument('<key>', 'e.g. servers.production.database.password')
    .option('--value <value>', 'value; omit to be prompted')
    .action(async (key: string, flags: GlobalOptions & { value?: string }) => {
      await runCommand(async () => {
        const store = createSecretsStore(path.join(globalConfigDir(), 'secrets.json'));
        const value = flags.value ?? (await password({ message: `Value for ${key}:` }));
        store.set(key, value);
        process.stdout.write(`Stored ${key}${store.encrypted ? ' (encrypted)' : ' (0600, not encrypted)'}\n`);
        if (!store.encrypted) {
          process.stdout.write(
            'Tip: set LARAVEL_DEPLOY_SECRET_PASSPHRASE to encrypt values at rest.\n',
          );
        }
        return 0;
      });
    });

  secrets
    .command('get')
    .description('Print a stored secret (use with care)')
    .argument('<key>', 'secret key')
    .option('--json', 'machine-readable output')
    .action(async (key: string, flags: GlobalOptions) => {
      await runCommand(async () => {
        const store = createSecretsStore(path.join(globalConfigDir(), 'secrets.json'));
        const value = store.get(key);
        if (value === undefined) throw new Error(`No such secret: ${key}`);
        if (flags.json) emitJson({ key, value });
        else process.stdout.write(`${value}\n`);
        return 0;
      });
    });

  secrets
    .command('list')
    .description('List secret keys (never values)')
    .option('--json', 'machine-readable output')
    .action(async (flags: GlobalOptions) => {
      await runCommand(async () => {
        const store = createSecretsStore(path.join(globalConfigDir(), 'secrets.json'));
        const keys = store.keys();
        if (flags.json) {
          emitJson({ keys, encrypted: store.encrypted, location: store.location });
          return 0;
        }
        process.stdout.write(`${store.location} (encrypted: ${store.encrypted ? 'yes' : 'no'})\n`);
        for (const key of keys) process.stdout.write(`  ${key}\n`);
        return 0;
      });
    });

  secrets
    .command('remove')
    .description('Delete a stored secret')
    .argument('<key>', 'secret key')
    .action(async (key: string) => {
      await runCommand(async () => {
        const store = createSecretsStore(path.join(globalConfigDir(), 'secrets.json'));
        const removed = store.remove(key);
        process.stdout.write(removed ? `Removed ${key}\n` : `No such secret: ${key}\n`);
        return removed ? 0 : 1;
      });
    });

  void os;
}