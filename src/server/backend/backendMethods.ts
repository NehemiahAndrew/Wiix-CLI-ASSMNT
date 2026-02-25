// =============================================================================
// Module 10 — Backend API Methods (Wix webMethod Pattern)
// =============================================================================
// Every server-side operation the dashboard calls is defined here as a secure
// backend function using Wix's `webMethod` pattern. Each method:
//
//   1. Is wrapped with `webMethod(Permissions.Admin, fn)` — only the site
//      owner can invoke it; no public or member-level access is allowed.
//
//   2. Uses try/catch with `sanitizeError()` — if anything goes wrong, the
//      error message is scrubbed of emails, phone numbers, and tokens before
//      being re-thrown. This guarantees that PII never leaks in responses.
//
// Methods:
//   ┌────────────────────────────────┬───────────────────────────────────────┐
//   │ Method                         │ Purpose                               │
//   ├────────────────────────────────┼───────────────────────────────────────┤
//   │ getOAuthUrl                    │ Build the HubSpot consent URL         │
//   │ handleOAuthCallback            │ Exchange code → tokens, trigger sync  │
//   │ checkConnectionStatus          │ Is HubSpot connected? Portal ID?      │
//   │ disconnectHubSpot              │ Wipe tokens, pause sync               │
//   │ loadFieldMappings              │ Get the saved field mapping rules     │
//   │ saveFieldMappings              │ Validate & persist new mapping rules  │
//   │ getAvailableWixFields          │ List mappable Wix contact fields      │
//   │ getAvailableHubSpotProperties  │ List HubSpot contact properties       │
//   │ getSyncStatusSummary           │ Stats: mapped contacts, success, etc. │
//   │ triggerManualSync              │ Start a full bi-directional sync      │
//   └────────────────────────────────┴───────────────────────────────────────┘
//
// All methods receive `instanceId` as the first argument — this is resolved
// by the Express router adapter from the authenticated Wix instance token.
// =============================================================================

import { webMethod, Permissions } from './webMethod';
import { sanitizeError } from '../utils/sanitizeError';
import logger from '../utils/logger';

// ── Service imports ──
import {
  getAuthorizationUrl,
  handleCallback,
  disconnect,
} from '../services/hubspotOAuth';

import {
  getConnectionStatus,
} from '../services/tokenManager';

import {
  loadMappingRules,
  saveMappingRules,
  validateRules,
  getWixFieldRegistry,
  seedDefaultMappings,
  invalidateRulesCache,
  ValidationError,
} from '../services/fieldMappingEngine';

import { fetchCustomProperties } from '../services/hubspotProperties';
import { ensureRequiredProperties } from '../services/hubspotProperties';
import { registerWebhookSubscriptions } from '../services/hubspotWebhookRegistration';
import { runFullSync } from '../services/syncOrchestrator';
import { countMappings } from '../services/mappingStore';

// ── Model imports ──
import Installation from '../models/Installation';
import FieldMapping, { DEFAULT_FIELD_MAPPINGS } from '../models/FieldMapping';
import SyncEvent from '../models/SyncEvent';

// ─────────────────────────────────────────────────────────────────────────────
// 1. getOAuthUrl — Build the HubSpot authorization URL
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the full HubSpot OAuth consent URL that the user should be
 * redirected to in a popup window. Includes CSRF state.
 *
 * @param instanceId — Wix site instance initiating the connection
 * @returns          — `{ url: string }` — the authorization URL
 */
