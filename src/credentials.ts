import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateServer, type Config } from './config.js';
import { DeployError } from './ui.js';

/** The server-side half of the config: the VPS and the aaPanel panel. */
export type ServerCredentials = Pick<Config, 'server' | 'aapanel'>;

/**
 * Where the one-time server credentials live. Deliberately outside the project,
 * so every Laravel app on this machine shares them.
 */
export function credentialsPath(): string {
  if (os.platform() === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'lara-deploy', 'credentials.json');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'lara-deploy', 'credentials.json');
}

/** Read the saved credentials, or undefined when none have been stored yet. */
export function loadCredentials(): ServerCredentials | undefined {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return undefined;
  let raw: { server?: Partial<Config['server']>; aapanel?: Partial<Config['aapanel']> };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof raw;
  } catch {
    throw new DeployError(`Saved server credentials are not valid JSON: ${file}`, ['Run `lara-deploy server` to replace them.']);
  }
  const creds: ServerCredentials = {
    server: {
      host: raw.server?.host ?? '',
      port: Number(raw.server?.port) || 22,
      username: raw.server?.username ?? '',
      sshKey: raw.server?.sshKey ?? '',
    },
    aapanel: { url: raw.aapanel?.url ?? '', apiKey: raw.aapanel?.apiKey ?? '' },
  };
  validateServer(creds, file);
  return creds;
}

/** Write the credentials with owner-only permissions. Returns the file path. */
export function saveCredentials(creds: ServerCredentials): string {
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Delete the saved credentials. Returns true when a file was removed. */
export function clearCredentials(): boolean {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
