/**
 * aaPanel HTTP API client.
 *
 * aaPanel's API is a single endpoint that switches on an `action` parameter:
 *
 *   POST /v2/<route>?action=<Action>
 *   body: request_time=<ms>&request_token=MD5(request_time + MD5(apiKey))&<params...>
 *
 * The action is NOT enough to identify a call — each route has its own
 * allowlist, and an action sent to the wrong route is rejected with
 * "Specific parameters are invalid!", the same message as an unknown action.
 * The routes in use:
 *
 *   data      getData, getFind, getKey, setPs        (generic table reads)
 *   database  AddDatabase, DeleteDatabase, ...       (databases/*)
 *   site      AddSite, DeleteSite, get_site_list, ... (sites/*)
 *
 * Four things about it are not obvious and were each found by talking to a
 * live panel:
 *
 *   - The path is prefixed `/v2`. The unprefixed `/data` is not the API.
 *   - nginx rejects the request with 403 unless the Host header matches the
 *     panel's own hostname, even when the TCP connection is to its IP.
 *   - Success is `{"status": 0, "message": {...}}`. `status` is 0, not true,
 *     and the payload sits under `message`.
 *   - Validation failures come back as `{"status": -1, "message": {"result":
 *     "..."}}`, so the human-readable reason is under `message.result`.
 *
 * Every call is funnelled through `AaPanelClient.request` so panel quirks
 * (auth, timeouts, TLS on a self-signed certificate, error shapes) live in
 * exactly one place (SPEC §10, §43).
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { PanelError, TransportError } from '../../core/errors/errors.js';
import { redactOutput } from '../../utils/redact.js';
import { retry } from '../../utils/retry.js';
import type { AaPanelConfig } from '../../core/config/schema.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

export interface AaPanelResponse<T = Record<string, unknown>> {
  /** aaPanel returns 0 for success, -1 for a validation failure; older builds used true/false. */
  status: number | boolean;
  msg?: string;
  /** v2 nests the payload here. */
  message?: T;
  /** aaPanel mixes shapes; callers narrow. */
  data?: T;
  [key: string]: unknown;
}

/**
 * The `/v2/<route>` endpoints this client talks to. Each has its own action
 * allowlist; sending an action to the wrong route fails exactly like sending
 * an action that does not exist.
 */
export type AaPanelRoute = 'data' | 'database' | 'site';

export interface AaPanelClientOptions {
  baseUrl: string;
  /**
   * Host header to send, when the panel is reached by IP but expects its own
   * hostname. nginx answers 403 for anything else.
   */
  hostHeader?: string;
  apiKey: string;
  timeoutMs: number;
  insecureTLS: boolean;
  attempts?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class AaPanelClient {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AaPanelClientOptions) {
    this.logger = options.logger ?? nullLogger();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Milliseconds since the epoch; injectable so tests are deterministic. */
  private now(): number {
    return Date.now();
  }

  /** The single request path. */
  async request<T = Record<string, unknown>>(
    action: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { allowFailure?: boolean } = {},
  ): Promise<AaPanelResponse<T>> {
    return this.requestOn<T>('data', action, params, options);
  }

  /**
   * As `request`, but against an explicit route. Use this for anything that is
   * not a generic table read — `AddDatabase` and `AddSite` live on their own
   * routes and are rejected by `/v2/data`.
   */
  async requestOn<T = Record<string, unknown>>(
    route: AaPanelRoute,
    action: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { allowFailure?: boolean } = {},
  ): Promise<AaPanelResponse<T>> {
    const url = this.buildUrl(route, action);
    const body = new URLSearchParams();
    // aaPanel does not accept the secret key directly. It wants a timestamped
    // token: request_token = MD5(request_time + MD5(api_secret_key)). Sending a
    // bare `key=` — as this client used to — is rejected with "API key error",
    // so the API could never be used and every deploy silently fell back to
    // SSH. Both values stay in the body, never the URL.
    const requestTime = String(this.now());
    body.set('request_time', requestTime);
    body.set('request_token', md5hex(`${requestTime}${md5hex(this.options.apiKey)}`));
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(name, String(value));
    }

    return retry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        let response: { ok: boolean; status: number; text: string };
        try {
          response = await this.send(url, body.toString(), controller.signal);
        } catch (cause) {
          if (isAbort(cause)) {
            throw new TransportError(`aaPanel request "${action}" timed out after ${this.options.timeoutMs}ms.`, {
              cause,
              severity: 'transient',
              command: `POST ${url} action=${action}`,
            });
          }
          throw new TransportError(`aaPanel request "${action}" failed to reach the panel.`, {
            cause,
            severity: 'transient',
            command: `POST ${url} action=${action}`,
            remediation: [
              'Confirm the panel URL and port in the server profile.',
              'If the panel uses a self-signed certificate, set aaPanel.insecureTLS = true.',
            ],
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          throw new TransportError(`aaPanel returned HTTP ${response.status} for "${action}".`, {
            severity: response.status >= 500 ? 'transient' : 'fatal',
            command: `POST ${url} action=${action}`,
          });
        }

        const text = response.text;
        let parsed: AaPanelResponse<T>;
        try {
          parsed = JSON.parse(text) as AaPanelResponse<T>;
        } catch (cause) {
          throw new PanelError(`aaPanel returned a non-JSON response for "${action}".`, {
            cause,
            command: `POST ${url} action=${action}`,
            details: { body: redactOutput(text).slice(0, 500) },
            remediation: [
              'Verify aaPanel.url points at the panel root (e.g. https://1.2.3.4:7800).',
              'Ensure "API interface" is enabled in the aaPanel panel settings.',
            ],
          });
        }

        if (!isSuccess(parsed.status) && !options.allowFailure) {
          throw new PanelError(`aaPanel rejected "${action}": ${panelErrorMessage(parsed)}`, {
            command: `POST ${url} action=${action}`,
            remediation: [
              'Check the API key permissions in aaPanel.',
              'Some actions require an authorised IP in the panel settings.',
            ],
          });
        }
        return parsed;
      },
      {
        attempts: this.options.attempts ?? 2,
        onRetry: (error, attempt, delay) => {
          this.logger.warn('Retrying aaPanel request.', { attempt, delayMs: delay });
        },
      },
    );
  }

