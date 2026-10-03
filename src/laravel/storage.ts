/**
 * Storage layout.
 *
 * The release's `storage/` is a symlink to `shared/storage/`, and
 * `public/storage` points at `shared/storage/app/public`. Deployments must
 * never destroy uploaded files, so every storage path used by a release is
 * computed here and verified after it is created (SPEC §13, §18).
 */

export interface StorageLayout {
  /** Absolute shared storage directory. */
  sharedStorage: string;
  /** Absolute link path inside a release. */
  releaseStorageLink: string;
  /** Absolute public storage link inside a release. */
  publicStorageLink: string;
  /** Target the public link must resolve to. */
  publicStorageTarget: string;
  /** Subdirectories guaranteed to exist in shared storage. */
  requiredDirs: string[];
}

export function planStorageLayout(siteRoot: string): StorageLayout {
  const shared = `${siteRoot}/shared/storage`;
  return {
    sharedStorage: shared,
    releaseStorageLink: `${siteRoot}/current/storage`,
    publicStorageLink: `${siteRoot}/current/public/storage`,
    publicStorageTarget: `${shared}/app/public`,
    requiredDirs: [
      `${shared}/app/public`,
      `${shared}/app/private`,
      `${shared}/framework/cache/data`,
      `${shared}/framework/sessions`,
      `${shared}/framework/views`,
      `${shared}/logs`,
    ],
  };
}

/** Release-relative paths, for the verification step (SPEC §17). */
export function requiredReleasePaths(options: {
  hasFrontendBuild: boolean;
  hasConfigDir: boolean;
}): string[] {
  const required = [
    'artisan',
    'composer.json',
    'vendor/autoload.php',
    'bootstrap/app.php',
    'public/index.php',
  ];
  if (options.hasConfigDir) required.push('config/app.php');
  if (options.hasFrontendBuild) required.push('public/build');
  return required;
}

/**
 * Verify a symlink target.
 *
 * `linkPath` is the link itself; `expectedTarget` is what it should resolve to
 * (absolute). A dangling link, a link to the wrong place, or a real directory
 * where a link belongs are all failures.
 */
export interface SymlinkCheckInput {
  exists: boolean;
  isSymlink: boolean;
  /** Resolved absolute target; empty when the link is broken. */
  resolvesTo: string;
  expectedTarget: string;
}

export interface SymlinkCheckResult {
  ok: boolean;
  /** What is currently wrong, or null. */
  problem: 'missing' | 'not-a-symlink' | 'broken' | 'wrong-target' | null;
  message: string;
}

export function verifySymlink(input: SymlinkCheckInput): SymlinkCheckResult {
  if (!input.exists) {
    return {
      ok: false,
      problem: 'missing',
      message: `Missing: ${input.expectedTarget}`,
    };
  }
  if (!input.isSymlink) {
    return {
      ok: false,
      problem: 'not-a-symlink',
      message: 'Exists but is a real directory, not a symlink.',
    };
  }
  if (input.resolvesTo === '') {
    return { ok: false, problem: 'broken', message: 'Symlink is broken (dangling).' };
  }
  if (input.resolvesTo !== input.expectedTarget) {
    return {
      ok: false,
      problem: 'wrong-target',
      message: `Points at ${input.resolvesTo}, expected ${input.expectedTarget}`,
    };
  }
  return { ok: true, problem: null, message: `OK -> ${input.resolvesTo}` };
}

/** Lines printed by `laravel-deploy storage status`. */
export interface StorageStatusRow {
  label: string;
  ok: boolean;
  detail: string;
}

export function storageStatusRows(
  layout: StorageLayout,
  checks: {
    sharedExists: boolean;
    publicStorage: SymlinkCheckResult;
    releaseStorage: SymlinkCheckResult;
    writable: boolean;
  },
): StorageStatusRow[] {
  const rows: StorageStatusRow[] = [
    {
      label: 'shared/storage exists',
      ok: checks.sharedExists,
      detail: checks.sharedExists ? layout.sharedStorage : `Missing: ${layout.sharedStorage}`,
    },
    {
      label: 'public/storage',
      ok: checks.publicStorage.ok,
      detail: checks.publicStorage.message,
    },
    {
      label: 'current/storage',
      ok: checks.releaseStorage.ok,
      detail: checks.releaseStorage.message,
    },
    {
      label: 'storage writable',
      ok: checks.writable,
      detail: checks.writable ? 'writable' : 'not writable by the web user',
    },
  ];
  return rows;
}