// =============================================================================
// UTM Parameter Parser
// =============================================================================
// Extracts UTM tracking parameters from a URL string.
// Returns only the parameters that are actually present — never empty strings.
// =============================================================================

/** The five standard UTM parameters */
const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** Map of UTM param name → value (only non-empty entries) */
export type UtmParams = Partial<Record<UtmKey, string>>;

/**
 * Parses UTM parameters from an arbitrary URL string.
 *
 * Only returns entries whose values are non-empty after trimming.
 * Returns an empty object if the URL has no UTM params or is malformed.
 *
 * @example
 * ```ts
 * parseUtmParams('https://example.com?utm_source=google&utm_medium=cpc');
 * // → { utm_source: 'google', utm_medium: 'cpc' }
 *
 * parseUtmParams('https://example.com');
 * // → {}
 *
 * parseUtmParams('');
 * // → {}
 * ```
 *
 * @param url — Any URL string (absolute or relative)
 * @returns   — Object containing only the UTM params that are present
 */
export function parseUtmParams(url: string): UtmParams {
  if (!url) return {};

  let searchParams: URLSearchParams;
  try {
    // Try parsing as a full URL first
    const parsed = new URL(url);
    searchParams = parsed.searchParams;
  } catch {
    // Fall back to treating the whole string as a query string
    // Handles cases like "?utm_source=foo" or "utm_source=foo"
    const queryPart = url.includes('?') ? url.split('?')[1] : url;
    searchParams = new URLSearchParams(queryPart);
  }

  const result: UtmParams = {};

  for (const key of UTM_KEYS) {
    const value = searchParams.get(key);
    if (value && value.trim().length > 0) {
      result[key] = value.trim();
    }
  }

  return result;
}
