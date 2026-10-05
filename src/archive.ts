import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as tar from 'tar';

/** Paths (relative to the project root) that must not be uploaded. */
export function isExcluded(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (p === '' || p === '.') return false;
  const top = p.split('/')[0]!;
  if (top === 'node_modules' || top === '.git') return true;
  if (top === '.lara-deploy.json') return true; // holds secrets
  if (top.startsWith('.env') && top !== '.env.example') return true;
  if (p.endsWith('.DS_Store')) return true;
  if (p === 'public/storage' || p === 'public/hot') return true;
  // Runtime data lives on the server; don't overwrite it with local copies.
  const runtime = [
    'storage/logs',
    'storage/app/public',
    'storage/framework/cache',
    'storage/framework/sessions',
    'storage/framework/views',
    'storage/framework/testing',
  ];
  if (runtime.some((r) => p.startsWith(r + '/'))) return true;
  // Locally cached config/routes would be wrong on the server.
  if (/^bootstrap\/cache\/.+\.php$/.test(p)) return true;
  return false;
}

export async function createArchive(projectDir: string): Promise<string> {
  const file = path.join(os.tmpdir(), `lara-deploy-${process.pid}.tar.gz`);
  await tar.c({ gzip: true, file, cwd: projectDir, portable: true, filter: (p) => !isExcluded(p) }, ['.']);
  return file;
}

export function removeArchive(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * Run a fixed local command (no user input is interpolated).
 *
 * `shell: true` is deliberate and required on Windows, where `composer` and `npm`
 * are `.bat`/`.cmd` shims that CreateProcess will not launch on its own.
 * `windowsHide` stops a console window flashing for every spawned build.
 */
export function runLocal(command: string, verbose: boolean): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: process.cwd(),
      shell: true,
      windowsHide: true,
      stdio: verbose ? 'inherit' : 'pipe',
    });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: 1, output: e.message }));
    child.on('close', (code) => {
      const status = code ?? 1;
      // cmd.exe reports a missing executable as 9009 and prints nothing useful;
      // say which command was missing instead of a bare "build failed".
      if (status === 9009 && !verbose) {
        resolve({ code: status, output: `'${command.split(' ')[0]}' was not found on PATH.` });
        return;
      }
      resolve({ code: status, output });
    });
  });
}