export const getOAuthUrl = webMethod(
  Permissions.Admin,
  async (instanceId: string): Promise<{ url: string }> => {
    try {
      const url = await getAuthorizationUrl(instanceId);
      return { url };
    } catch (err) {
      logger.error('getOAuthUrl failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. handleOAuthCallback — Exchange auth code for tokens + trigger initial sync
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Called after the user grants access on HubSpot. Exchanges the auth code
 * for access/refresh tokens, seeds default field mappings, registers
 * webhook subscriptions, and fires an initial full sync in the background.
 *
 * @param code  — Authorization code from HubSpot redirect
 * @param state — CSRF state parameter (verified against stored value)
 * @returns     — `{ portalId: string; instanceId: string }`
 */
export const handleOAuthCallback = webMethod(
  Permissions.Admin,
  async (
    code: string,
    state: string,
  ): Promise<{ portalId: string; instanceId: string }> => {
    try {
      const { portalId, instanceId } = await handleCallback(code, state);

      // Ensure required HubSpot properties exist (fire-and-forget)
      ensureRequiredProperties(instanceId).catch((err) =>
        logger.error('Post-callback: failed to ensure properties', {
          instanceId,
          error: (err as Error).message,
        }),
      );

      // Register webhook subscriptions (fire-and-forget)
      registerWebhookSubscriptions().catch((err) =>
        logger.error('Post-callback: failed to register webhooks', {
          instanceId,
          error: (err as Error).message,
        }),
      );

      // Seed default field mappings if none exist
      const existingCount = await FieldMapping.countDocuments({ instanceId });
      if (existingCount === 0) {
        const docs = DEFAULT_FIELD_MAPPINGS.map((m) => ({
          ...m,
          instanceId,
          isDefault: true,
          isActive: true,
        }));
        await FieldMapping.insertMany(docs);
        logger.info('Default field mappings seeded', { instanceId });
      }

      // Trigger initial full sync in the background (fire-and-forget)
      const installation = await Installation.findOne({ instanceId });
      if (installation) {
        runFullSync(installation)
          .then((result) =>
            logger.info('Initial full sync completed', {
              instanceId,
              synced: result.synced,
              skipped: result.skipped,
              errors: result.errors,
            }),
          )
          .catch((err) =>
            logger.error('Initial full sync failed', {
              instanceId,
              error: (err as Error).message,
            }),
          );
      }

      logger.info('OAuth callback processed', { instanceId, portalId });
      return { portalId, instanceId };
    } catch (err) {
      logger.error('handleOAuthCallback failed');
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. checkConnectionStatus — Is HubSpot connected? Portal ID?
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the current connection status. NEVER exposes token values —
 * only whether a connection exists and the portal ID.
 *
 * @param instanceId — Wix site instance
 * @returns          — `{ connected: boolean; hubspotPortalId: string; ... }`
 */
export const checkConnectionStatus = webMethod(
  Permissions.Admin,
  async (instanceId: string) => {
    try {
      return await getConnectionStatus(instanceId);
    } catch (err) {
      logger.error('checkConnectionStatus failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. disconnectHubSpot — Wipe tokens and pause sync
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Removes all stored OAuth tokens and marks the installation as
 * disconnected. Sync is immediately paused.
 *
 * @param instanceId — Wix site instance
 * @returns          — `{ ok: true; connected: false }`
 */
export const disconnectHubSpot = webMethod(
  Permissions.Admin,
  async (instanceId: string): Promise<{ ok: true; connected: false }> => {
    try {
      await disconnect(instanceId);
      return { ok: true, connected: false };
    } catch (err) {
      logger.error('disconnectHubSpot failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 5. loadFieldMappings — Get saved field mapping rules
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns all active field mapping rules for the installation, including
 * both default (undeletable) mappings and user-configured custom ones.
 *
 * @param instanceId — Wix site instance
 * @returns          — `{ mappings: FieldMappingDoc[] }`
 */
export const loadFieldMappings = webMethod(
  Permissions.Admin,
  async (instanceId: string) => {
    try {
      const mappings = await loadMappingRules(instanceId);
      return { mappings };
    } catch (err) {
      logger.error('loadFieldMappings failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 6. saveFieldMappings — Validate & persist new mapping rules
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Validates a set of field mapping rules, then replaces all custom mappings
 * with the new set. Default mappings are preserved.
 *
 * Returns either the saved rules or a list of validation errors (never both).
 *
 * @param instanceId — Wix site instance
 * @param rules      — Array of mapping rules to save
 * @returns          — `{ ok: true, mappings }` or `{ ok: false, errors }`
 */
export const saveFieldMappings = webMethod(
  Permissions.Admin,
  async (
    instanceId: string,
    rules: Array<{
      wixField: string;
      hubspotField: string;
      direction: string;
      transform: string;
    }>,
  ): Promise<
    | { ok: true; mappings: any[] }
    | { ok: false; errors: ValidationError[] }
  > => {
    try {
      if (!Array.isArray(rules)) {
        return { ok: false, errors: [{ field: 'rules', message: 'rules must be an array' }] };
      }

      // Optionally validate against real HubSpot properties
      let hsPropertyNames: Set<string> | null = null;
      const installation = await Installation.findOne({ instanceId });
      if (installation?.connected) {
        try {
          const hsProps = await fetchCustomProperties(instanceId);
          hsPropertyNames = new Set(hsProps.map((p) => p.value));
        } catch {
          // If we can't fetch HS properties, skip that validation layer
        }
      }

      const result = await saveMappingRules(instanceId, rules as any, hsPropertyNames);

      if (!result.ok) {
        return { ok: false, errors: result.errors ?? [] };
      }

      return { ok: true, mappings: result.rules ?? [] };
    } catch (err) {
      logger.error('saveFieldMappings failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 7. getAvailableWixFields — List mappable Wix contact fields
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns every Wix contact field that can be mapped to a HubSpot property.
 * Each field includes a human-readable label, type, and description.
 *
 * @returns — `{ fields: FieldOption[] }`
 */
export const getAvailableWixFields = webMethod(
  Permissions.Admin,
  async (): Promise<{ fields: Array<{ value: string; label: string }> }> => {
    try {
      return { fields: getWixFieldRegistry() };
    } catch (err) {
      logger.error('getAvailableWixFields failed');
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 8. getAvailableHubSpotProperties — List HubSpot contact properties
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Fetches the list of contact properties from the connected HubSpot portal.
 * Requires an active connection — returns an error if not connected.
 *
 * @param instanceId — Wix site instance
 * @returns          — `{ properties: Array<{ value, label }> }`
 */
export const getAvailableHubSpotProperties = webMethod(
  Permissions.Admin,
  async (instanceId: string) => {
    try {
      const installation = await Installation.findOne({ instanceId });
      if (!installation?.connected) {
        throw new Error('HubSpot is not connected');
      }

      const properties = await fetchCustomProperties(instanceId);
      return { properties };
    } catch (err) {
      logger.error('getAvailableHubSpotProperties failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 9. getSyncStatusSummary — Current sync status & statistics
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns a summary of the sync state:
 *   - Total mapped contacts
 *   - Recent success / failure counts
 *   - Average sync duration
 *   - Whether sync is enabled
 *   - Last sync timestamp
 *
 * @param instanceId — Wix site instance
 * @returns          — Sync status summary object
 */
export const getSyncStatusSummary = webMethod(
  Permissions.Admin,
  async (instanceId: string) => {
    try {
      const installation = await Installation.findOne({ instanceId });

      const [totalMappings, totalEvents, recentEvents] = await Promise.all([
        countMappings(instanceId),
        SyncEvent.countDocuments({ instanceId }),
        SyncEvent.find({ instanceId })
          .sort({ createdAt: -1 })
          .limit(100)
          .select('status action duration createdAt error'),
      ]);

      const successCount = recentEvents.filter((e) => e.status === 'success').length;
      const failedCount = recentEvents.filter((e) => e.status === 'failed').length;
      const avgDuration =
        recentEvents.length > 0
          ? Math.round(
              recentEvents.reduce((sum, e) => sum + (e.duration ?? 0), 0) /
                recentEvents.length,
            )
          : 0;

      return {
        totalMappings,
        totalEvents,
        recentSuccess: successCount,
        recentFailed: failedCount,
        avgDuration,
        syncEnabled: installation?.syncEnabled ?? false,
        lastSyncAt: installation?.lastSyncAt ?? null,
      };
    } catch (err) {
      logger.error('getSyncStatusSummary failed', { instanceId });
      sanitizeError(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// 10. triggerManualSync — Start a full bi-directional sync
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Initiates a full sync of all contacts between Wix and HubSpot.
 * Pages through every Wix contact and creates/updates the corresponding
 * HubSpot contact (and vice versa for missing mappings).
 *
 * @param instanceId — Wix site instance
 * @returns          — `{ synced, skipped, errors, duration }`
 */
export const triggerManualSync = webMethod(
  Permissions.Admin,
  async (instanceId: string) => {
    try {
      const installation = await Installation.findOne({ instanceId });
      if (!installation?.connected) {
        throw new Error('HubSpot is not connected — cannot sync');
      }

      const result = await runFullSync(installation);
      logger.info('Manual full sync completed', {
        instanceId,
        synced: result.synced,
        skipped: result.skipped,
        errors: result.errors,
      });

      return result;
    } catch (err) {
      logger.error('triggerManualSync failed', { instanceId });
      sanitizeError(err);
    }
  },
);
