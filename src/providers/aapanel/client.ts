/**
 * aaPanel HTTP API client.
 *
 * aaPanel's API is a single endpoint that switches on an `action` parameter:
 *
 *   POST /data?action=<Action>
 *   body: key=<apiKey>&<params...>
 *
 * Responses are `{ status: true|false, msg: string, ...payload }`. Every call is
 * funnelled through `AaPanelClient.request` so panel quirks (auth, timeouts,
 * TLS on a self-signed certificate, error shapes) live in exactly one place
 * (SPEC §10, §43).
 */

import { PanelError, TransportError } from '../../core/errors/errors.js';
import { redactOutput } from '../../utils/redact.js';
import { retry } from '../../utils/retry.js';
import type { AaPanelConfig } from '../../core/config/schema.js';
import type { Logger } from '../../utils/logger.js';
import { nullLogger } from '../../utils/logger.js';

export interface AaPanelResponse<T = Record<string, unknown>> {
  status: boolean;
  msg?: string;
  /** aaPanel mixes shapes; callers narrow. */
  data?: T;
  [key: string]: unknown;
}

export interface AaPanelClientOptions {
  baseUrl: string;
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

  /** The single request path. */
  async request<T = Record<string, unknown>>(
    action: string,
    params: Record<string, string | number | boolean | undefined> = {},
    options: { allowFailure?: boolean } = {},
  ): Promise<AaPanelResponse<T>> {
    const url = this.buildUrl(action);
    const body = new URLSearchParams();
    // The key is sent in the body, never in the URL, so it cannot leak into
    // proxy logs or shell history.
    body.set('key', this.options.apiKey);
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      body.set(name, String(value));
    }

    return retry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: controller.signal,
          });
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

        const text = await response.text();
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

        if (parsed.status !== true && !options.allowFailure) {
          throw new PanelError(`aaPanel rejected "${action}": ${parsed.msg ?? 'unknown error'}`, {
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

  /** Cheap liveness/auth probe. */
  async ping(): Promise<boolean> {
    const response = await this.request('GetSystemTotal', {}, { allowFailure: true });
    return response.status === true;
  }

  private buildUrl(action: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}/data?action=${encodeURIComponent(action)}`;
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
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