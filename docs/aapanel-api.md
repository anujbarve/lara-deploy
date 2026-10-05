# aaPanel API integration — findings

How the aaPanel client in `src/aapanel.ts` was diagnosed and fixed, and the panel contract
that was confirmed along the way. Read this before changing anything in `aapanel.ts`.

To check all of this against your own panel without deploying, run `lara-deploy preflight`
(see [`docs/preflight.md`](preflight.md)).

> All infrastructure details in this document are redacted. The real panel host, domain,
> port and API key are deliberately not recorded here.

---

## TL;DR

The aaPanel integration appeared "not working at all". It was three unrelated blockers stacked
on top of each other, none of which produced a useful error message:

| # | Blocker | Symptom | Fix |
|---|---------|---------|-----|
| 1 | Panel addressed by bare IP instead of its domain | Every path returns the panel's HTML page | Use the panel's own domain in `aapanel.url` |
| 2 | Requests sent with no `User-Agent` | Bare `403 Forbidden` from nginx | Send a browser-like `User-Agent` |
| 3 | Wrong response envelope assumed | Rows / PHP versions parsed as empty | Handle both the `/data` and `/v2/data` shapes |

Two further bugs would have broken the deployment *after* the above were fixed:

| # | Bug | Effect | Fix |
|---|-----|--------|-----|
| 4 | `AddSite` sent `version: ''` | Site silently created as **Static**, no PHP handler | Query `GetPHPVersion`, send a real version |
| 5 | `AddDatabase` granted at `localhost` | Grant never matched the `DB_HOST` we write | Grant at `127.0.0.1` |

Plus a security defect: `--verbose` printed the database password and the API request token.

---

## Symptom

Every aaPanel call failed with `aaPanel returned an unexpected response.` or a generic
endpoint error, regardless of whether the site already existed. No request ever appeared to
reach the panel's application code.

---

## How it was diagnosed

1. Read aaPanel's own server source (`aaPanel/aaPanel` on GitHub: `BTPanel/__init__.py`,
   `class/common.py`, `class_v2/panel_site_v2.py`, `class_v2/database_v2.py`, `class/data.py`,
   `class/public/common.py`) to establish the intended contract.
2. Probed a live panel with raw HTTP, varying one variable at a time — protocol, host, path,
   User-Agent, token — and recorded the exact status, headers and body for each combination.
3. Reproduced the discovered behaviour in `src/aapanel.test.ts` so it cannot regress.

The live probe is what surfaced findings 1 and 2. Neither was visible in the documentation or
the source; both are enforced by the panel's nginx layer, which sits in front of aaPanel.

---

## Finding 1 — the panel must be addressed by domain, not by IP

aaPanel sits behind nginx, which selects a virtual host by `server_name`. Requesting the bare
server IP can land on a *different* virtual host.

Measured on a live panel (paths deliberately include one that does not exist, as a control):

| Request | Result |
|---|---|
| `http://<ip>:<port>/` | `302` → `https://<ip>:<port>/` |
| `https://<ip>:<port>/` | `200` + panel HTML shell |
| `https://<ip>:<port>/data?action=getData` | `200` + **the same** panel HTML shell |
| `https://<ip>:<port>/zzz-not-a-real-route` | `200` + **the same** panel HTML shell |
| `https://<panel.example.com>:<port>/` | `302` → `/login` ← the real panel |
| `https://<panel.example.com>:<port>/data?action=getData` | `200` JSON — the API |

The control is what proves it: a nonsense path returns the same HTML as the API path, so the
request never reached the API at all. Requesting the domain returns `302 → /login`, which is
aaPanel's own "not authenticated" response.

