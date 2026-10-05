# lara-deploy

Automates one manual workflow: deploying a Laravel app to an aaPanel VPS, with the app in `<site root>/main` and `public/*` copied into the site root.

```
/www/wwwroot/example.com/
    main/            ← the Laravel app (vendor, app, .env, ...)
    index.php        ← generated, points at main/
    build/ css/ ...  ← copied from main/public
    storage          → main/storage/app/public
```

## Installation

```bash
npm install -g lara-deploy     # or: npm install && npm run build && npm link
```

Requires Node 20+, plus `composer` and `npm` locally. The server needs `tar` and PHP (found on `PATH` or under `/www/server/php/*/bin/php`).

## server

Store the VPS and aaPanel details **once**, globally, so every project reuses them:

```bash
lara-deploy server          # ask for and save the credentials
lara-deploy server --show   # print what is saved (secrets hidden)
lara-deploy server --forget # delete the saved credentials
```

It asks for VPS host, SSH user/port/key, and aaPanel URL and API key, then writes
`~/.config/lara-deploy/credentials.json` with owner-only permissions (on Windows,
`%APPDATA%\lara-deploy\credentials.json`). These are the same values every deployment to that
server uses, so they live outside the project.

## init

Run inside your Laravel project:

```bash
lara-deploy init
```

