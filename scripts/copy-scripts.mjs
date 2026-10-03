import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const from = path.join(projectRoot, 'scripts');
const to = path.join(projectRoot, 'dist', 'scripts');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`Copied remote scripts -> ${path.relative(projectRoot, to)}`);