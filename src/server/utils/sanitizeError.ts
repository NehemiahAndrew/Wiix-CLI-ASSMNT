// =============================================================================
// Error Sanitizer — strips PII & secrets from error messages before re-throw
// =============================================================================
// Prevents accidental leakage of user data (emails, phone numbers) or
// authentication secrets (tokens, API keys) in error responses.
//
// Every backend method runs caught errors through `sanitizeError()` before
// re-throwing, so the client NEVER sees raw PII even in unexpected failures.
// =============================================================================

/* ── Regex patterns for sensitive data ── */

/** RFC 5322-ish email pattern (intentionally broad to catch edge cases) */
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Phone numbers — matches E.164, US domestic, and international formats.
 * Examples: +12125551234, (212) 555-1234, 212-555-1234, 212.555.1234
 */
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;

/**
 * Authorization / Bearer tokens — long hex, base64, or JWT-like strings.
 * Matches:
 *   - 32+ char hex strings (API keys, OAuth tokens)
 *   - Bearer <token>
 *   - JWT-like three-segment base64 strings: xxxxx.xxxxx.xxxxx
 */
const TOKEN_HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g;
const JWT_RE = /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+\b/g;

/**
 * Generic API key / secret patterns — long alphanumeric strings that look
 * like secrets (40+ chars of mixed case + digits, e.g. HubSpot API keys).
 */
const API_KEY_RE = /\b[A-Za-z0-9]{40,}\b/g;

/* ── Replacement placeholders ── */
const PLACEHOLDERS: Array<[RegExp, string]> = [
  [JWT_RE, '[token]'],
  [BEARER_RE, '[token]'],
  [EMAIL_RE, '[email]'],
  [PHONE_RE, '[phone]'],
  [TOKEN_HEX_RE, '[token]'],
  [API_KEY_RE, '[token]'],
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip sensitive data from a raw error message.
 *
 * @param message — The raw error message (may contain PII / secrets)
 * @returns       — A sanitized version safe for client-facing responses
 */
export function sanitizeMessage(message: string): string {
  let sanitized = message;
  for (const [pattern, placeholder] of PLACEHOLDERS) {
    sanitized = sanitized.replace(pattern, placeholder);
  }
  return sanitized;
}

/**
 * Wrap a caught error, sanitizing its message before re-throwing.
 * Preserves the original stack trace for server-side logging while
 * ensuring the message exposed to callers is free of PII.
 *
 * @param err — The raw caught error (typically from a try/catch)
 * @returns   — A new Error with sanitized message (never returns, always throws)
 */
export function sanitizeError(err: unknown): never {
  const original = err instanceof Error ? err : new Error(String(err));
  const safe = new Error(sanitizeMessage(original.message));
  safe.stack = original.stack; // keep stack for server logs
  throw safe;
}

/**
 * Convenience: sanitize and return the error instead of throwing.
 * Useful when you want to include the sanitized message in a response body.
 *
 * @param err — The raw caught error
 * @returns   — A new Error with sanitized message
 */
export function toSafeError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  return new Error(sanitizeMessage(original.message));
}
