# laravel-deploy

**"I have a Laravel project. I type `laravel-deploy deploy`. The system takes care of the rest."**

A production-grade CLI that deploys Laravel applications to VPS servers managed by **aaPanel**. It replaces the manual checklist — create website, create database, configure `.env`, upload, migrate, optimize, set permissions — with one idempotent command.

```bash
laravel-deploy deploy
```

That single command detects the project, provisions missing infrastructure, builds, uploads an immutable release, configures it, migrates, optimizes, activates, verifies, and cleans up. Running it twice never creates a duplicate website, database, cron entry or worker.

---

## 1. What the CLI does

The deployment lifecycle:

```
Detect project → Load config → Validate server → Detect aaPanel
   → Provision website → Provision database → Generate secrets
   → Build → Package → Upload → Prepare release → Configure .env
   → Configure storage → Migrations → Seeders → Optimize
   → Queue / Scheduler → Health-check candidate → Activate
   → Restart workers → Verify → Cleanup → Report
```

Key design commitments:

| Commitment | How it is kept |
| --- | --- |
| **Idempotent** | Existence is checked before every create. Re-running changes nothing. |
| **Atomic** | Releases are immutable; `current` is a symlink switched with `rename(2)`. |
| **Never destroys live data** | `storage/` and `.env` live in `shared/`, outside any release. |
| **Rollback is safe** | Application code rolls back; the database never does implicitly. |
| **Secrets stay secret** | Passwords travel over stdin heredocs, never argv. Nothing is logged. |
| **Destructive = explicit** | `migrate:fresh`, `db:wipe`, `chmod 777` require typed confirmation. |

---

## 2. Installation

```bash
npm install -g laravel-deploy
laravel-deploy --version
```

Requires **Node.js 20+**. No Docker, no database, no dashboard.

From source:

```bash
git clone <your-fork> laravel-deploy && cd laravel-deploy
npm install
npm run build
npm link          # exposes `laravel-deploy` on your PATH
npm test
```

### Client platform support

The CLI runs on **macOS, Linux and Windows** (PowerShell, cmd.exe and WSL). The
deployment *target* is always a POSIX server, so only the client side is
platform-aware.

| | macOS / Linux | Windows |
| --- | --- | --- |
| Config directory | `~/.config/laravel-deploy` | `%APPDATA%\laravel-deploy` |
| Command lookup | `PATH` walk | `PATH` walk + `PATHEXT` (so `.CMD` shims resolve) |
| Local build shell | `/bin/sh` | `cmd.exe` |
| File permissions | `chmod 600` on secrets | NTFS ACLs (no POSIX mode bit to set) |

An existing `~/.config/laravel-deploy` on Windows is copied to `%APPDATA%` on
first run and left in place as a backup. Override the location at any time with
`LARAVEL_DEPLOY_CONFIG_DIR`.

**Custom build commands are passed to your local shell verbatim.** The generated
steps (`composer install`, `npm ci`, …) work everywhere, but anything you write
in `deployment.buildCommands` or `deployment.extraBuildCommands` must use your
shell's syntax — `&&`, pipes and redirection differ between `sh` and `cmd.exe`.
Keep them to plain command lines if you want one config to work on every
platform.

---

## 3. First-time setup

Two steps: register your server, then generate a project config.

```bash
$ laravel-deploy server add

? Profile name: production
? Host or IP: 123.123.123.123
? SSH port: 22
? SSH username: root
? Authentication method: SSH key (recommended)
? Path to the private key: ~/.ssh/id_ed25519
? Is this an aaPanel server? Yes
? Panel URL: https://123.123.123.123:7800
? Panel API key (leave blank to use SSH fallback): **********
? The panel uses a self-signed certificate? Yes
? Always provision over SSH instead of the panel API? No
? Site root base path: /www/wwwroot

◆ Saved

✓ production            123.123.123.123:22 · root · aaPanel: api
```

Verify connectivity before going further:

```bash
$ laravel-deploy server test production
◆ Connecting to production
✓ SSH connection               srv1 as root
Linux 6.1.0-18-amd64 · PHP 8.3.12
```

Then, inside your Laravel project:

```bash
$ cd ~/projects/client-site
$ laravel-deploy init
```

`init` asks only for what it cannot detect, then writes a reusable `.laravel-deploy.json`.

---