  /**
   * POST a form body and read the response.
   *
   * `insecureTLS` has to go through node:https: fetch (undici) has no option
   * to accept a self-signed certificate, so the setting used to be accepted
   * and then ignored — and every aaPanel on its default certificate was
   * unreachable with "Hostname/IP does not match certificate's altnames".
   */
  private async send(
    url: string,
    body: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    // An injected fetch (tests) always wins. In production the default `fetch` is
    // only used when the certificate is one we can verify.
    if (this.fetchImpl !== fetch || !this.options.insecureTLS) {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(this.options.hostHeader ? { Host: this.options.hostHeader } : {}),
        },
        body,
        signal,
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    }

    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        target,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
            // nginx returns 403 unless the Host matches the panel's hostname.
            ...(this.options.hostHeader ? { Host: this.options.hostHeader } : {}),
          },
          ...(target.protocol === 'https:' ? { rejectUnauthorized: !this.options.insecureTLS } : {}),
          signal,
        },
        (incoming) => {
          let text = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk: string) => {
            text += chunk;
          });
          incoming.on('end', () =>
            resolve({ ok: (incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 300, status: incoming.statusCode ?? 0, text }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  }

  /** Cheap liveness/auth probe. */
  async ping(): Promise<boolean> {
    const response = await this.request('getData', getDataParams('config', 1), { allowFailure: true });
    return isSuccess(response.status);
  }

  private buildUrl(route: AaPanelRoute, action: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}/v2/${route}?action=${encodeURIComponent(action)}`;
  }
}

/**
 * The parameters `/v2/data?action=getData` requires. It validates strictly and
 * rejects the call — even with an empty value — if any of them is missing, so
 * these are always sent rather than omitted when falsy.
 */
export function getDataParams(table: string, limit = 100, search = ''): Record<string, string> {
  return { p: '1', limit: String(limit), table, search, order: '', type: '-1' };
}

/**
 * The reason aaPanel gives for a rejected call. Validation failures arrive as
 * `{"status": -1, "message": {"result": "..."}}` with no `msg`, so reading only
 * `msg` turns "Database name cannot contain special characters" into
 * "unknown error".
 */
export function panelErrorMessage(response: AaPanelResponse<unknown>): string {
  const message = response.message as { result?: unknown } | undefined;
  if (message && typeof message.result === 'string' && message.result !== '') {
    return message.result;
  }
  return response.msg ?? 'unknown error';
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** aaPanel v2 reports success as 0; older builds used boolean true. */
export function isSuccess(status: number | boolean | undefined): boolean {
  return status === 0 || status === true;
}

/** Hex MD5, as required by aaPanel's token scheme. */
export function md5hex(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/** Confirm the panel URL is usable, with an actionable message. */
export function assertPanelUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PanelError(`Invalid aaPanel URL: ${url}`, {
      remediation: ['Set aaPanel.url to the panel root, e.g. https://1.2.3.4:7800'],
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PanelError(`aaPanel URL must use http or https: ${url}`);
  }
  return parsed;
}