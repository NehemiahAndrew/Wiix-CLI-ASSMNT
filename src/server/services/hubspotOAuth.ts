// =============================================================================
// Module 1-A: HubSpot OAuth Connection Flow
// =============================================================================
// Four functions that manage the full OAuth 2.0 Authorization Code lifecycle:
//   1. getAuthorizationUrl  — build consent URL with CSRF state
//   2. handleCallback       — exchange code for tokens, verify state
//   3. refreshAccessToken   — refresh before expiry, handle revoked tokens
//   4. disconnect           — wipe all stored tokens
//
// SECURITY:
//   - Only minimum scopes requested (contacts read/write, schemas, oauth)
//   - CSRF state stored in Wix Secrets Manager with a random value
//   - Token values NEVER appear in log output
// =============================================================================
import axios from 'axios';
import crypto from 'crypto';
import config from '../config';
import logger from '../utils/logger';
import {
  storeTokens,
  clearTokens,
  storeSecret,
  getSecret,
  deleteSecret,
} from './tokenManager';

/* ── Constants ── */
const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';

// Minimum scopes — contacts read+write, schemas read+write, base oauth
const SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
  'oauth',
];

/** Key prefix for the temporary CSRF state value in Wix Secrets */
const STATE_SECRET_KEY = (instanceId: string): string =>
  `hubspot_oauth_state_${instanceId}`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Build the HubSpot authorization URL
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Generates the HubSpot OAuth consent URL for a given Wix instance.
 *
 * A cryptographically random `state` value is created and persisted in
 * Wix Secrets Manager. When HubSpot redirects back, `handleCallback`
 * verifies this state to prevent CSRF attacks.
 *
 * @param instanceId — The Wix site instance initiating the connection
 * @returns          — The full authorization URL the user should visit
 */
