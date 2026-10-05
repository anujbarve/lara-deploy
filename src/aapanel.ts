import { createHash } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import type { Config } from './config.js';
import { DeployError, debug } from './ui.js';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

// aaPanel sits behind nginx that returns a bare 403 for any User-Agent without
// "Mozilla", and the panel itself treats a non-browser agent as an unknown IP.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface Row {
  name: string;
  path?: string;
  username?: string;
  password?: string;
}

type Params = Record<string, string | number | boolean>;

/** The route (or the action inside it) does not exist on this panel version. */
class RouteMissing extends Error {}

/** Rows and request URLs carry secrets; never let them reach the terminal. */
const redact = (value: unknown): string =>
  (JSON.stringify(value, (key, v) => (/pass|token|key/i.test(key) ? '***' : v)) ?? '').slice(0, 400);

const API_HELP = [
  'In aaPanel: Settings -> API -> enable it, and add this machine\'s public IP to the IP whitelist.',
  'aapanel.url must be the panel address, including the port.',
  'Note: after 20 failed API calls aaPanel blocks the IP for one hour.',
];

/** Rows of a getData reply, whatever envelope this panel version wraps them in. */
const rowsOf = (res: any): Row[] | null => {
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.message?.data)) return res.message.data;
  return null;
};

/** Minimal aaPanel API client: only what a deployment needs. */
export class AaPanel {
  private base: URL;
  private apiKey: string;
  /** aaPanel serves the same actions at /<route> and /v2/<route>; remember which works, per route. */
  private prefixes = new Map<string, '/v2' | ''>();

  constructor(config: Config) {
    this.apiKey = config.aapanel.apiKey;
    try {
      this.base = new URL(config.aapanel.url);
    } catch {
      throw new DeployError(`Invalid aaPanel URL: ${config.aapanel.url}`);
    }
  }

  private async call(route: string, action: string, params: Params): Promise<any> {
    const cached = this.prefixes.get(route);
    const order: Array<'/v2' | ''> = cached === undefined ? ['/v2', ''] : [cached, cached === '/v2' ? '' : '/v2'];
    const seen: string[] = [];
    for (const prefix of order) {
      let res: any;
      try {
        res = await this.send(prefix, route, action, params);
      } catch (e) {
        if (e instanceof RouteMissing) {
          seen.push(`${prefix || '/'} -> ${e.message}`);
          continue;
        }
        throw e;
      }
      // A known action missing from this version answers with JSON, not a 404.
      if (!AaPanel.ok(res) && AaPanel.unknownAction(res)) {
        seen.push(`${prefix || '/'} -> ${AaPanel.reason(res)}`);
        continue;
      }
      this.prefixes.set(route, prefix);
      return res;
    }
    throw new DeployError(`aaPanel has no usable endpoint for ${action}.`, ['', ...seen, '', ...API_HELP]);
  }

