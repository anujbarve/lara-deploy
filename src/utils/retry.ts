/**
 * Retry with exponential backoff.
 *
 * Only ever applied to operations that are safe to repeat (idempotent reads,
 * uploads, health probes). Destructive database work is never retried — callers
 * must opt in explicitly, and `isRetryable` must say so (SPEC §51).
 */

import { errorMessage, isAppError } from '../core/errors/errors.js';

export interface RetryOptions {
  attempts?: number;
  /** Base delay in ms; grows exponentially. */
  delayMs?: number;
  /** Upper bound for a single delay. */
  maxDelayMs?: number;
  /** Decide whether a thrown error is worth another attempt. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry, for logging/UI. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Deterministic tests: replaces real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter ratio 0..1. */
  jitter?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Default policy: retry anything flagged transient, plus common network noise. */
export function isRetryableError(error: unknown): boolean {
  if (isAppError(error)) {
    return error.severity === 'transient';
  }
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('epipe') ||
    message.includes('temporarily unavailable') ||
    message.includes('timed out')
  );
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.delayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 15_000;
  const shouldRetry = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? 0.2;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      const exponential = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      const delay = Math.round(exponential * (1 - jitter * Math.random()));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}