## 4. Example project configuration

`.laravel-deploy.json` — **never put secrets here**:

```jsonc
{
  "server": "production",
  "site": {
    "domain": "example.com",
    "documentRootStrategy": "public"
  },
  "deployment": {
    "build": true,
    "composer": true,
    "migrations": true,
    "seeders": false,
    "optimize": true,
    "healthCheck": true,
    "backupDatabaseBeforeMigration": true,
    "keepReleases": 5
  },
  "database": {
    "driver": "mysql",
    "createIfMissing": true,
    "name": "client_site",
    "username": "client_site"
  },
  "queue": { "enabled": true, "workers": 2, "connection": "database" },
  "scheduler": { "enabled": true },
  "ssl": { "enabled": true, "provider": "letsencrypt" },
  "packaging": { "format": "tar.gz" }
}
```

Comments are allowed. Every section has defaults, so only `server` and `site.domain` are genuinely required.

This file is meant to be committed, so it is treated as untrusted input. Values that
end up in a remote command are validated rather than escaped after the fact — for
example `queue.processName` must be a plain supervisor program name (letters,
digits, dot, underscore, dash), because it is passed to `supervisorctl` on the
server.

### Release archive format

`packaging.format` accepts `tar.gz` (default) or `zip`. The archive name, the
bytes it contains, and the tool the server extracts it with all follow this
one setting — a mismatch fails on the server after the build and upload, not
locally.

`zip` requires `unzip` on the server. `prepare-release.sh` checks for it before
touching anything and tells you how to install it if it is missing:

```bash
# aaPanel / CentOS
yum install -y unzip
# aaPanel / Ubuntu
apt-get install -y unzip
```

`tar.gz` has no such dependency and is the safer default.

### When a deploy breaks production

Two settings decide what happens after a release goes live.

`deployment.rollbackOnHealthFailure` (default `true`). After the symlink switch
and the settle delay, the live site is health-checked. If it comes back
`UNHEALTHY`, the previous release is activated again — and the deployment still
exits non-zero, because this deployment is what broke it and a CI pipeline must
not read it as a green build. Set it to `false` to leave the failed release in
place and be told to run `laravel-deploy rollback` by hand.

A rollback needs a previous release to go back to. On a first deploy, or in
`legacy-root-copy` mode (which has no symlink to move), the CLI says so and
reports the failed release as still live.

`queue.restartTimeoutSeconds` (default `15`). `supervisorctl restart` exits 0 as
soon as it has *asked* for a restart — a worker that dies on boot still counts as
a success. The deploy polls until every program reports `RUNNING` and warns if
they do not, so a silently dead queue is caught at deploy time rather than by a
missing job.

`permissions.chmod777` (default `false`) is an escape hatch for panels whose
PHP-FPM user cannot be detected. It makes the whole release world-writable, which
lets any local user and any other PHP application on the box read your `.env`
and write your code. It is never silent: the deploy prints the warning before
applying anything.

### Environment-specific overrides

```bash
laravel-deploy deploy --env staging
```

Reads `.laravel-deploy.json`, then overlays `.laravel-deploy.staging.json`.

---

## 5. Server configuration

Profiles live in `~/.config/laravel-deploy/config.json` (mode `0600`).

```jsonc
{
  "defaultServer": "production",
  "servers": {
    "production": {
      "host": "123.123.123.123",
      "port": 22,
      "username": "root",
      "sshKey": "~/.ssh/id_ed25519",
      "siteRoot": "/www/wwwroot",
      "strictHostKeyChecking": true,
      "knownHosts": "~/.ssh/known_hosts",
      "aapanel": {
        "enabled": true,
        "url": "https://123.123.123.123:7800",
        "insecureTLS": true,
        "fallbackToSsh": true,
        "forceSsh": false
      }
    }
  }
}
```

**Prefer SSH keys.** Password auth works but is discouraged. With no API key, the adapter falls back to driving the panel over SSH (`bt` CLI) — provisioning still works, just slower.

### Host key verification

With `strictHostKeyChecking: true` (the default) the server's host key is
verified against your `known_hosts` file before any command runs, on **both**
the SSH and SFTP connections. Plain entries, `host,alias` lists, `*.wildcard`
patterns, hashed entries from `ssh-keygen -H`, and `@revoked` markers are all
understood.