export async function getAuthorizationUrl(instanceId: string): Promise<string> {
  // Generate a random 32-byte hex string as the CSRF state
  const state = crypto.randomBytes(32).toString('hex');

  // Persist state in Wix Secrets so we can verify it in the callback
  await storeSecret(STATE_SECRET_KEY(instanceId), state);

  // Encode instanceId into the state so we know who is connecting
  const statePayload = Buffer.from(
    JSON.stringify({ instanceId, nonce: state }),
  ).toString('base64url');

  const params = new URLSearchParams({
    client_id: config.hubspotClientId,
    redirect_uri: config.hubspotRedirectUri,
    scope: SCOPES.join(' '),
    state: statePayload,
  });

  const url = `${HUBSPOT_AUTH_URL}?${params.toString()}`;

  logger.info('HubSpot authorization URL generated', { instanceId });
  // NOTE: URL itself contains no tokens — safe to log at debug level
  logger.debug('Auth URL built', { instanceId, scopes: SCOPES.join(' ') });

  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Handle the OAuth callback
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Processes the redirect from HubSpot after the user grants consent.
 *
 * Steps:
 *   a. Decode and verify the `state` parameter against Wix Secrets (CSRF)
 *   b. Exchange the authorization `code` for access + refresh tokens
 *   c. Fetch the portal ID from the token-info endpoint
 *   d. Store tokens securely via `tokenManager.storeTokens`
 *   e. Delete the temporary state secret
 *
 * @param code          — Authorization code from HubSpot query string
 * @param stateParam    — State parameter from HubSpot query string
 * @returns             — The HubSpot portal ID for the connected account
 * @throws              — If state is invalid or token exchange fails
 */
export async function handleCallback(
  code: string,
  stateParam: string,
): Promise<{ portalId: string; instanceId: string }> {
  // ── a. Verify CSRF state ──────────────────────────────────────────────
  let instanceId: string;
  let nonce: string;

  try {
    const decoded = JSON.parse(
      Buffer.from(stateParam, 'base64url').toString('utf8'),
    );
    instanceId = decoded.instanceId;
    nonce = decoded.nonce;
  } catch {
    throw new Error('Invalid state parameter — cannot decode');
  }

  if (!instanceId || !nonce) {
    throw new Error('Malformed state — missing instanceId or nonce');
  }

  const storedNonce = await getSecret(STATE_SECRET_KEY(instanceId));
  if (!storedNonce || storedNonce !== nonce) {
    throw new Error(
      'CSRF state mismatch — the OAuth flow may have been tampered with',
    );
  }

  // ── b. Exchange authorization code for tokens ─────────────────────────
  let accessToken: string;
  let refreshToken: string;
  let expiresIn: number;

  try {
    const { data } = await axios.post(HUBSPOT_TOKEN_URL, null, {
      params: {
        grant_type: 'authorization_code',
        client_id: config.hubspotClientId,
        client_secret: config.hubspotClientSecret,
        redirect_uri: config.hubspotRedirectUri,
        code,
      },
      timeout: 15_000,
    });

    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    expiresIn = data.expires_in; // seconds
  } catch (err) {
    const status = (err as any)?.response?.status ?? 'unknown';
    logger.error('HubSpot token exchange failed', { instanceId, status });
    throw new Error(`Token exchange failed (HTTP ${status})`);
  }

  // ── c. Fetch portal ID ────────────────────────────────────────────────
  let portalId: string;
  try {
    const { data: tokenInfo } = await axios.get(
      `${TOKEN_INFO_URL}/${accessToken}`,
      { timeout: 10_000 },
    );
    portalId = String(tokenInfo.hub_id);
  } catch {
    // If token-info call fails, still store tokens (portal can be fetched later)
    portalId = '';
    logger.warn('Could not fetch portal ID from token info endpoint', {
      instanceId,
    });
  }

  // ── d. Store tokens securely ──────────────────────────────────────────
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  await storeTokens(instanceId, {
    accessToken,
    refreshToken,
    expiresAt,
    portalId,
  });

  // SAFE LOG — no token values, only the portal ID
  logger.info(`Tokens exchanged successfully for portal ID: ${portalId}`, {
    instanceId,
  });

  // ── e. Clean up CSRF state ────────────────────────────────────────────
  await deleteSecret(STATE_SECRET_KEY(instanceId));

  return { portalId, instanceId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Refresh the access token
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Uses the stored refresh token to obtain a new access token.
 *
 * Called automatically by `tokenManager.getAccessToken()` when the current
 * token is within 5 minutes of expiry. Can also be called explicitly.
 *
 * If the refresh token itself has been revoked by HubSpot (HTTP 400/401),
 * all stored tokens are cleared and the user must reconnect.
 *
 * @param instanceId    — The Wix site instance
 * @param refreshToken  — The current refresh token (already decrypted)
 * @returns             — New access token, refresh token, and expiry
 * @throws              — If refresh token is revoked
 */
export async function refreshAccessToken(
  instanceId: string,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}> {
  try {
    const { data } = await axios.post(HUBSPOT_TOKEN_URL, null, {
      params: {
        grant_type: 'refresh_token',
        client_id: config.hubspotClientId,
        client_secret: config.hubspotClientSecret,
        refresh_token: refreshToken,
      },
      timeout: 15_000,
    });

    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Persist the new token set
    await storeTokens(instanceId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      portalId: '', // portalId doesn't change on refresh, tokenManager preserves it
    });

    // SAFE LOG — never log token values
    logger.info('HubSpot access token refreshed successfully', { instanceId });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  } catch (err) {
    const status = (err as any)?.response?.status ?? 'unknown';
    const errBody = (err as any)?.response?.data;

    // HubSpot returns 400 or 401 when the refresh token is revoked/invalid
    if (status === 400 || status === 401) {
      logger.error(
        'Refresh token is invalid or revoked — user must reconnect',
        { instanceId, status },
      );

      // Wipe all tokens so the UI shows "disconnected"
      await clearTokens(instanceId);

      throw new Error(
        'HubSpot refresh token is no longer valid. Please reconnect your HubSpot account.',
      );
    }

    logger.error('HubSpot token refresh failed', {
      instanceId,
      status,
      message: errBody?.message ?? (err as Error).message,
    });
    throw new Error(`Token refresh failed (HTTP ${status})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Disconnect
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Disconnects the HubSpot account by wiping all stored tokens.
 *
 * After this call the installation is marked as disconnected and the
 * user will need to re-authorize via `getAuthorizationUrl`.
 *
 * @param instanceId — The Wix site instance to disconnect
 */
export async function disconnect(instanceId: string): Promise<void> {
  await clearTokens(instanceId);

  logger.info('HubSpot account disconnected', { instanceId });
}