  private send(prefix: string, route: string, action: string, params: Params): Promise<any> {
    const time = String(Math.floor(Date.now() / 1000));
    // aaPanel hashes request_time against the API secret key. It reads these from the
    // query string as well as the form body, so we send them in both places. The rest of
    // the payload stays in the body: aaPanel rejects any URL longer than 1024 characters.
    const token = md5(time + md5(this.apiKey));
    const auth = `request_time=${time}&request_token=${token}`;
    const encoded = new URLSearchParams(
      Object.fromEntries(Object.entries({ request_time: time, request_token: token, ...params }).map(([k, v]) => [k, String(v)])),
    ).toString();
    const url = new URL(`${prefix}/${route}?action=${encodeURIComponent(action)}&${auth}`, this.base);
    const transport = url.protocol === 'https:' ? https : http;
    // Only the path and action; the query carries the request token.
    debug(`POST ${url.pathname}?action=${action}`);

    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: 'POST',
          headers: {
            'user-agent': USER_AGENT,
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(encoded),
          },
          timeout: 60_000,
          // aaPanel normally uses a self-signed certificate.
          ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const code = res.statusCode ?? 0;
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () => {
            if (code === 404) return reject(new RouteMissing(`HTTP 404`));
            let parsed: any;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // The panel's HTML shell means the request never reached the aaPanel API.
              if (/<!doctype html|<html/i.test(raw)) {
                return reject(
                  new DeployError('aaPanel returned its web page instead of API data.', [
                    '',
                    'The URL in .lara-deploy.json must be the panel address that matches the',
                    "panel's own domain, including the port (e.g. https://panel.example.com:28634).",
                    'Reaching the panel by its bare IP often hits a different virtual host that',
                    'serves a web page for every path.',
                    '',
                    ...API_HELP,
                  ]),
                );
              }
              return reject(new RouteMissing(`HTTP ${code} returned a non-JSON page`));
            }
            debug(`  -> ${redact(parsed)}`);
            resolve(parsed);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', (e) => reject(new DeployError(`Cannot reach aaPanel: ${e.message}`, ['', ...API_HELP])));
      req.end(encoded);
    });
  }

  private static ok(res: any): boolean {
    return res?.status === 0 || res?.status === true;
  }

  /** aaPanel's answer when the route exists but has no such action. */
  private static unknownAction(res: any): boolean {
    const msg = String(AaPanel.reason(res)).toLowerCase();
    return msg.includes('specific parameters are invalid') || msg.includes('not found') || msg.includes('404');
  }

  private static reason(res: any): string {
    const m = res?.message;
    if (m && typeof m === 'object' && typeof m.result === 'string' && m.result) return m.result;
    if (typeof m === 'string' && m) return m;
    if (res?.msg) return String(res.msg);
    return 'unknown error';
  }

  private async list(table: 'sites' | 'databases', search: string): Promise<Row[]> {
    const res = await this.call('data', 'getData', { p: 1, limit: 500, table, search, order: 'id desc', type: '-1' });
    // /data returns { data: [...rows] }; /v2/data wraps them as { message: { data: [...] } }.
    const rows = rowsOf(res);
    if (!rows) {
      throw new DeployError('aaPanel API request failed.', [`Reason: ${AaPanel.reason(res)}`, '', ...API_HELP]);
    }
    return rows.filter((r: Row) => r && typeof r.name === 'string');
  }

  /** Verify credentials by listing sites. */
  async connect(): Promise<void> {
    await this.list('sites', '');
  }

  async findSite(domain: string): Promise<Row | undefined> {
    return (await this.list('sites', domain)).find((s) => s.name === domain);
  }

  /**
   * Newest PHP version actually installed on the panel.
   * aaPanel turns a missing/empty version into "00", which is its *static* site type,
   * so the site would be created without any PHP handler.
   */
  private async newestPhpVersion(): Promise<string> {
    const res = await this.call('site', 'GetPHPVersion', {});
    // Older panels wrap it as { message: [...] }, newer ones return the array directly.
    const rows = (Array.isArray(res) ? res : Array.isArray(res?.message) ? res.message : []) as any[];
    const versions = rows
      .map((r: any) => String(r?.version ?? ''))
      .filter((v: string) => /^\d{2,3}$/.test(v))
      .sort((a: string, b: string) => Number(a) - Number(b));
    const latest = versions[versions.length - 1];
    if (!latest) {
      throw new DeployError('No PHP version is installed on the server.', [
        '',
        'Install PHP from the aaPanel App Store, then deploy again.',
        `Reason reported by aaPanel: ${AaPanel.reason(res)}`,
      ]);
    }
    return latest;
  }

  async createSite(domain: string, root: string): Promise<void> {
    const version = await this.newestPhpVersion();
    const res = await this.call('site', 'AddSite', {
      webname: JSON.stringify({ domain, domainlist: [], count: 0 }),
      path: root,
      ps: domain,
      type: 'PHP',
      project_type: 'PHP',
      type_id: 0,
      version,
      port: '80',
      ftp: 'false',
      sql: 'false',
      datapassword: '',
      codeing: 'utf8mb4',
      force_ssl: 0,
      ssl_auto: 0,
      sub_dir: '',
      is_create_default_file: 'true',
    });
    if (!AaPanel.ok(res)) {
      throw new DeployError('aaPanel website creation failed', [
        '',
        'Reason:',
        AaPanel.reason(res),
        '',
        `Domain: ${domain}`,
        `Path:   ${root}`,
        `PHP:    ${version}`,
        '',
        'Deployment stopped.',
      ]);
    }
  }

  async findDatabase(name: string): Promise<Row | undefined> {
    return (await this.list('databases', name)).find((d) => d.name === name);
  }

  async createDatabase(name: string, username: string, password: string): Promise<void> {
    // Same character class aaPanel rejects in a database password.
    if (/[，。？！；：""''（）【】《》￥&\u4E00-\u9FA5]/.test(password)) {
      throw new DeployError('aaPanel database creation failed', [
        '',
        'Reason:',
        'The database password contains characters aaPanel rejects (punctuation or non-ASCII).',
        '',
        'Use a password made of letters, digits and _ - .',
        '',
        'Deployment stopped.',
      ]);
    }
    const res = await this.call('database', 'AddDatabase', {
      name,
      db_user: username,
      password,
      codeing: 'utf8mb4',
      // Must match DB_HOST in the .env we generate. aaPanel also always grants @localhost.
      address: '127.0.0.1',
      dtype: 'MySQL',
      sid: 0,
      active: 'true',
      ps: name,
    });
    if (!AaPanel.ok(res)) {
      throw new DeployError('aaPanel database creation failed', [
        '',
        'Reason:',
        AaPanel.reason(res),
        '',
        'Deployment stopped.',
      ]);
    }
  }
}