The CLI does **not** trust a key it has not seen before. Trust a server once:

```bash
ssh-keyscan -p 22 123.123.123.123 >> ~/.ssh/known_hosts
```

If the host is missing from the file, the deployment stops before connecting,
with the `ssh-keyscan` command you need in the error. Verify it first — that is
the point of the check:

```bash
ssh-keyscan -p 22 123.123.123.123 | ssh-keygen -lf -
```

Set `knownHosts` to use a different file, or `strictHostKeyChecking: false` to
accept any key (this is the only supported way to skip verification, and it
disables MITM protection for both connections).

> **Behaviour change.** Earlier versions set no `hostVerifier` at all, and ssh2
> auto-accepts any key in that case — so the default was effectively
> *unverified* despite the setting. If a deployment starts failing with
> `cannot be verified`, the server's key is not in your `known_hosts` yet: run
> the `ssh-keyscan` above rather than disabling the check.

Secrets (SSH passwords, panel API keys, generated DB passwords) go to `~/.config/laravel-deploy/secrets.json`:

```bash
laravel-deploy secrets set servers.production.database.password
laravel-deploy secrets list          # keys only, never values
```

Set `LARAVEL_DEPLOY_SECRET_PASSPHRASE` to encrypt the file at rest with AES-256-GCM.

---

## 6. First deployment

```bash
$ laravel-deploy deploy

◆ Project
  main @ a1b2c3d (uncommitted changes)

◆ Server
✓ SSH connection established        srv1 as root

◆ Infrastructure
✓ aaPanel connected                 API
→ Created website                   example.com
→ Document root updated             /www/wwwroot/example.com/current/public
→ Created database                  client_site
→ Enabled SSL                       example.com

◆ Build
→ composer install --no-dev --optimize-autoloader --no-interaction --no-progress
✓ composer install                  14.2s
→ npm ci
✓ install dependencies              3.1s
→ npm run build
✓ build frontend                    6.8s

◆ Package
✓ Release packaged                  38.4 MB, 1247 entries

◆ Upload
✓ Uploaded 38.4 MB (1 attempt)

◆ Release
✓ Release extracted                 /www/wwwroot/example.com/releases/20261003-103210
✓ storage linked                    public/storage -> shared/storage/app/public
✓ Permissions applied               www:www

◆ Database
✓ Backup created: /www/wwwroot/example.com/deploy-backups/client_site-20261003-103210.sql.gz (2.1 MB)

◆ Database
→ php artisan migrate --force
✓ migrate

◆ Optimize
→ php artisan optimize:clear
✓ optimize:clear
→ php artisan optimize
✓ optimize

◆ Workers
✓ Worker programs already correct
✓ Scheduler cron entry installed

◆ Verification
✓ Laravel
✓ Database
✓ Storage
✓ Queue
✓ Scheduler

◆ Cleanup
→ Upload artifacts removed
✓ Removed 1 old release(s)          20260930-091200

Deployment successful
──────────────────────
Deployment: DEPLOY-20261003-103210-A1B2
Release:    20261003-103210-a1b2c3d
Domain:     example.com
Server:     production
Git:        a1b2c3d
Backup:     /www/wwwroot/example.com/deploy-backups/client_site-20261003-103210.sql.gz
Duration:   2m 14s
Health:     HEALTHY
```

---

## 7. Subsequent deployments

Same command. Infrastructure is verified and reused; nothing is recreated.

```bash
$ laravel-deploy deploy
...
◆ Infrastructure
✓ aaPanel connected                 API
✓ Website exists                    example.com
✓ Document root updated             /www/wwwroot/example.com/current/public
✓ SSL enabled                       example.com
...
```

If a failed deploy left a lock behind, you are told exactly who holds it:

```
✗ A deployment is already running for this site.

  Deployment ID: DEPLOY-20261003-103210-A1B2
  Started:       2026-10-03 10:32:10
  Host:          ci-runner-3
  User:          root
```

Break it deliberately with `laravel-deploy deploy --force-unlock` (asks for confirmation).

---

## 8. Status

