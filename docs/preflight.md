# `lara-deploy preflight`

Read-only checks that everything `deploy` needs is in place, run before you deploy.

```bash
lara-deploy preflight        # alias: lara-deploy doctor
```

It never creates, modifies or deletes anything on the server, so it is safe to run at any time —
including before `init` has ever been run, to see exactly what is missing.

Related: [`docs/aapanel-api.md`](aapanel-api.md) explains the panel behaviour that several of
these checks depend on.

---

## Why it exists

A deployment touches four separate systems: the local project, SSH, the aaPanel API, and the
server's PHP. When any one of them is wrong, `deploy` fails *after* building, archiving and
uploading — which is slow and leaves a half-finished deployment behind.

`preflight` checks the same things first, in a couple of seconds, with no side effects.

---

## What it checks

Checks run in order and **short-circuit on the first hard failure** — if SSH is unreachable,
there is no point querying the panel.

### 1. Local project

| Check | Source |
|---|---|
| Laravel project detected | `artisan`, `composer.json`, `app/`, `bootstrap/`, `config/`, `routes/` |
| Configuration found | `.lara-deploy.json` parses and passes validation |

### 2. Server (over SSH)

| Check | Notes |
|---|---|
| SSH connection | `username@host:port` using the configured private key |
| PHP on the server | `PHP_DETECT`: `php` on `PATH`, else the newest under `/www/server/php/*/bin/php` |

The PHP check reuses the exact detection used by `deploy`, so `preflight` cannot pass and then
fail differently later. aaPanel usually does not put PHP on the SSH user's `PATH`, which is why
the fallback scan exists.

### 3. aaPanel

| Check | Notes |
|---|---|
| API authenticates | Lists sites — proves the URL, key and IP whitelist all work |
| Website exists | Reports the site's `path` from aaPanel |
| Database exists | Reports the database **username** |

---

## Failures versus warnings

This is the one design decision worth understanding.

A missing website or database is reported as a **warning** (`!`), not a failure:

```
! Website example.com does not exist yet — deploy will create it
! Database example_db does not exist yet — deploy will create it

Ready to deploy: lara-deploy deploy
```

`deploy` creates both, so failing here would make a perfectly valid first-time deployment look
broken. Warnings do not affect the exit code.

Everything that would genuinely block a deployment prints `✗` and exits **1**:

The first six messages are produced by `lara-deploy`; the last two are **aaPanel’s own**
responses, passed through by `src/aapanel.ts`.

| Failing check | Emitted by | What it means | Fix |
|---|---|---|---|
| `This does not appear to be a Laravel project.` | lara-deploy | not run from a Laravel project directory | `cd` into the project |
| `.lara-deploy.json not found.` | lara-deploy | never configured | `lara-deploy init` |
| `SSH key not found: …` | lara-deploy | `server.sshKey` points at a missing file | fix the path in `.lara-deploy.json` |
| `SSH connection failed: …` | lara-deploy | wrong host/port/user, or the key is not in `authorized_keys` | see [SSH setup](../README.md#ssh-setup) |
| `No PHP found on the server` | lara-deploy | no PHP on `PATH` and none under `/www/server/php/` | install PHP from the aaPanel App Store |
| `aaPanel returned its web page instead of API data` | lara-deploy | `aapanel.url` is the bare IP or the wrong host | use the panel’s **domain** plus port |
| `Reason: Secret key verification failed` | **aaPanel** | wrong `apiKey` | re-copy it; wait out any IP lockout |
| `Reason: IP validation failed …` | **aaPanel** | this machine’s IP is not whitelisted | add it in aaPanel → Settings → API |

⚠️ aaPanel blocks an IP for **one hour** after 20 consecutive failed API calls, so a mistyped key
does not fail fast — it burns attempts and then locks you out.

---

## Output reference

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

Exit code `0` when nothing is blocking, `1` when a check fails.

### What is never printed

- the database password — aaPanel's rows contain it, and `preflight` reads those rows
- the aaPanel API key or the derived request token
- anything from the local `.env`

---

## What it deliberately does *not* check

Keeping scope tight matters; each of these belongs to a different command:

| Not checked | Use instead |
|---|---|
| whether the app is deployed and healthy | `lara-deploy status` |
| whether `composer install` / `npm run build` succeed | `lara-deploy deploy` (it builds before uploading) |
| migrations, seeders | `lara-deploy migrate` / `lara-deploy seed` |
| HTTP reachability of the site | `lara-deploy status` |
| SSL, DNS, queue, scheduler | out of scope |

`preflight` answers one question: *will `deploy` get far enough to start uploading?*

---

## Verification status

The command was exercised end to end through the real CLI against a live aaPanel panel (using a
throwaway local SSH endpoint, since no deploy key was available for the test server):

| Scenario | Expected | Result |
|---|---|---|
| not a Laravel project | fail, exit 1 | ✅ |
| Laravel project, no config | fail, exit 1 | ✅ |
| everything reachable, database missing | warn, exit 0 | ✅ |
| everything reachable, database present | pass, exit 0 | ✅ |
| `aapanel.url` set to the bare IP | fail with the web-page diagnostic, exit 1 | ✅ |

**There is no automated test for `preflight`.** Its SSH and panel dependencies make it awkward to
unit test without a live endpoint, so it is covered by the manual runs above rather than by
`npm test`. `src/aapanel.test.ts` covers the panel client that `preflight` depends on.

---

## Source

- `src/commands/preflight.ts` — the command
- `src/cli.ts` — registration and the `doctor` alias
- `src/laravel.ts` — `assertLaravelProject`, `PHP_DETECT`
- `src/ssh.ts` — `Ssh.connect`
- `src/aapanel.ts` — `connect`, `findSite`, `findDatabase`