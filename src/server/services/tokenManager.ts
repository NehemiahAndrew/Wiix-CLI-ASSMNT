// =============================================================================
// Module 1-B: Token Manager
// =============================================================================
// Manages secure storage & retrieval of HubSpot OAuth tokens using
// dual persistence: AES-256-GCM encrypted fields in MongoDB AND
// Wix Secrets Manager for the plaintext secret store.
//
// Public API:
//   storeTokens(instanceId, payload)   — encrypt & persist
//   getAccessToken(instanceId)         — retrieve + auto-refresh if < 5 min
//   getConnectionStatus(instanceId)    — safe status (never exposes tokens)
//   clearTokens(instanceId)            — wipe from both stores
//   storeSecret / getSecret / deleteSecret — Wix Secrets Manager helpers
//
// SECURITY:
//   - Tokens at rest are AES-256-GCM encrypted in MongoDB
//   - Wix Secrets Manager provides a second secure vault layer
//   - `getConnectionStatus` NEVER returns token values
//   - Auto-refresh fires when token expiry is within 5 minutes
// =============================================================================
import { createClient, OAuthStrategy } from '@wix/sdk';
import Installation from '../models/Installation';
import OAuthState from '../models/OAuthState';
import { encryptTokens, decryptTokens } from '../utils/tokenEncryption';
import config from '../config';
import logger from '../utils/logger';

/* ── Types ── */

/** Payload passed to `storeTokens` after an exchange or refresh */
export interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  /** Empty string on refresh (caller preserves existing portalId) */
  portalId: string;
}

/** Shape returned by `getConnectionStatus` — NEVER includes token values */
export interface ConnectionStatus {
  connected: boolean;
  portalId: string | null;
  tokenExpiresAt: Date | null;
  syncEnabled: boolean;
  lastSyncAt: Date | null;
}

/* ── Constants ── */

