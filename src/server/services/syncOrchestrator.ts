// =============================================================================
// Module 7 — Bi-Directional Sync Orchestrator
// =============================================================================
// The heart of the integration. Ties together every prior module to handle
// four webhook scenarios plus a full-sync sweep:
//
//   Scenario 1 — onWixContactCreated   : New Wix contact  → create in HubSpot
//   Scenario 2 — onWixContactUpdated   : Changed Wix contact → update HubSpot
//   Scenario 3 — onHubSpotContactCreated : New HS contact  → create in Wix
//   Scenario 4 — onHubSpotContactUpdated : Changed HS contact → update Wix
//   Full Sync  — runFullSync           : Page through all Wix contacts, sync
//                                        any that do not yet have a mapping
//
// Conflict resolution: LAST-UPDATED-WINS
// If both systems modified the same contact between sync cycles, the system
// with the more recent timestamp wins. The loser's data is overwritten. The
// decision is logged for auditability.
//
// Loop prevention (Module 5):
//   • Layer 1 — Dedupe guard:   Every write registers a UUID sync-ID. When
//     the resulting echo webhook arrives, we recognise it and skip.
//   • Layer 2 — Idempotency:    SHA-256 hash of the property set. If the
//     target already has the same hash, the write is skipped entirely.
//
// Modules consumed:
//   Module 2-B  hubspotContacts   — getContactById, getContactByEmail,
//                                   createOrUpdateByEmail, writeSyncTag,
//                                   batchReadContacts
//   Module 3    wixContacts       — createOrUpdateWixContact, getWixContactById
//   Module 4    mappingStore      — findByWixId, findByHubSpotId, upsertMapping
//   Module 5-A  dedupeGuard       — registerSyncId, isSyncEcho, extractSyncId
//   Module 5-B  idempotencyChecker— computeHash, shouldSkipWrite, updateHash
//   Module 6    fieldMappingEngine— loadMappingRules, wixToHubSpot, hubSpotToWix,
//                                   flattenWixContact
//   Facade      hubspotService    — createContact, updateContact,
//                                   findContactByEmail
// =============================================================================

import crypto from 'crypto';

import config from '../config';
import Installation, { IInstallation } from '../models/Installation';
import { IContactMapping } from '../models/ContactMapping';
import SyncEvent from '../models/SyncEvent';
import logger from '../utils/logger';

// Module 2 — HubSpot wrappers
import * as hubspot from './hubspotService';
import {
  getContactById as getHubSpotContactById,
  writeSyncTag,
  batchReadContacts,
} from './hubspotContacts';
import { withRetry } from './hubspotClient';

// Module 3 — Wix contacts
import {
  createOrUpdateWixContact,
  getWixContactById,
  listWixContacts,
  type SyncMetadata,
} from './wixContacts';

// Module 4 — Mapping store
import {
  findByWixId,
  findByHubSpotId,
  upsertMapping,
} from './mappingStore';

// Module 5 — Loop prevention
import { registerSyncId } from './dedupeGuard';
import {
  computeHash,
  shouldSkipWrite,
  updateHash,
} from './idempotencyChecker';

// Module 6 — Field mapping engine
import {
  loadMappingRules,
  wixToHubSpot,
  hubSpotToWix,
  flattenWixContact,
} from './fieldMappingEngine';

