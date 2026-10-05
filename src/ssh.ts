import fs from 'node:fs';
import { Client } from 'ssh2';
import { resolveKeyPath, type Config } from './config.js';
import { DeployError, debug } from './ui.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Quote a value for safe use inside a POSIX shell command. */
export const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export class Ssh {
  private constructor(private client: Client) {}

  static connect(server: Config['server']): Promise<Ssh> {
    const keyFile = resolveKeyPath(server.sshKey);
    if (!fs.existsSync(keyFile)) {
      throw new DeployError(`SSH key not found: ${keyFile}`, ['Check server.sshKey in .lara-deploy.json.']);
    }
    const client = new Client();
    return new Promise((resolve, reject) => {
      client
        .on('ready', () => resolve(new Ssh(client)))
        .on('error', (e) =>
          reject(
            new DeployError(`SSH connection failed: ${e.message}`, [
              `${server.username}@${server.host}:${server.port} using ${keyFile}`,
            ]),
          ),
        )
        .connect({
          host: server.host,
          port: server.port,
          username: server.username,
          privateKey: fs.readFileSync(keyFile),
          readyTimeout: 20_000,
        });
    });
  }

  exec(command: string): Promise<ExecResult> {
    debug(`$ ${command}`);
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => (stdout += d));
        stream.stderr.on('data', (d: Buffer) => (stderr += d));
        stream.on('close', (code: number | null) => {
          if (stdout) debug(stdout);
          if (stderr) debug(stderr);
          resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    });
  }

  /** Run a command and throw a DeployError if it fails. */
  async run(command: string, failMessage: string, shownCommand = command): Promise<ExecResult> {
    const r = await this.exec(command);
    if (r.code !== 0) {
      const out = (r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n');
      throw new DeployError(failMessage, ['', 'Command:', shownCommand, '', ...(out ? ['Output:', out] : [])]);
    }
    return r;
  }

  upload(localFile: string, remoteFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localFile, remoteFile, (e) => (e ? reject(e) : resolve()));
      });
    });
  }

  writeFile(content: string, remoteFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.writeFile(remoteFile, content, { mode: 0o640 }, (e) => (e ? reject(e) : resolve()));
      });
    });
  }

  close(): void {
    this.client.end();
  }
}
