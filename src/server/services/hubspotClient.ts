// =============================================================================
// Module 2-A: HubSpot API Client Factory + Retry Helper
// =============================================================================
// createHubSpotClient(instanceId)
//   → Returns a fresh Axios instance with a valid Bearer token.
//     NEVER reuse across requests — the token may have been refreshed.
//
// withRetry(instanceId, fn)
//   → Wraps any HubSpot API call with automatic retry for:
//       • HTTP 429 (rate limit)  — waits the duration HubSpot specifies
//       • HTTP 5xx (server err)  — exponential back-off: 1 s → 2 s → 4 s
//     Client errors (4xx except 429) are NEVER retried — they're the
//     caller's fault and retrying won't fix them.
// =============================================================================
import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import { getAccessToken } from './tokenManager';
import logger from '../utils/logger';

/* ── Constants ── */
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum number of retry attempts (applies to both 429 and 5xx) */
const MAX_RETRIES = 3;

/** Base delay for exponential back-off on 5xx errors (ms) */
const BACKOFF_BASE_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Client Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new HubSpot API client with a **fresh** access token.
 *
 * Always call this at the start of a request handler or service function.
 * Do not cache or share the returned instance — the underlying token is
 * automatically refreshed by Module 1's `getAccessToken()` if it is
 * within 5 minutes of expiry.
 *
 * @param instanceId — Wix site instance whose token should be used
 * @returns          — A ready-to-use Axios instance pointed at HUBSPOT_API_BASE
 */
export async function createHubSpotClient(
  instanceId: string,
  forceRefresh = false,
): Promise<AxiosInstance> {
  const accessToken = await getAccessToken(instanceId, forceRefresh);

  return axios.create({
    baseURL: HUBSPOT_API_BASE,
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executes an async function that makes a HubSpot API call and
 * automatically retries on transient failures.
 *
 * Retry policy:
 *   • **HTTP 429** — wait for `Retry-After` header (seconds), then retry.
 *     If the header is missing, fall back to exponential back-off.
 *   • **HTTP ≥ 500** — exponential back-off: 1 s, 2 s, 4 s.
 *   • **HTTP 4xx (except 429)** — NOT retried (caller's fault).
 *   • **Network / timeout errors** — retried with exponential back-off.
 *
 * If the token expires mid-retry (401), a fresh client is built and the
 * call is retried once.
 *
 * @param instanceId — Wix site instance (needed for token refresh on 401)
 * @param fn         — The API call to execute. Receives an Axios instance.
 * @returns          — The Axios response from the successful call
 */
export async function withRetry<T = any>(
  instanceId: string,
  fn: (client: AxiosInstance) => Promise<AxiosResponse<T>>,
): Promise<AxiosResponse<T>> {
  let lastError: Error | undefined;

  let tokenRefreshed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await createHubSpotClient(instanceId, tokenRefreshed);
      return await fn(client);
    } catch (err) {
      lastError = err as Error;
      const axErr = err as AxiosError;
      const status = axErr.response?.status;

      // ── Token expired / invalid → force-refresh and retry once ────────
      if (status === 401 && !tokenRefreshed) {
        logger.warn('HubSpot 401 — forcing token refresh and retrying', {
          instanceId,
          attempt,
        });
        tokenRefreshed = true;
        continue;
      }

      // ── Rate limited (429) ────────────────────────────────────────────
      if (status === 429) {
        if (attempt >= MAX_RETRIES) break;

        const retryAfter = parseRetryAfter(axErr);
        logger.warn('HubSpot rate limit hit (429) — backing off', {
          instanceId,
          attempt,
          waitMs: retryAfter,
        });
        await sleep(retryAfter);
        continue;
      }

      // ── Server error (5xx) ────────────────────────────────────────────
      if (status !== undefined && status >= 500) {
        if (attempt >= MAX_RETRIES) break;

        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
        logger.warn(`HubSpot server error (${status}) — retrying in ${delay}ms`, {
          instanceId,
          attempt,
          status,
        });
        await sleep(delay);
        continue;
      }

      // ── Network / timeout error (no HTTP status) ─────────────────────
      if (status === undefined && (axErr.code === 'ECONNABORTED' || axErr.code === 'ETIMEDOUT' || !axErr.response)) {
        if (attempt >= MAX_RETRIES) break;

        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        logger.warn('HubSpot network/timeout error — retrying', {
          instanceId,
          attempt,
          code: axErr.code,
        });
        await sleep(delay);
        continue;
      }

      // ── Client error (4xx except 429) — do NOT retry ─────────────────
      logger.error('HubSpot client error — not retrying', {
        instanceId,
        status,
        message: axErr.response?.data
          ? JSON.stringify(axErr.response.data).slice(0, 300)
          : axErr.message,
      });
      throw err;
    }
  }

  // All retries exhausted
  logger.error('HubSpot API call failed after all retry attempts', {
    instanceId,
    maxRetries: MAX_RETRIES,
  });
  throw lastError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the `Retry-After` header from a 429 response.
 * HubSpot sends this as seconds. If missing, fall back to 10 s.
 */
function parseRetryAfter(err: AxiosError): number {
  const header = err.response?.headers?.['retry-after'];
  if (header) {
    const seconds = parseInt(String(header), 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000; // convert to ms
    }
  }
  return 10_000; // default 10 s if header missing
}

/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