// Types
import {
  FlatContact,
  SyncResult,
  SyncSource,
  SyncAction,
  HubSpotContact,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// Wix SDK removed — using REST API via wixContacts module instead

/** Audit-log a sync event to MongoDB */
async function logEvent(
  instanceId: string,
  source: SyncSource,
  action: SyncAction,
  wixContactId: string,
  hubspotContactId: string,
  status: 'success' | 'failed' | 'skipped',
  duration: number,
  error?: string,
  conflictWinner?: string,
): Promise<void> {
  try {
    await SyncEvent.create({
      instanceId,
      source,
      action,
      wixContactId,
      hubspotContactId,
      status,
      duration,
      error: error ?? '',
      ...(conflictWinner ? { conflictWinner } : {}),
    });
  } catch (err) {
    logger.error('Failed to log sync event', { error: (err as Error).message });
  }
}

/**
 * Resolve an email address from raw Wix contact data or mapped props.
 */
function resolveEmail(
  targetProps: FlatContact,
  rawData: Record<string, any>,
): string {
  return (
    targetProps.email ||
    rawData?.info?.emails?.items?.[0]?.email ||
    rawData?.info?.emails?.[0]?.email ||
    rawData?.primaryInfo?.email ||
    rawData?.primaryEmail?.email ||
    rawData?.primaryEmail ||
    ''
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict Resolution — Last-Updated-Wins
// ─────────────────────────────────────────────────────────────────────────────

interface ConflictDecision {
  winner: 'wix' | 'hubspot';
  reason: string;
  wixTimestamp: Date | null;
  hubspotTimestamp: Date | null;
}

/**
 * Given timestamps from both sides, determines which system has the more
 * recent version. Returns the winner and a human-readable reason.
 *
 * Tie-breaking: if timestamps are missing or identical, favour the
 * **inbound** side (the one that triggered the webhook), because that is
 * the version the user just edited.
 */
function resolveConflict(
  wixUpdatedAt: Date | string | null | undefined,
  hubspotUpdatedAt: Date | string | null | undefined,
  inboundSide: 'wix' | 'hubspot',
): ConflictDecision {
  const wixTs = wixUpdatedAt ? new Date(wixUpdatedAt) : null;
  const hsTs = hubspotUpdatedAt ? new Date(hubspotUpdatedAt) : null;

  // Both timestamps available — compare
  if (wixTs && hsTs && !isNaN(wixTs.getTime()) && !isNaN(hsTs.getTime())) {
    const diffMs = Math.abs(wixTs.getTime() - hsTs.getTime());

    if (wixTs.getTime() > hsTs.getTime()) {
      return {
        winner: 'wix',
        reason: `Wix timestamp is ${diffMs}ms newer than HubSpot`,
        wixTimestamp: wixTs,
        hubspotTimestamp: hsTs,
      };
    }
    if (hsTs.getTime() > wixTs.getTime()) {
      return {
        winner: 'hubspot',
        reason: `HubSpot timestamp is ${diffMs}ms newer than Wix`,
        wixTimestamp: wixTs,
        hubspotTimestamp: hsTs,
      };
    }

    // Exact tie — favour inbound
    return {
      winner: inboundSide,
      reason: `Timestamps identical; favouring inbound side (${inboundSide})`,
      wixTimestamp: wixTs,
      hubspotTimestamp: hsTs,
    };
  }

  // One or both timestamps missing — favour inbound
  return {
    winner: inboundSide,
    reason: wixTs
      ? 'HubSpot timestamp missing; favouring Wix'
      : hsTs
        ? 'Wix timestamp missing; favouring HubSpot'
        : `Both timestamps missing; favouring inbound side (${inboundSide})`,
    wixTimestamp: wixTs,
    hubspotTimestamp: hsTs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Wix Contact Created
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A brand-new contact was created in Wix. We need to:
 *   1. Convert its fields to HubSpot properties via the field mapping engine.
 *   2. Check idempotency (maybe another trigger already synced this).
 *   3. Search HubSpot by email — if a matching contact exists, link and
 *      update it instead of creating a duplicate.
 *   4. Otherwise, create a new HubSpot contact.
 *   5. Register the sync ID for loop prevention.
 *   6. Persist the mapping and the idempotency hash.
 *   7. Write the sync tag on the HubSpot contact.
 */
export async function onWixContactCreated(
  installation: IInstallation,
  wixContactId: string,
  wixContactData: Record<string, any>,
  source: SyncSource = 'wix_webhook',
): Promise<SyncResult> {
  const start = Date.now();
  const instanceId = installation.instanceId;

  logger.info('Scenario 1: Wix contact created', { instanceId, wixContactId });

  // Module 6 — Map Wix fields → HubSpot properties
  const rules = await loadMappingRules(instanceId);
  const targetProps = wixToHubSpot(wixContactData, rules);

  // Module 5 — Layer 2: Idempotency hash
  const hash = computeHash(targetProps);

  let action: SyncAction;
  let hubspotContactId = '';

  try {
    // Check if a mapping already exists (edge case: duplicate webhook)
    const existingMapping = await findByWixId(instanceId, wixContactId);
    if (existingMapping) {
      // Already mapped — this is really an update scenario
      logger.debug('Contact already mapped, delegating to update', {
        instanceId,
        wixContactId,
      });
      return onWixContactUpdated(
        installation,
        wixContactId,
        wixContactData,
        source,
      );
    }

    // Try to find an existing HubSpot contact by email (de-duplication)
    const email = resolveEmail(targetProps, wixContactData);
    let existingHsContact: HubSpotContact | null = null;

    if (email) {
      existingHsContact = await hubspot.findContactByEmail(installation, email);
    }

    if (existingHsContact) {
      // Link to existing HubSpot contact and update its properties
      await hubspot.updateContact(installation, existingHsContact.id, targetProps);
      hubspotContactId = existingHsContact.id;
      action = 'update';
      logger.info('Wix contact linked to existing HubSpot contact by email', {
        instanceId,
        wixContactId,
        hubspotContactId,
        email,
      });
    } else {
      // Create a new HubSpot contact
      const created = await hubspot.createContact(installation, targetProps);
      hubspotContactId = created.id;
      action = 'create';
      logger.info('New HubSpot contact created from Wix', {
        instanceId,
        wixContactId,
        hubspotContactId,
      });
    }

    // Module 5 — Layer 1: Register sync ID for echo suppression
    const syncId = await registerSyncId(instanceId, 'hubspot', hubspotContactId);

    // Module 4 — Persist mapping
    await upsertMapping({
      instanceId,
      wixContactId,
      hubspotContactId,
      lastSyncSource: 'wix',
      syncOperationId: syncId,
      propertyHash: hash,
    });

    // Write sync tag on HubSpot contact (fire-and-forget with error logging)
    writeSyncTag(instanceId, hubspotContactId, syncId).catch((tagErr) =>
      logger.warn('Failed to write sync tag', {
        instanceId,
        hubspotContactId,
        error: (tagErr as Error).message,
      }),
    );

    // Module 5 — Layer 2: Persist idempotency hash
    await updateHash(instanceId, hubspotContactId, 'hubspot', hash);

    const duration = Date.now() - start;
    await logEvent(instanceId, source, action, wixContactId, hubspotContactId, 'success', duration);
    return { action, source, wixContactId, hubspotContactId };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = (err as Error).message;
    logger.error('Scenario 1 failed: onWixContactCreated', {
      instanceId,
      wixContactId,
      error: msg,
    });
    await logEvent(instanceId, source, 'create', wixContactId, hubspotContactId, 'failed', duration, msg);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Wix Contact Updated
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * An existing Wix contact was updated. We need to:
 *   1. Convert fields via the mapping engine.
 *   2. Check idempotency — if the HubSpot side already has this hash, skip.
 *   3. If a mapping exists, run conflict resolution against HubSpot's
 *      `updatedAt` timestamp. If HubSpot is newer, skip (it will win).
 *   4. Otherwise update the HubSpot contact.
 *   5. Register sync ID + persist mapping & hash.
 */
export async function onWixContactUpdated(
  installation: IInstallation,
  wixContactId: string,
  wixContactData: Record<string, any>,
  source: SyncSource = 'wix_webhook',
): Promise<SyncResult> {
  const start = Date.now();
  const instanceId = installation.instanceId;

  logger.info('Scenario 2: Wix contact updated', { instanceId, wixContactId });

  // Module 6 — Map Wix fields → HubSpot properties
  const rules = await loadMappingRules(instanceId);
  const targetProps = wixToHubSpot(wixContactData, rules);

  // Module 5 — Layer 2: Idempotency hash
  const hash = computeHash(targetProps);
  let mapping: IContactMapping | null = await findByWixId(instanceId, wixContactId);

  // If we have a mapping, check idempotency
  if (mapping) {
    const skip = await shouldSkipWrite(
      instanceId,
      mapping.hubspotContactId,
      'hubspot',
      hash,
    );
    if (skip) {
      logger.debug('Idempotency skip (wix→hs)', { instanceId, wixContactId });
      await logEvent(instanceId, source, 'skip', wixContactId, mapping.hubspotContactId, 'success', 0);
      return {
        action: 'skip',
        source,
        wixContactId,
        hubspotContactId: mapping.hubspotContactId,
      };
    }
  }

  let action: SyncAction;
  let hubspotContactId = '';

  try {
    if (mapping) {
      // ── Conflict Resolution ──
      // Fetch the HubSpot contact to get its updatedAt timestamp
      const hsContact = await getHubSpotContactById(
        instanceId,
        mapping.hubspotContactId,
        ['email', 'firstname', 'lastname'],
      );

      if (hsContact) {
        const wixUpdatedAt =
          wixContactData?._updatedDate ||
          wixContactData?.updatedDate ||
          wixContactData?.info?._updatedDate ||
          null;

        const hsUpdatedAt = hsContact.updatedAt || null;

        const conflict = resolveConflict(wixUpdatedAt, hsUpdatedAt, 'wix');

        if (conflict.winner === 'hubspot') {
          // HubSpot is newer — skip this Wix→HS write
          logger.info('Conflict resolution: HubSpot wins (newer timestamp)', {
            instanceId,
            wixContactId,
            hubspotContactId: mapping.hubspotContactId,
            reason: conflict.reason,
            wixTs: conflict.wixTimestamp?.toISOString() ?? 'n/a',
            hsTs: conflict.hubspotTimestamp?.toISOString() ?? 'n/a',
          });
          await logEvent(
            instanceId, source, 'skip', wixContactId,
            mapping.hubspotContactId, 'skipped', Date.now() - start,
            `Conflict: ${conflict.reason}`, 'hubspot',
          );
          return {
            action: 'skip',
            source,
            wixContactId,
            hubspotContactId: mapping.hubspotContactId,
          };
        }

        // Wix wins — proceed with the update
        logger.info('Conflict resolution: Wix wins', {
          instanceId,
          wixContactId,
          hubspotContactId: mapping.hubspotContactId,
          reason: conflict.reason,
        });
      }

      // Update existing HubSpot contact
      await hubspot.updateContact(installation, mapping.hubspotContactId, targetProps);
      hubspotContactId = mapping.hubspotContactId;
      action = 'update';
    } else {
      // No mapping — this is actually a create scenario
      // (edge case: "updated" event but we never saw the create)
      logger.debug('No mapping found for updated Wix contact, treating as create', {
        instanceId,
        wixContactId,
      });
      return onWixContactCreated(installation, wixContactId, wixContactData, source);
    }

    // Module 5 — Layer 1: Register sync ID
    const syncId = await registerSyncId(instanceId, 'hubspot', hubspotContactId);

    // Module 4 — Persist mapping
    mapping = await upsertMapping({
      instanceId,
      wixContactId,
      hubspotContactId,
      lastSyncSource: 'wix',
      syncOperationId: syncId,
      propertyHash: hash,
    });

    // Write sync tag (fire-and-forget)
    writeSyncTag(instanceId, hubspotContactId, syncId).catch((tagErr) =>
      logger.warn('Failed to write sync tag', {
        instanceId,
        hubspotContactId,
        error: (tagErr as Error).message,
      }),
    );

    // Module 5 — Layer 2: Persist hash
    await updateHash(instanceId, hubspotContactId, 'hubspot', hash);

    const duration = Date.now() - start;
    await logEvent(instanceId, source, action, wixContactId, hubspotContactId, 'success', duration);
    return { action, source, wixContactId, hubspotContactId };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = (err as Error).message;
    logger.error('Scenario 2 failed: onWixContactUpdated', {
      instanceId,
      wixContactId,
      error: msg,
    });
    await logEvent(instanceId, source, 'update', wixContactId, hubspotContactId, 'failed', duration, msg);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3 — HubSpot Contact Created
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A brand-new contact was created in HubSpot. We need to:
 *   1. Convert HubSpot properties → Wix fields via the mapping engine.
 *   2. Check if a mapping already exists (duplicate webhook guard).
 *   3. Create a new Wix contact with sync metadata embedded.
 *   4. Register the sync ID so the resulting Wix webhook is suppressed.
 *   5. Persist the mapping and the idempotency hash.
 */
export async function onHubSpotContactCreated(
  installation: IInstallation,
  hubspotContactId: string,
  hubspotProps: FlatContact,
  source: SyncSource = 'hubspot_webhook',
): Promise<SyncResult> {
  const start = Date.now();
  const instanceId = installation.instanceId;

  logger.info('Scenario 3: HubSpot contact created', { instanceId, hubspotContactId });

  // Module 6 — Map HubSpot properties → Wix fields
  const rules = await loadMappingRules(instanceId);
  const targetProps = hubSpotToWix(hubspotProps, rules);

  // Module 5 — Layer 2: Idempotency hash
  const hash = computeHash(targetProps);

  let action: SyncAction;
  let wixContactId = '';

  try {
    // Check for existing mapping (duplicate webhook edge case)
    const existingMapping = await findByHubSpotId(instanceId, hubspotContactId);
    if (existingMapping) {
      logger.debug('Contact already mapped, delegating to update', {
        instanceId,
        hubspotContactId,
      });
      return onHubSpotContactUpdated(
        installation,
        hubspotContactId,
        hubspotProps,
        source,
      );
    }

    // Generate sync ID BEFORE writing so it can be embedded in the
    // Wix contact's extended fields for loop prevention
    const syncId = crypto.randomUUID();

    const syncMeta: SyncMetadata = {
      hubspotContactId,
      syncTagId: syncId,
      syncSource: 'hubspot',
    };

    const contactInput = {
      firstName: targetProps.firstName,
      lastName: targetProps.lastName,
      email: targetProps.email,
      phone: targetProps.phone,
      company: targetProps.company,
      jobTitle: targetProps.jobTitle,
    };

    // Create (or find-by-email) in Wix via Module 3
    const result = await createOrUpdateWixContact(
      installation,
      contactInput,
      syncMeta,
    );
    wixContactId = result.contactId;
    action = result.action === 'created' ? 'create' : 'update';

    logger.info('Wix contact created from HubSpot', {
      instanceId,
      hubspotContactId,
      wixContactId,
      action,
    });

    // Module 5 — Layer 1: Register the sync ID embedded in Wix contact
    await registerSyncId(instanceId, 'wix', wixContactId, syncId);

    // Module 4 — Persist mapping
    await upsertMapping({
      instanceId,
      wixContactId,
      hubspotContactId,
      lastSyncSource: 'hubspot',
      syncOperationId: syncId,
      propertyHash: hash,
    });

    // Module 5 — Layer 2: Persist idempotency hash
    await updateHash(instanceId, wixContactId, 'wix', hash);

    const duration = Date.now() - start;
    await logEvent(instanceId, source, action, wixContactId, hubspotContactId, 'success', duration);
    return { action, source, wixContactId, hubspotContactId };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = (err as Error).message;
    logger.error('Scenario 3 failed: onHubSpotContactCreated', {
      instanceId,
      hubspotContactId,
      error: msg,
    });
    await logEvent(instanceId, source, 'create', wixContactId, hubspotContactId, 'failed', duration, msg);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4 — HubSpot Contact Updated
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * An existing HubSpot contact was updated. We need to:
 *   1. Convert HubSpot properties → Wix fields.
 *   2. Check idempotency — if the Wix side already has this hash, skip.
 *   3. If a mapping exists, run conflict resolution against Wix's
 *      `_updatedDate` timestamp. If Wix is newer, skip.
 *   4. Otherwise update (or create) the Wix contact with sync metadata.
 *   5. Register sync ID + persist mapping & hash.
 */
export async function onHubSpotContactUpdated(
  installation: IInstallation,
  hubspotContactId: string,
  hubspotProps: FlatContact,
  source: SyncSource = 'hubspot_webhook',
): Promise<SyncResult> {
  const start = Date.now();
  const instanceId = installation.instanceId;

  logger.info('Scenario 4: HubSpot contact updated', { instanceId, hubspotContactId });

  // Module 6 — Map HubSpot properties → Wix fields
  const rules = await loadMappingRules(instanceId);
  const targetProps = hubSpotToWix(hubspotProps, rules);

  // Module 5 — Layer 2: Idempotency hash
  let mapping: IContactMapping | null = await findByHubSpotId(instanceId, hubspotContactId);
  const hash = computeHash(targetProps);

  // If we have a mapping, check idempotency
  if (mapping) {
    const skip = await shouldSkipWrite(
      instanceId,
      mapping.wixContactId,
      'wix',
      hash,
    );
    if (skip) {
      logger.debug('Idempotency skip (hs→wix)', { instanceId, hubspotContactId });
      await logEvent(instanceId, source, 'skip', mapping.wixContactId, hubspotContactId, 'success', 0);
      return {
        action: 'skip',
        source,
        wixContactId: mapping.wixContactId,
        hubspotContactId,
      };
    }
  }

  let action: SyncAction;
  let wixContactId = '';

  try {
    // Generate sync ID BEFORE writing
    const syncId = crypto.randomUUID();

    const syncMeta: SyncMetadata = {
      hubspotContactId,
      syncTagId: syncId,
      syncSource: 'hubspot',
    };

    const contactInput = {
      firstName: targetProps.firstName,
      lastName: targetProps.lastName,
      email: targetProps.email,
      phone: targetProps.phone,
      company: targetProps.company,
      jobTitle: targetProps.jobTitle,
    };

    if (mapping) {
      // ── Conflict Resolution ──
      // Fetch the Wix contact to get its _updatedDate
      const wixContact = await getWixContactById(installation, mapping.wixContactId);

      if (wixContact) {
        const wixUpdatedAt =
          (wixContact as any)?._updatedDate ||
          (wixContact as any)?.updatedDate ||
          (wixContact?.info as any)?._updatedDate ||
          null;

        // The HubSpot updatedAt comes from the webhook event or from
        // the properties payload's hs_lastmodifieddate
        const hsUpdatedAt =
          hubspotProps.hs_lastmodifieddate ||
          hubspotProps.lastmodifieddate ||
          null;

        const conflict = resolveConflict(wixUpdatedAt, hsUpdatedAt, 'hubspot');

        if (conflict.winner === 'wix') {
          // Wix is newer — skip this HS→Wix write
          logger.info('Conflict resolution: Wix wins (newer timestamp)', {
            instanceId,
            hubspotContactId,
            wixContactId: mapping.wixContactId,
            reason: conflict.reason,
            wixTs: conflict.wixTimestamp?.toISOString() ?? 'n/a',
            hsTs: conflict.hubspotTimestamp?.toISOString() ?? 'n/a',
          });
          await logEvent(
            instanceId, source, 'skip', mapping.wixContactId,
            hubspotContactId, 'skipped', Date.now() - start,
            `Conflict: ${conflict.reason}`, 'wix',
          );
          return {
            action: 'skip',
            source,
            wixContactId: mapping.wixContactId,
            hubspotContactId,
          };
        }

        // HubSpot wins — proceed with the update
        logger.info('Conflict resolution: HubSpot wins', {
          instanceId,
          hubspotContactId,
          wixContactId: mapping.wixContactId,
          reason: conflict.reason,
        });
      }

      // Update existing Wix contact via Module 3
      const result = await createOrUpdateWixContact(
        installation,
        contactInput,
        syncMeta,
        mapping.wixContactId,
      );
      wixContactId = result.contactId;
      action = 'update';
    } else {
      // No mapping — treat as a create
      logger.debug('No mapping found for updated HS contact, treating as create', {
        instanceId,
        hubspotContactId,
      });
      return onHubSpotContactCreated(installation, hubspotContactId, hubspotProps, source);
    }

    // Module 5 — Layer 1: Register sync ID
    await registerSyncId(instanceId, 'wix', wixContactId, syncId);

    // Module 4 — Persist mapping
    mapping = await upsertMapping({
      instanceId,
      wixContactId,
      hubspotContactId,
      lastSyncSource: 'hubspot',
      syncOperationId: syncId,
      propertyHash: hash,
    });

    // Module 5 — Layer 2: Persist hash
    await updateHash(instanceId, wixContactId, 'wix', hash);

    const duration = Date.now() - start;
    await logEvent(instanceId, source, action, wixContactId, hubspotContactId, 'success', duration);
    return { action, source, wixContactId, hubspotContactId };
  } catch (err) {
    const duration = Date.now() - start;
    const msg = (err as Error).message;
    logger.error('Scenario 4 failed: onHubSpotContactUpdated', {
      instanceId,
      hubspotContactId,
      error: msg,
    });
    await logEvent(instanceId, source, 'update', wixContactId, hubspotContactId, 'failed', duration, msg);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Full Sync — Page through all Wix contacts
// ═══════════════════════════════════════════════════════════════════════════════

export interface FullSyncResult {
  /** Contacts successfully synced (created or updated in HubSpot) */
  synced: number;
  /** Contacts skipped (already up-to-date via idempotency check) */
  skipped: number;
  /** Contacts that failed to sync */
  errors: number;
  /** Total contacts inspected */
  total: number;
  /** Duration of the full sync in milliseconds */
  durationMs: number;
}

/**
 * Pages through every Wix contact and syncs any that do not already have
 * a HubSpot mapping (or whose data has changed since the last sync).
 *
 * Flow:
 *   1. Create Wix SDK client.
 *   2. Load the field mapping rules once (cached).
 *   3. Query Wix contacts, paginating through all pages.
 *   4. For each contact:
 *      a. If no mapping exists → delegate to `onWixContactCreated`.
 *      b. If a mapping exists  → delegate to `onWixContactUpdated`
 *         (which includes idempotency + conflict resolution).
 *   5. Update `installation.lastSyncAt` on completion.
 *   6. Return aggregate stats.
 */
export async function runFullSync(
  installation: IInstallation,
): Promise<FullSyncResult> {
  const start = Date.now();
  const instanceId = installation.instanceId;
  logger.info('Full sync started', { instanceId });

  let synced = 0;
  let skipped = 0;
  let errors = 0;
  let total = 0;

  try {
    // Pre-load rules so each contact doesn't trigger a cache miss
    await loadMappingRules(instanceId);

    // ── Phase 1: Wix → HubSpot ─────────────────────────────────────────
    try {
      // Page through all Wix contacts via REST API
      let offset = 0;
      const pageSize = 100;
      let hasMore = true;
      do {
        const res = await listWixContacts(installation, pageSize, offset);
        const items: any[] = res.contacts ?? [];
        hasMore = items.length === pageSize;
        offset += items.length;

      for (const wc of items) {
        total++;
        const contactId: string = wc.id || wc._id;
        if (!contactId) {
          logger.warn('Full sync: Wix contact missing id, skipping');
          errors++;
          continue;
        }

        try {
          // Determine whether this is a create or update scenario
          const mapping = await findByWixId(instanceId, contactId);

          let result: SyncResult;
          if (mapping) {
            // Already mapped — run update scenario (includes conflict resolution)
            result = await onWixContactUpdated(
              installation,
              contactId,
              wc,
              'initial_sync',
            );
          } else {
            // Not yet mapped — run create scenario
            result = await onWixContactCreated(
              installation,
              contactId,
              wc,
              'initial_sync',
            );
          }

          if (result.action === 'skip') {
            skipped++;
          } else {
            synced++;
          }
        } catch (err) {
          errors++;
          logger.error('Full sync: contact failed', {
            instanceId,
            wixContactId: contactId,
            error: (err as Error).message,
          });
        }
      }
    } while (hasMore);
    } catch (wixErr) {
      logger.warn('Full sync Phase 1 (Wix→HubSpot) failed — continuing to Phase 2', {
        instanceId,
        error: (wixErr as Error).message,
      });
    }

    // ── Phase 2: Pull HubSpot contacts that are not yet mapped ──────────
    logger.info('Full sync Phase 2: pulling HubSpot contacts', { instanceId });
    let hsAfter: string | undefined;
    try {
      do {
        const hsRes = await withRetry(instanceId, (client) =>
          client.get('/crm/v3/objects/contacts', {
            params: {
              properties: 'firstname,lastname,email,phone,company,jobtitle',
              limit: 100,
              ...(hsAfter ? { after: hsAfter } : {}),
            },
          }),
        );
        const hsContacts: any[] = hsRes.data?.results ?? [];

        for (const hc of hsContacts) {
          total++;
          const hubspotContactId = String(hc.id);
          try {
            const existing = await findByHubSpotId(instanceId, hubspotContactId);
            if (existing) {
              skipped++;
              continue;
            }
            const hsProps: FlatContact = hc.properties ?? {};
            const result = await onHubSpotContactCreated(
              installation,
              hubspotContactId,
              hsProps,
              'initial_sync',
            );
            if (result.action === 'skip') {
              skipped++;
            } else {
              synced++;
            }
          } catch (err) {
            errors++;
            logger.error('Full sync Phase 2: HubSpot contact failed', {
              instanceId,
              hubspotContactId,
              error: (err as Error).message,
            });
          }
        }

        hsAfter = hsRes.data?.paging?.next?.after;
      } while (hsAfter);
    } catch (err) {
      logger.error('Full sync Phase 2 failed', {
        instanceId,
        error: (err as Error).message,
      });
    }

    // Update the installation's last-sync timestamp
    installation.lastSyncAt = new Date();
    await installation.save();
  } catch (err) {
    logger.error('Full sync failed', {
      instanceId,
      error: (err as Error).message,
    });
  }

  const durationMs = Date.now() - start;
  logger.info('Full sync complete', {
    instanceId,
    synced,
    skipped,
    errors,
    total,
    durationMs,
  });

  return { synced, skipped, errors, total, durationMs };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Convenience: Dispatch from generic webhook payload
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dispatches a Wix webhook to the appropriate scenario handler based on
 * whether a mapping already exists for the contact.
 *
 * This is the single entry point used by the Wix webhook route.
 */
export async function handleWixWebhook(
  installation: IInstallation,
  wixContactId: string,
  wixContactData: Record<string, any>,
  eventType: 'created' | 'updated',
  source: SyncSource = 'wix_webhook',
): Promise<SyncResult> {
  if (eventType === 'created') {
    return onWixContactCreated(installation, wixContactId, wixContactData, source);
  }
  return onWixContactUpdated(installation, wixContactId, wixContactData, source);
}

/**
 * Dispatches a HubSpot webhook to the appropriate scenario handler based on
 * whether a mapping already exists for the contact.
 *
 * This is the single entry point used by the HubSpot webhook route.
 */
export async function handleHubSpotWebhook(
  installation: IInstallation,
  hubspotContactId: string,
  hubspotProps: FlatContact,
  eventType: 'created' | 'updated',
  source: SyncSource = 'hubspot_webhook',
): Promise<SyncResult> {
  if (eventType === 'created') {
    return onHubSpotContactCreated(installation, hubspotContactId, hubspotProps, source);
  }
  return onHubSpotContactUpdated(installation, hubspotContactId, hubspotProps, source);
}