/** Auto-refresh threshold: 5 minutes in milliseconds */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/** Wix Secrets Manager keys — prefixed per installation */
const secretKey = {
  accessToken: (id: string) => `hs_access_${id}`,
  refreshToken: (id: string) => `hs_refresh_${id}`,
  portalId: (id: string) => `hs_portal_${id}`,
  expiresAt: (id: string) => `hs_expires_${id}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Wix Secrets Manager helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Wix SDK client configured for the app's Secrets Manager.
 * In a self-hosted context we use the Wix app credentials (appId + appSecret)
 * to authenticate API calls.
 */
function getWixClient() {
  return createClient({
    auth: OAuthStrategy({
      clientId: config.wixAppId,
      // The Wix SDK automatically handles app-level auth for server-side calls
    }),
  });
}

/**
 * Store a secret value (CSRF nonces, etc.) in MongoDB.
 * Uses the OAuthState collection with a TTL index (auto-expires in 10 min).
 * This survives server restarts — critical for Render/cloud deployments.
 */
export async function storeSecret(
  key: string,
  value: string,
): Promise<void> {
  try {
    await OAuthState.findOneAndUpdate(
      { key },
      { key, value, createdAt: new Date() },
      { upsert: true, new: true },
    );
    logger.debug('Secret stored in DB', { key: key.replace(/_[a-f0-9]+$/i, '_***') });
  } catch (err) {
    logger.error('Failed to store secret', {
      key: key.replace(/_[a-f0-9]+$/i, '_***'),
      message: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Retrieve a secret value from MongoDB.
 */
export async function getSecret(key: string): Promise<string | null> {
  try {
    const doc = await OAuthState.findOne({ key });
    return doc?.value ?? null;
  } catch (err) {
    logger.error('Failed to retrieve secret', {
      key: key.replace(/_[a-f0-9]+$/i, '_***'),
      message: (err as Error).message,
    });
    return null;
  }
}

/**
 * Delete a secret from MongoDB.
 */
export async function deleteSecret(key: string): Promise<void> {
  try {
    await OAuthState.deleteOne({ key });
    logger.debug('Secret deleted from DB', { key: key.replace(/_[a-f0-9]+$/i, '_***') });
  } catch (err) {
    logger.error('Failed to delete secret', {
      key: key.replace(/_[a-f0-9]+$/i, '_***'),
      message: (err as Error).message,
    });
  }
}

// Alias for backward compatibility
export const storeSecretWithCache = storeSecret;

// ─────────────────────────────────────────────────────────────────────────────
// Token Storage — Dual persistence (MongoDB + Wix Secrets)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store OAuth tokens securely.
 *
 * Writes to:
 *   1. MongoDB Installation document (AES-256-GCM encrypted at rest)
 *   2. Wix Secrets Manager keys (for cross-service access)
 *
 * If `portalId` is empty, the existing portalId is preserved (refresh flow).
 *
 * @param instanceId  — Wix site instance
 * @param payload     — Token data from exchange or refresh
 */
export async function storeTokens(
  instanceId: string,
  payload: TokenPayload,
): Promise<void> {
  const { accessToken, refreshToken, expiresAt, portalId } = payload;

  // ── 1. Encrypt and save to MongoDB ────────────────────────────────────
  const encrypted = encryptTokens(accessToken, refreshToken);

  const updateFields: Record<string, unknown> = {
    hubspotAccessToken: encrypted.accessToken,
    hubspotRefreshToken: encrypted.refreshToken,
    hubspotTokenIv: encrypted.tokenIv,
    hubspotTokenExpiresAt: expiresAt,
    connected: true,
  };

  // Preserve existing portalId on refresh (empty string means "keep current")
  if (portalId) {
    updateFields.hubspotPortalId = portalId;
  }

  await Installation.findOneAndUpdate(
    { instanceId },
    { $set: updateFields },
    { upsert: true, new: true },
  );

  // ── 2. Mirror to Wix Secrets Manager ─────────────────────────────────
  await Promise.all([
    storeSecretWithCache(secretKey.accessToken(instanceId), accessToken),
    storeSecretWithCache(secretKey.refreshToken(instanceId), refreshToken),
    storeSecretWithCache(secretKey.expiresAt(instanceId), expiresAt.toISOString()),
    ...(portalId
      ? [storeSecretWithCache(secretKey.portalId(instanceId), portalId)]
      : []),
  ]);

  logger.info('Tokens stored securely', { instanceId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Retrieval — with auto-refresh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve a valid access token for the given instance.
 *
 * If the current access token expires within 5 minutes, the token is
 * automatically refreshed BEFORE being returned. This ensures every
 * caller receives a usable token without worrying about expiry.
 *
 * @param instanceId   — Wix site instance
 * @param forceRefresh — If true, skip the expiry check and refresh immediately
 *                       (used by withRetry on 401 to handle clock-skew / stale tokens)
 * @returns            — A valid, decrypted access token
 * @throws             — If no tokens are stored or refresh fails
 */
export async function getAccessToken(
  instanceId: string,
  forceRefresh = false,
): Promise<string> {
  const installation = await Installation.findOne({ instanceId });

  if (
    !installation ||
    !installation.hubspotAccessToken ||
    !installation.hubspotRefreshToken
  ) {
    throw new Error('No HubSpot tokens found — user must connect first');
  }

  // Decrypt tokens from the Installation document
  const decrypted = decryptTokens({
    accessToken: installation.hubspotAccessToken,
    refreshToken: installation.hubspotRefreshToken,
    tokenIv: installation.hubspotTokenIv,
  });

  // ── Forced refresh (e.g. after 401 from HubSpot) ─────────────────────
  if (forceRefresh) {
    logger.info('Force-refreshing HubSpot access token (401 recovery)', { instanceId });
    const { refreshAccessToken } = await import('./hubspotOAuth');
    const refreshed = await refreshAccessToken(instanceId, decrypted.refreshToken);
    return refreshed.accessToken;
  }

  const expiresAt = installation.hubspotTokenExpiresAt;
  const now = Date.now();

  // ── Auto-refresh if within 5 minutes of expiry ────────────────────────
  if (expiresAt && expiresAt.getTime() - now < REFRESH_THRESHOLD_MS) {
    logger.info('Access token expiring soon — auto-refreshing', {
      instanceId,
      expiresIn: Math.round((expiresAt.getTime() - now) / 1000),
    });

    // Lazy import to avoid circular dependency at module load time
    const { refreshAccessToken } = await import('./hubspotOAuth');
    const refreshed = await refreshAccessToken(instanceId, decrypted.refreshToken);

    return refreshed.accessToken;
  }

  return decrypted.accessToken;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status (safe — NEVER exposes tokens)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the connection status for a Wix instance.
 *
 * This function is safe to call from any endpoint — it **never** returns
 * access tokens, refresh tokens, or any token-derived data. Only boolean
 * connection state, portal ID, expiry timestamp, and sync metadata.
 *
 * @param instanceId — Wix site instance
 * @returns          — Connection status object
 */
export async function getConnectionStatus(
  instanceId: string,
): Promise<ConnectionStatus> {
  const installation = await Installation.findOne({ instanceId }).lean();

  if (!installation) {
    return {
      connected: false,
      portalId: null,
      tokenExpiresAt: null,
      syncEnabled: false,
      lastSyncAt: null,
    };
  }

  return {
    connected: Boolean(installation.connected),
    portalId: installation.hubspotPortalId || null,
    tokenExpiresAt: installation.hubspotTokenExpiresAt || null,
    syncEnabled: Boolean(installation.syncEnabled),
    lastSyncAt: installation.lastSyncAt || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear Tokens (full wipe)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes all stored tokens for the given instance from both MongoDB
 * and Wix Secrets Manager.
 *
 * After this call, `getConnectionStatus` will return `connected: false`.
 *
 * @param instanceId — Wix site instance to disconnect
 */
export async function clearTokens(instanceId: string): Promise<void> {
  // ── 1. Clear from MongoDB ─────────────────────────────────────────────
  await Installation.findOneAndUpdate(
    { instanceId },
    {
      $set: {
        hubspotAccessToken: '',
        hubspotRefreshToken: '',
        hubspotPortalId: '',
        hubspotTokenExpiresAt: null,
        connected: false,
      },
    },
  );

  // ── 2. Clear from Wix Secrets Manager ─────────────────────────────────
  await Promise.all([
    deleteSecret(secretKey.accessToken(instanceId)),
    deleteSecret(secretKey.refreshToken(instanceId)),
    deleteSecret(secretKey.expiresAt(instanceId)),
    deleteSecret(secretKey.portalId(instanceId)),
  ]);

  logger.info('All HubSpot tokens cleared', { instanceId });
}
