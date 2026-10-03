/**
 * Release packaging.
 *
 * Defaults exclude VCS metadata, dependencies that get reinstalled on the
 * server, and every flavour of .env — while deliberately keeping vendor/,
 * public/build/ and the lockfiles, which the deployment strategy needs.
 * User config can add to both lists (SPEC §15).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { AppError } from '../core/errors/errors.js';
import { formatBytes } from '../utils/ids.js';
import type { PackagingConfig } from '../core/config/schema.js';

/** Never shipped: VCS metadata, deps, or secrets. */
export const DEFAULT_EXCLUDES = [
  '.git',
  '.git/**',
  '.github',
  '.svn',
  '.hg',
  'node_modules',
  'node_modules/**',
  '.env',
  '.env.*',
  // ...but the example file carries no secrets and is needed on the server.
  '!.env.example',
  'storage/logs/**',
  'storage/framework/cache/**',
  'storage/framework/sessions/**',
  'storage/framework/views/**',
  'storage/debugbar/**',
  '.phpunit.cache',
  '.php-cs-fixer.cache',
  '.idea',
  '.vscode',
  '*.log',
  '*.tsbuildinfo',
  'tests',
  'tests/**',
  '.DS_Store',
  // Windows Explorer / NTFS artefacts, which would otherwise ship in the release.
  'Thumbs.db',
  'desktop.ini',
  'ehthumbs.db',
] as const;

/** Always shipped when the strategy needs them. */
export const DEFAULT_INCLUDES = [
  'vendor/**',
  'public/build/**',
  'composer.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'artisan',
  '.env.example',
] as const;

export interface PackagingResult {
  archivePath: string;
  bytes: number;
  humanSize: string;
  fileCount: number;
  durationMs: number;
  format: 'tar.gz' | 'zip';
}

export interface PackagerOptions {
  projectRoot: string;
  config: PackagingConfig;
  /** Scratch directory; defaults to the OS temp dir. */
  tempDir?: string;
  /** Report progress as entries are added. */
  onProgress?: (fileCount: number) => void;
}

/**
 * Merge user patterns with the defaults.
 * An entry starting with `!` re-includes a path that a default excluded, and is
 * always evaluated after every exclusion, so it always wins.
 */
export function resolveExclusions(config: PackagingConfig): string[] {
  const excludes = new Set<string>(DEFAULT_EXCLUDES.filter((p) => !p.startsWith('!')));
  for (const pattern of config.exclude) excludes.add(pattern);
  for (const pattern of config.include) excludes.delete(pattern);

  // Negations always sort first, so an explicit include beats every exclusion.
  const includes = new Set<string>(
    DEFAULT_EXCLUDES.filter((p) => p.startsWith('!')).map((p) => p.slice(1)),
  );
  for (const pattern of config.include) includes.add(pattern.replace(/^!/, ''));

  return [...[...includes].map((p) => `!${p}`), ...excludes];
}

/** True when a relative path should be skipped. */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const target = normalise(relativePath);

  // Negations first: an explicit re-include always wins.
  for (const pattern of patterns) {
    if (!pattern.startsWith('!')) continue;
    const raw = pattern.slice(1);
    if (matches(target, raw) || matchesPrefix(target, raw)) return false;
  }

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (matches(target, pattern) || matchesPrefix(target, pattern)) return true;
  }
  return false;
}

function normalise(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

/**
 * A pattern like `storage` or `node_modules` names a directory: it matches the
 * directory itself and everything beneath it.
 */
function matchesPrefix(target: string, pattern: string): boolean {
  if (pattern.includes('*')) return false;
  const clean = pattern.replace(/\/$/, '');
  return target === clean || target.startsWith(`${clean}/`);
}

/** Glob matching for the subset of patterns we support. */
function matches(target: string, pattern: string): boolean {
  const p = pattern.replace(/\/$/, '');
  if (p === '' || p === '**') return true;
  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3);
    return target === prefix || target.startsWith(`${prefix}/`);
  }
  // `*.log` should also match `storage/logs/laravel.log`? No — only basename
  // matching for extension patterns, which is what users expect from .gitignore
  // style config. A leading path component means a full path match.
  if (p.includes('/')) {
    const regex = new RegExp(`^${globToRegex(p)}$`);
    return regex.test(target);
  }
  const regex = new RegExp(`(^|/)${globToRegex(p)}$`);
  return regex.test(target);
}

function globToRegex(pattern: string): string {
  return pattern
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.'),
    )
    .join('.*');
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\*').replace(/\?/g, '.');
}

export class Packager {
  constructor(private readonly options: PackagerOptions) {}

  /** Build the archive. */
  async create(releaseId: string): Promise<PackagingResult> {
    const format = this.options.config.format;
    const tempDir = this.options.tempDir ?? path.join(os.tmpdir(), 'laravel-deploy');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const archivePath = path.join(tempDir, `${releaseId}.${format}`);

    // Remove any stale file so fastPut cannot resume into a partial archive.
    await fs.promises.rm(archivePath, { force: true });

    const started = Date.now();
    const patterns = resolveExclusions(this.options.config);

    const output = fs.createWriteStream(archivePath);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: this.options.config.level } });
    const pipeline = streamPipeline(archive, output);

    let fileCount = 0;
    const walker = walk(this.options.projectRoot, '', patterns);

    for await (const relative of walker) {
      const absolute = path.join(this.options.projectRoot, relative);
      const stat = await fs.promises.lstat(absolute);

      if (stat.isSymbolicLink()) {
        // Ship symlinks as symlinks so shared storage links survive the trip.
        const target = await fs.promises.readlink(absolute);
        archive.symlink(target, relative);
        fileCount += 1;
      } else if (stat.isDirectory()) {
        archive.directory(relative, relative);
      } else {
        archive.file(absolute, { name: relative });
        fileCount += 1;
      }
      this.options.onProgress?.(fileCount);
    }

    await archive.finalize();
    await pipeline;

    const stat = await fs.promises.stat(archivePath);
    if (stat.size === 0) {
      throw new AppError('The release archive is empty.', {
        remediation: [
          'Check that .lar-deploy.json excludes are not excluding the whole project.',
        ],
      });
    }

    return {
      archivePath,
      bytes: stat.size,
      humanSize: formatBytes(stat.size),
      fileCount,
      durationMs: Date.now() - started,
      format,
    };
  }
}

/** Depth-first walk honouring exclusions, skipping heavy directories early. */
async function* walk(
  root: string,
  prefix: string,
  patterns: readonly string[],
): AsyncGenerator<string> {
  const dir = path.join(root, prefix);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isExcluded(relative, patterns)) continue;
    if (entry.isDirectory()) {
      yield relative;
      yield* walk(root, relative, patterns);
    } else {
      yield relative;
    }
  }
}