Uses the credentials saved by [`lara-deploy server`](#server) and asks only about **this site**:
domain, database name/user/password. It writes `.lara-deploy.json` (which embeds the server
details so the file stays self-contained) and adds it to `.gitignore` (it contains secrets).

If no server credentials have been saved yet, `init` stops and tells you to run
`lara-deploy server` first.

## Configuration

```json
{
  "server":   { "host": "123.123.123.123", "port": 22, "username": "root", "sshKey": "~/.ssh/laravel-deploy" },
  "aapanel":  { "url": "https://panel.example.com:7800", "apiKey": "..." },
  "site":     { "domain": "example.com", "root": "/www/wwwroot/example.com" },
  "database": { "name": "example_db", "username": "example_user", "password": "..." },
  "deployment": { "runMigrations": true, "runSeeders": false }
}
```

`server.sshKey` accepts:

| Form | Example | Platforms |
|---|---|---|
| `~` expansion | `~/.ssh/laravel-deploy` | all |
| backslash form | `~\.ssh\laravel-deploy` | all (separators are normalised) |
| absolute | `C:\Users\User\.ssh\laravel-deploy` | Windows |
| environment variable | `%USERPROFILE%\.ssh\laravel-deploy` or `$HOME/.ssh/laravel-deploy` | all |

### Windows

Written for Windows, macOS and Linux. Notes:

- `composer` and `npm` must be on your `PATH`. They are launched through the system shell,
  because on Windows they are `.bat`/`.cmd` shims that cannot be started directly.
- If either is missing, the deploy stops and names the command it could not find.
- Everything else — SSH, SFTP, the archive, and all the shell commands — runs on the Linux
  server, so it is unaffected by your local platform.
- `server.sshKey` accepts either separator style, so a config written on Windows works on
  macOS/Linux and vice versa.

> Windows-specific behaviour (`.cmd` shims, `windowsHide`, `%VAR%` expansion, the cmd.exe
> exit code for a missing command) is implemented and unit-tested, but this project has only
> been exercised end to end on macOS. Please report any Windows-only failure.

## preflight

```bash
lara-deploy preflight        # alias: lara-deploy doctor
```

Read-only checks that everything a deployment needs is in place. Changes nothing on the server,
so it is safe to run at any time.

```
Laravel Deploy

→ Local project
✓ Laravel project detected
✓ Configuration found for example.com

→ Server
✓ SSH root@123.123.123.123:22
✓ PHP 8.3 on the server

→ aaPanel
✓ API authenticated at https://panel.example.com:7800
✓ Website exists (/www/wwwroot/example.com)
✓ Database exists (example_user)

Ready to deploy: lara-deploy deploy
```

A missing website or database is a warning (`!`), not a failure — `deploy` creates both, so
flagging those would be a false alarm on a first run. Only a real blocker prints `✗` and exits
non-zero:

| Failing check | What it means |
|---|---|
| `This does not appear to be a Laravel project.` | not run from a Laravel project directory |
| `.lara-deploy.json not found.` | run `lara-deploy init` first |
| `SSH connection failed: …` | wrong host/port/user, or the key is missing or not authorised |
| `No PHP found on the server` | install PHP from the aaPanel App Store |
| any aaPanel error | see [aaPanel API setup](#aapanel-api-setup) |

The database **username** is printed but never the password, and only the site's `path` is shown.

`preflight` also reads the site's vhost document root (read-only) and warns when it does not match
the site root, which is the usual cause of a 500 after a successful deploy.

`preflight` verifies that the *infrastructure* is reachable, not that the app is deployed — use
`lara-deploy status` for that. See [docs/preflight.md](docs/preflight.md).

## deploy

```bash
lara-deploy deploy [--skip-build] [--seed] [--verbose]
```

Run `lara-deploy preflight` first to confirm the server, panel and credentials are reachable.

1. Verifies the folder is a Laravel project.
2. Creates the website and database in aaPanel if missing.
3. Checks the site's vhost **document root**. The app is served from `<root>/index.php`, so a root that still points at `<root>/current/public` (an older release layout) makes every request die in a redirect loop. That is detected and repaired automatically (backup kept, config tested, web server reloaded); any other mismatched root is reported and left alone.
4. Runs `composer install` and `npm run build` (skip with `--skip-build`).
5. Archives the project (excludes `node_modules`, `.git`, `.env`, `.lara-deploy.json`, and server-side runtime data such as `storage/logs` and `storage/app/public`).
6. Uploads over SFTP, clears the files in `main/` that the archive replaces (keeping `.env` and `storage/`), extracts, copies `main/public/*` into the site root, and regenerates the root `index.php` with paths pointing at `main/`. Clearing first means a file deleted locally stops existing on the server too — a stale `config/*.php` referencing a removed package used to abort every artisan command.
7. Creates/updates `main/.env` (only the `APP_ENV`, `APP_DEBUG`, `APP_URL`, `DB_*` keys; everything else, including `APP_KEY`, is preserved; `APP_KEY` is generated on first deploy).
8. Creates the `<root>/storage → main/storage/app/public` symlink (repairs a wrong one).
9. Runs `php artisan migrate --force` (unless `runMigrations` is false), and `db:seed --force` if `--seed` or `runSeeders` is set.

Re-running it simply updates the app. Files deleted locally are not deleted on the server.

## migrate

```bash
lara-deploy migrate            # php artisan migrate --force
lara-deploy migrate --status   # php artisan migrate:status
```

## seed

```bash
lara-deploy seed               # php artisan db:seed --force
```

## status

```bash
lara-deploy status
```

Checks SSH, website reachability and HTTP status, database connection, Laravel, and the storage link.

## SSH setup

```bash
ssh-keygen -t ed25519 -f ~/.ssh/laravel-deploy
ssh-copy-id -i ~/.ssh/laravel-deploy.pub root@YOUR_VPS
```

Keys with a passphrase are not supported; use a dedicated deploy key.

## aaPanel API setup

In aaPanel: **Settings → API** → enable the API, copy the key, and add your machine's public IP to the whitelist.

**Use the panel's own domain in `aapanel.url`, including the port** — for example
`https://panel.example.com:7800`. Do *not* use the bare server IP: aaPanel's nginx selects a
virtual host by name, and the wrong host serves a web page for every path, which looks like
a broken API. Self-signed certificates are accepted.

⚠️ After 20 consecutive failed API calls aaPanel blocks your IP for one hour, so a
mistyped key is expensive to debug. See [docs/aapanel-api.md](docs/aapanel-api.md) for the full
panel contract and the reasoning behind these requirements.

## Troubleshooting

- **aaPanel returned its web page instead of API data** – `aapanel.url` is pointing at the bare IP or the wrong host. Use the panel's domain plus port.
- **aaPanel API request failed** – check the API key and the IP whitelist. If you have just mistyped the key, wait out any IP lockout (1 hour) before retrying.
- **20 consecutive verification failures, prohibited for 1 hour** – aaPanel has temporarily blocked your IP; it clears by itself.
- **SSH connection failed** – verify host/port/user and that the key path is right.
- **Migration failed** – the uploaded app stays on the server; fix the error and run `lara-deploy migrate`.
- **`Class "..." not found`** – two causes, both handled automatically now. A stale `bootstrap/cache/services.php` from an earlier deploy (cleared on every deploy and before every artisan run), or a stale `config/*.php` left over from a package you removed locally. As of this version the deploy clears the replaced files in `main/` first, so `config/` no longer keeps a file the archive does not contain. If it still fails, the package is genuinely missing from `vendor` – check your `composer.lock`.
- **Migration fails with `1060 Duplicate column name`** – the server database already has the column. This means the database was migrated by an earlier, different version of the app while the `migrations` table does not record that migration. The deploy stops and leaves the app in place; repair the database (for example mark the conflicting migration as run, or start from a fresh database) and run `lara-deploy migrate`.
- **The site returns 500 with `AH00124: Request exceeded the limit of 10 internal redirects`** – the vhost document root points at a Laravel `public` directory inside the site root instead of the site root itself. `deploy` detects this and repairs it (keeping a `.bak.<timestamp>` copy and reloading the web server); `preflight` warns about it first. If the root is something else entirely it is reported but not changed.
- **Existing website with other root** – the root aaPanel reports is used and the config is updated.
- **`storage ... is not a symlink`** – handled automatically now: a leftover `storage` directory in the site root is moved aside to `storage.bak.<timestamp>` and replaced with the correct symlink. Nothing is deleted.
- Use `--verbose` to see every command and its output.