```bash
$ laravel-deploy status

◆ Application
✓ Laravel detected              Laravel ^11.0
✓ Domain configured             example.com

◆ Server
✓ PHP                           PHP 8.3.12
✓ Composer                      Composer 2.7.7
✓ Disk free                     18.4 GB available on /
✓ Memory free                   3.2 GB available

◆ Database
✓ database reachable
✓ storage                       shared storage linked and writable
✓ Queue                         2/2 workers running
✓ Scheduler                     cron entry installed

◆ Deployment
✓ current release               20261003-103210-a1b2c3d
✓ releases on disk              5 release(s): 20261003-103210-a1b2c3d, …

◆ Overall
✓ Overall: HEALTHY
```

Exit code is `1` when unhealthy, so CI can gate on it.

---

## 9. Doctor

`doctor` goes deeper, and is the first thing to run when something is broken:

```bash
$ laravel-deploy doctor

◆ Diagnosis
✓ site root                     /www/wwwroot/example.com
✗ current symlink               current points at /www/wwwroot/example.com/releases/2026…
✓ deployment lock               no stale lock
✗ shared storage                missing shared storage directory
  → Run `laravel-deploy storage repair`.
✗ server .env                   missing or empty
  → Set env.strategy to "generate" or upload a template.
✗ document root                 root is /www/wwwroot/example.com, expected /www/wwwroot/example.com/current/public
⚠ laravel caches                caches are stale
  → Run `laravel-deploy optimize`.
✗ release 20261003-103210       incomplete (missing artisan or vendor)
  → Remove it: rm -rf /www/wwwroot/example.com/releases/20261003-103210

◆ Overall
✗ Overall: UNHEALTHY
```

---

## 10. Migrations

```bash
laravel-deploy migrate                    # php artisan migrate --force
laravel-deploy migrate:status
laravel-deploy migrate:rollback --step 1
laravel-deploy migrate:refresh            # destructive
```

Destructive operations against production require a **typed domain confirmation**:

```bash
$ laravel-deploy migrate:fresh

◆ Confirm
  Database: client_site
  Environment: production
  Pending migrations: 12
  Release: current
⚠ php artisan migrate:fresh --force destroys all data in this database.
? Type the domain name (example.com) to confirm: example.com
```

You cannot get here by accident:

```bash
$ laravel-deploy artisan migrate:fresh
✗ MissingCredentialError: Refusing to run a destructive command without confirmation
  → Pass --confirm-production to acknowledge that this destroys data.
```

`laravel-deploy migrate:fresh --confirm-production` is the deliberate path. The deploy pipeline itself can *never* produce `migrate:fresh` — it is asserted in code and in the tests.

---

## 11. Seeders

**Seeders never run by default in production.** Ever.

```bash
laravel-deploy deploy --seed      # opt in for one deploy
laravel-deploy deploy --no-seed   # force off, overriding config
laravel-deploy seed               # Database\Seeders\DatabaseSeeder
laravel-deploy seed App\Seeders\AdminSeeder
```

Enable permanently via `"seeders": { "enabled": true }`. `migrate:fresh --seed` is never generated automatically.

---

## 12. Rollback

```bash
$ laravel-deploy rollback

◆ Rollback
  Current:  20261003-103210-a1b2c3d
  Target:   20261003-102500-9f8e7d6
  Releases: 20261003-103210-a1b2c3d, 20261003-102500-9f8e7d6, …

◆ Confirm
⚠ This will switch the live application back one release.
⚠ The database will NOT be rolled back.
? Switch to 20261003-102500-9f8e7d6? Yes

◆ Result
✓ Application release rolled back.   20261003-102500-9f8e7d6
⚠ Database was NOT rolled back.
```

**Read that warning.** Application code and database schema are separate concerns. Rolling back code without rolling back the schema (or the reverse) is how outages are made. If the new release required a migration, revert it explicitly:

```bash
laravel-deploy migrate:rollback --step 1
```

---

## 13. Queue workers

```bash
laravel-deploy queue install    # write/update supervisor programs
laravel-deploy queue status
laravel-deploy queue restart
laravel-deploy queue logs --follow
```

Programs are named deterministically (`laravel-client-site-worker`) and tagged:

```ini
# managed-by: laravel-deploy
[program:laravel-client-site-worker]
command=php artisan queue:work --queue=database
directory=/www/wwwroot/example.com/current
```

Because `directory` is `current`, a restart follows the symlink onto the new release. Only *your* programs are touched — an unchanged program is not restarted, and `laravel-deploy queue install` refuses to delete a definition it did not write.

---