**Fix.** `aapanel.url` must be the panel's own domain including the port. The client now
detects the HTML shell specifically and fails with that exact advice instead of a vague
"unexpected response" (see [Error handling](#error-handling)).

---

## Finding 2 — nginx rejects any User-Agent that is not browser-like

The panel's nginx returns a bare `403 Forbidden` for clients it does not recognise. Measured
by varying only the `User-Agent` header against an otherwise identical request:

| User-Agent | Response |
|---|---|
| *(absent)* | `403 Forbidden` (nginx) |
| *(empty string)* | `403 Forbidden` (nginx) |
| `curl/8.0` | `403 Forbidden` (nginx) |
| `python-requests/2.0` | `403 Forbidden` (nginx) |
| `Mozilla/5.0 …` | `200`, reaches aaPanel |

Node's `http.request()` / `https.request()` **send no `User-Agent` header by default**, so every
single API call was rejected at the nginx layer.

aaPanel repeats the same check in its own code, independently of nginx:

```python
# class/public/common.py — check_client_info()
user_agent = request.headers.get('User-Agent', '')
# 如果UA不是浏览器则当作陌生IP
if user_agent.find('Mozilla') == -1:
    return 0          # treated as an unknown client
```

**Fix.** Send a browser-like `User-Agent` on every request.

---

## Finding 3 — the two data routes use different envelopes

`getData` is exposed twice, and the two versions do **not** return the same shape.

| Route | Envelope | Where the rows are |
|---|---|---|
| `POST /data?action=getData` | `{ where, page, data, … }` | `res.data` |
| `POST /v2/data?action=getData` | `{ status: 0, timestamp, message: { where, page, data, … } }` | `res.message.data` |

Note that the `/data` reply has **no `status` field at all**, so success cannot be detected by
inspecting status on that route.

Row fields (from `GetField()` in `class/data.py`):

- `sites` → `id, name, path, status, ps, addtime, edate, …`
- `databases` → `id, sid, pid, name, username, password, accept, ps, addtime, …`

⚠️ The `databases` rows contain the **database password**. See [Security](#security).

**Fix.** A shared `rowsOf()` helper reads `res.data` or `res.message.data`, so either route works.

---

## Finding 4 — `AddSite` with an empty PHP version creates a Static site

This is the bug that would have produced a broken deployment even after findings 1–3 were fixed.

From `class_v2/panel_site_v2.py`:

```python
if hasattr(get, 'version'):
    self.phpVersion = get.version.replace(' ', '')
else:
    self.phpVersion = '00'

if not self.phpVersion:
    self.phpVersion = '00'
```

The old client sent `version: ''`, which becomes `'00'`. In `GetPHPVersion()`:

```python
checkPath = self.setupPath + '/php/' + val + '/bin/php'
if val in ['00', 'other']:
    checkPath = '/etc/init.d/bt'
```

`'00'` maps to `/etc/init.d/bt`, which always exists on aaPanel — so the version check
**passes** and the site is created, but as a *Static* site with no PHP handler. Laravel then
serves as a downloaded file rather than executing.

**Fix.** Call `site/GetPHPVersion`, drop `00` and `other`, and send the newest real version.
If none is installed, fail with a clear message rather than creating a static site.

### `GetPHPVersion` also has two shapes

Like `getData`, it is wrapped differently depending on panel version:

| Panel | Response |
|---|---|
| Older | `{ status: 0, message: [ { version, name }, … ] }` |
| Newer (confirmed live) | `[ { version, name }, … ]` — a **bare array** |

The client reads a bare array first, then falls back to `.message`.

---

## Finding 5 — the database grant host did not match `DB_HOST`

`class_v2/database_v2.py` → `__CreateUsers()` grants on the `address` parameter:

```python
for a in address.split(','):
    mysql_obj.execute("CREATE USER `{}`@`{}` IDENTIFIED BY '{}'".format(username, a, password))
    result = mysql_obj.execute("grant all privileges on `%s`.* to `%s`@`%s`" % (dbname, username, a))
```

The old client passed `address: 'localhost'` while writing `DB_HOST=127.0.0.1` into `.env`.
The grant is created for `'user'@'localhost'` only, so it does not match a TCP connection to
`127.0.0.1` under the usual MySQL host-matching rules.

**Fix.** `address: '127.0.0.1'`. aaPanel always also creates an `@localhost` grant alongside it,
so nothing is lost.

Other `AddDatabase` corrections: `dtype: 'MySQL'` (was `'mysql'`), and the invented `dataAccess`
parameter removed — it is commented out in aaPanel's own validator and is not a real field.

---

## Authentication reference

From `class/common.py` → `get_sk()`:

```python
request_token = public.md5(get.request_time + api_config['token'])
```

matching the documented formula:

```
request_token = md5(request_time + md5(api_secret_key))
```

`request_time` is **Unix seconds** (not milliseconds). `get_input()` merges `request.args`
(query string) and `request.form` (POST body), so the token may arrive in either. The client
sends it in **both** for maximum compatibility, but keeps the rest of the payload in the body
only, because aaPanel rejects any URL longer than 1024 characters:

```python
if len(request.url) > 1024: return abort(403)
```

### IP whitelist and the lockout

`get_sk()` also enforces an IP allowlist:

```python
if not public.is_api_limit_ip(api_config['limit_addr'], client_ip):
    return public.returnJson(False, 'IP validation failed ...')
```

And after 20 consecutive failures it blocks the IP for an hour:

```python
num_key = client_ip + '_api'
if not public.get_error_num(num_key, 20):
    return public.returnJson(False, '20 consecutive verification failures, prohibited for 1 hour')
```

**This is worth knowing when debugging:** a typo in `apiKey` does not fail fast. It burns
attempts, and a lockout costs an hour. The client warns about this in its error output.

---

## Endpoint reference

Only the operations a deployment needs.

| Operation | Endpoint | Notes |
|---|---|---|
| List sites / databases | `POST /data?action=getData` | or `/v2/data`; see envelopes above |
| Installed PHP versions | `POST /site?action=GetPHPVersion` | bare array or `.message` |
| Create website | `POST /site?action=AddSite` | requires a valid `version` |
| Create database | `POST /database?action=AddDatabase` | `address` must match `DB_HOST` |

Both `AddSite` and `AddDatabase` exist at the unprefixed path. `/v2` variants exist on current
panels but not on all of them, and an older panel returns an HTML 404 rather than JSON.

### Route-prefix fallback

The client tries `/v2/<route>` first, then `/<route>`, treating all three of these as
"this route does not exist here":

- HTTP `404`
- a non-JSON body (older panels serve an HTML 404)
- a **valid JSON** body saying `Specific parameters are invalid!` — aaPanel's way of
  reporting a known route with an unknown action

The third case matters: the original implementation only fell back on a JSON *parse* failure,
so on a panel where `/v2/site` existed but lacked `AddSite`, it failed permanently with no
retry. The working prefix is cached **per route**, because a panel can expose `/v2/data`
while not exposing `/v2/site`.

---

## Security

- **Passwords were leaking in `--verbose`.** The database password was part of the request
  query string, and `debug()` logged the full URL. Separately, `getData` rows for the
  `databases` table include a `password` column, so the logged response body contained **every
  database password on the server**. Both are now redacted, and the request URL is logged by
  path and action only.
- **Never commit `aapanel.apiKey`.** `.lara-deploy.json` contains it and is added to
  `.gitignore` by `init`.
- **Rotate any API key that has been pasted into a chat, ticket or log.** It should be treated
  as compromised.

---

## Error handling

Failures now name the actual cause instead of "unexpected response":

| Situation | Message |
|---|---|
| Panel serves HTML | `aaPanel returned its web page instead of API data` + "use the panel's domain, not the bare IP" |
| API off / IP not whitelisted | `Reason: IP validation failed …` + setup steps |
| Bad key | `Reason: Secret key verification failed` + setup steps |
| Route exists on neither prefix | Lists both attempts with their reasons |
| No PHP installed | `No PHP version is installed on the server` + App Store hint |

---

## Verification status

**Verified against a live panel (read-only):**

- `connect()` — authentication succeeded
- `findSite()` — correct hit and correct miss
- `findDatabase()` — correct miss
- `newestPhpVersion()` — returned `85`, correctly skipping the `00` Static entry

**Covered by `src/aapanel.test.ts`** (a mock reproducing the live shapes observed):

- browser `User-Agent` sent on every request (mock returns `403` otherwise, like the real nginx)
- `GetPHPVersion` read as both a bare array and a wrapped `{ message: [...] }`
- `getData` rows read from both `/data` and `/v2/data` envelopes
- route-prefix fallback, and reuse of the cached prefix
- `AddSite` sends `85`, never `00`
- `AddDatabase` sends `address=127.0.0.1`, `dtype=MySQL`, `sid`, `active`
- HTML response produces the "web page instead of API data" error
- `--verbose` leaks neither the database password nor the request token

```bash
npx tsc --noEmit    # typecheck
npm test            # builds, then runs 11 tests
```

### Not yet verified

- **`AddSite` and `AddDatabase` have never been executed against a live panel.** The write
  paths are covered by mocks and by reading the handler source, but are unproven on real
  hardware. The first real `deploy` is the actual proof.
- **SSH, SFTP and the `php artisan` steps are untested end-to-end** — no SSH key was available
  for the test server.
- **`deploy` as a whole has never completed a run.**

---

## References

- aaPanel API documentation: <https://www.aapanel.com/docs/api/api-list.html>
- Panel source: <https://github.com/aaPanel/aaPanel>
  - `BTPanel/__init__.py` — routing, `get_input()`, `publicObject`, `run_exec`
  - `class/common.py` — `check_login()`, `get_sk()` (API token + IP whitelist + lockout)
  - `class/public/common.py` — `check_client_info()` (User-Agent check), `redirect_to_login`
  - `class/data.py` — `getData`, `GetSql`, `GetField` (response envelope)
  - `class_v2/data_v2.py` — the `/v2/data` variant
  - `class_v2/panel_site_v2.py` — `AddSite`, `GetPHPVersion`
  - `class_v2/database_v2.py` — `AddDatabase`, `__CreateUsers`