## 14. Scheduler

```bash
laravel-deploy scheduler install
laravel-deploy scheduler status
laravel-deploy scheduler remove
```

Installs exactly one marker-tagged entry:

```cron
# laravel-deploy * * * * * cd '/www/wwwroot/example.com/current' && php artisan schedule:run
```

Idempotent: a second install is a no-op, and `@reboot /usr/local/bin/backup.sh` and your other cron entries are preserved untouched.

---

## 15. SSL

```json
{ "ssl": { "enabled": true, "provider": "letsencrypt" } }
```

```bash
laravel-deploy deploy --force-unlock     # unrelated
laravel-deploy domain check              # DNS + reachability + TLS
```

SSL is reported as enabled only when the HTTPS probe actually passes. If DNS is wrong, you are told so rather than getting a green tick:

```
✗ dns      example.com does not resolve (getaddrinfo ENOTFOUND)
  → Add an A record for example.com pointing at the server IP.
```

The CLI does not touch DNS. That would be a separate, explicit integration.

---

## 16. Legacy deployment mode

Your existing aaPanel sites may use `domain/main/` with `public/` copied to the root and a rewritten `index.php`. That structure is supported:

```json
{ "site": { "domain": "example.com", "documentRootStrategy": "legacy-root-copy" } }
```

The CLI then extracts into `main/`, copies public assets, generates an `index.php` that requires `../main/vendor/autoload.php`, and creates the storage symlink — without clobbering `.user.ini`, `.well-known` or other root files.

The default is the clean model, which is what you want long-term:

```
/www/wwwroot/example.com/
├── current -> releases/20261003-103210-a1b2c3d/   # atomic symlink
├── releases/
│   ├── 20261003-103210-a1b2c3d/
│   └── 20261003-102500-9f8e7d6/
├── shared/                     # survives every deploy
│   ├── .env
│   └── storage/                # your uploads live here
└── deploy-backups/
```

The web server serves `current/public`. Because `storage` is a symlink into `shared/storage`, **deployed uploads are never destroyed**.

---

## 17. Security

| Rule | Implementation |
| --- | --- |
| No secrets in logs | Every record passes through `redact()` before it is written. |
| No passwords on command lines | MySQL credentials are written to a temp `my.cnf` over `stdin` with `umask 077`, then `rm`'d via `trap`. Never `-ppassword`. |
| Local `.env` never uploaded | Default `env.strategy` is `preserve`. The server `.env` is authoritative. |
| Shell injection | Every untrusted value goes through POSIX quoting (`q()`). Hostnames, paths and SQL identifiers are validated before use. |
| Least privilege | Code is owned by `root` and not writable by the web user; only `storage/` and `bootstrap/cache` are group-writable (0775). Never `chmod 777` unless you explicitly force it. |
| Deployment locking | A remote lock with an atomic `mkdir` prevents concurrent deploys. |
| Host key checking | Strict by default; unknown hosts are refused. |

Verify:

```bash
laravel-deploy secrets list       # keys only
laravel-deploy logs deploy        # redacted debug log
```

---

## 18. Troubleshooting

**"No deployment configuration found"**
Run `laravel-deploy init` in the project root, or pass `--config <path>`.

**"Application requires PHP >= 8.3 but the server has PHP 8.2"**
The deploy stops before building. Set the version in aaPanel, or `site.phpVersion`. `--force` overrides, but you usually should not.

**"The candidate release failed its health check and was not activated"**
Working as intended: the new release was rejected *before* going live. The old one is untouched. Read the failing check, or `laravel-deploy logs laravel`.

**Migration failed**
```bash
laravel-deploy logs laravel
laravel-deploy migrate:status
```
The live release was not changed, and the pre-migration backup is printed in the failure summary.

**Upload keeps failing**
```bash
laravel-deploy deploy --dry-run    # what would it do?
```
Uploads retry three times with backoff, then fail loudly. Check disk space on the server.

**Site shows 500 after deploy**
```bash
laravel-deploy status
laravel-deploy rollback
```

**A stale lock blocks you**
```bash
laravel-deploy deploy --force-unlock
```

---

## 19. Architecture

```
src/
├── cli/            # commander wiring, UI, thin commands
├── core/
│   ├── config/     # Zod schema, layered loading, paths
│   ├── deployment/ # orchestrator, state machine, plan, git
│   ├── release/    # layout, manifest, lock, retention
│   ├── health/     # layered health checks
│   └── security/   # secrets store
├── providers/      # exec (local/ssh), sftp, aapanel, mysql,
│                   # supervisor, cron, webserver
├── laravel/        # detector, artisan, migrations, seeders, cache,
│                   # storage, workers, env
├── build/          # composer + frontend build planning
├── packaging/      # archive creation and exclusions
└── utils/          # shell quoting, redaction, retry, ids, logging
scripts/            # remote POSIX shell, uploaded per deployment
```

Two abstractions carry the design:

- **`RemoteExecutor`** — every remote operation goes through it. This is what makes the engine testable without a VPS, and why no SSH logic is scattered anywhere.
- **`PanelAdapter`** — aaPanel is one implementation. Plesk, cPanel, Forge or plain VPS slot in without touching the engine. All panel-specific quirks are confined to the adapter.

Complex remote work ships as a versioned script (`scripts/*.sh`) rather than hundreds of concatenated shell fragments. Each uses `set -Eeuo pipefail`, validates its inputs, and is idempotent. They are covered by tests that **execute them** in a sandbox — which is how the tests caught `mv -T` being GNU-only and silently breaking the atomic switch.

### Testing

```bash
npm test          # 244 tests
npm run typecheck
```

Covers project detection, config validation, archive exclusions, release naming and retention, the state machine, migration/seed/cache command selection, env merging, permission planning, health checks, and 30 end-to-end deployment scenarios — build failure, migration failure, upload failure, simultaneous deploys, provisioning reuse, legacy mode — plus real execution of every remote script.

---

## 20. CI/CD usage

Non-interactive by design; no prompts are ever required.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shivammathur/setup-php@v2
        with: { php-version: '8.3' }

      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }

      - run: npm ci -g laravel-deploy
      - run: composer install --no-dev
      - run: npm ci

      - name: Deploy
        env:
          LARAVEL_DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          LARAVEL_DEPLOY_AAPANEL_KEY: ${{ secrets.AAPANEL_API_KEY }}
        run: |
          mkdir -p ~/.ssh
          echo "$LARAVEL_DEPLOY_SSH_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          laravel-deploy deploy --yes --json --commit "${GITHUB_SHA}" > deploy.json

      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: deploy-log, path: deploy.json }
```

Credentials come from environment variables or the secrets store — never from a config file.

`--json` output:

```json
{
  "success": true,
  "deploymentId": "DEPLOY-20261003-103210-A1B2",
  "release": "20261003-103210-a1b2c3d",
  "domain": "example.com",
  "server": "production",
  "git": "a1b2c3d4e5f6a7b8",
  "durationMs": 134000,
  "checks": {
    "http": true, "laravel": true, "database": true,
    "storage": true, "queue": true, "scheduler": true, "ssl": true
  },
  "health": "HEALTHY",
  "backup": "/www/wwwroot/example.com/deploy-backups/client_site-20261003-103210.sql.gz"
}
```

On failure it includes the error, the command, whether live was affected, and remediation — and still exits non-zero.

---

## Command reference

| Command | Purpose |
| --- | --- |
| `deploy` | Full deployment lifecycle |
| `init` | Create project configuration interactively |
| `status` | Health check |
| `doctor` | Deep diagnostics |
| `rollback` | Restore the previous release (not the database) |
| `history`, `deployment show <id>` | Deployment history |
| `artisan <cmd>` | Run artisan on the live release |
| `migrate*`, `seed` | Migrations and seeders |
| `optimize`, `permissions`, `storage` | Cache, permission and storage maintenance |
| `maintenance on\|off` | Maintenance mode |
| `queue`, `scheduler` | Worker and cron management |
| `database backup\|restore\|list` | Database operations |
| `site create\|inspect` | Website provisioning |
| `server add\|list\|show\|set\|test` | Server profiles |
| `secrets set\|get\|list\|remove` | Secret store |
| `domain check` | DNS and TLS |
| `logs laravel\|nginx\|php\|queue\|deploy` | Logs |

Useful flags: `--dry-run`, `--plan`, `--yes`, `--force`, `--skip-build`, `--skip-migrations`, `--seed`, `--no-provision`, `--env`, `--json`, `--verbose`.

---

## License

MIT