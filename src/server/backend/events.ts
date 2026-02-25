// =============================================================================
// Module 11-A: Wix CRM Event Hooks
// =============================================================================
// This file mirrors the "backend/events.js" convention in Wix Velo.
// The platform calls the exported functions automatically whenever a CRM
// contact is created or updated on the Wix side.
//
// Key design decisions:
//   • `.then()` / `.catch()` instead of `await` — Wix event hooks must return
//     quickly; the sync work runs asynchronously in the background.
//   • Sanitised error logging — `sanitizeMessage` strips PII / tokens so
//     server logs never leak sensitive data.
//   • Installation lookup — each event carries an `instanceId` that is
//     resolved to the full Installation document before calling the
//     sync orchestrator.
// =============================================================================

import Installation, { IInstallation } from '../models/Installation';
import {
  onWixContactCreated as syncContactCreated,
  onWixContactUpdated as syncContactUpdated,
} from '../services/syncOrchestrator';
import { sanitizeMessage } from '../utils/sanitizeError';
import logger from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the Installation document for the given `instanceId`.
 * Returns `null` (with a warning log) when the site is not found or
 * sync is disabled — the event is effectively a no-op in that case.
 */
async function resolveInstallation(
  instanceId: string,
  eventName: string,
): Promise<IInstallation | null> {
  const installation = await Installation.findOne({ instanceId });

  if (!installation) {
    logger.warn(`${eventName}: no installation found — ignoring`, { instanceId });
    return null;
  }

  if (!installation.connected) {
    logger.debug(`${eventName}: HubSpot not connected — ignoring`, { instanceId });
    return null;
  }

  if (!installation.syncEnabled) {
    logger.debug(`${eventName}: sync disabled — ignoring`, { instanceId });
    return null;
  }

  return installation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wix CRM Event Hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggered by the Wix platform when a new CRM contact is created.
 *
 * Kicks off a background sync to HubSpot using `.then()` (not `await`)
 * so the event handler returns immediately — Wix event hooks have a
 * tight execution budget.
 *
 * @param event — Wix CRM contact-created event payload
 */
export function wixCrm_onContactCreated(event: {
  metadata?: { instanceId?: string };
  entity?: Record<string, any>;
  contactId?: string;
  contact?: Record<string, any>;
}): void {
  const instanceId =
    event.metadata?.instanceId ?? (event as Record<string, any>).instanceId ?? '';
  const contactId =
    event.contactId ?? event.entity?.id ?? event.entity?._id ?? event.contact?.id ?? event.contact?._id ?? '';
  const contactData: Record<string, any> = event.entity ?? event.contact ?? {};

  if (!instanceId || !contactId) {
    logger.warn('wixCrm_onContactCreated: missing instanceId or contactId', {
      instanceId,
      contactId,
    });
    return;
  }

  resolveInstallation(instanceId, 'wixCrm_onContactCreated')
    .then((installation) => {
      if (!installation) return;

      syncContactCreated(installation, contactId, contactData, 'wix_webhook')
        .then((result) => {
          logger.info('wixCrm_onContactCreated: sync complete', {
            instanceId,
            wixContactId: contactId,
            action: result.action,
            hubspotContactId: result.hubspotContactId,
          });
        })
        .catch((err: unknown) => {
          logger.error('wixCrm_onContactCreated: sync failed', {
            instanceId,
            wixContactId: contactId,
            error: sanitizeMessage((err as Error).message ?? String(err)),
          });
        });
    })
    .catch((err: unknown) => {
      logger.error('wixCrm_onContactCreated: installation lookup failed', {
        instanceId,
        wixContactId: contactId,
        error: sanitizeMessage((err as Error).message ?? String(err)),
      });
    });
}

/**
 * Triggered by the Wix platform when an existing CRM contact is updated.
 *
 * Same fire-and-forget pattern as `wixCrm_onContactCreated` — resolves
 * the installation, then runs the sync in a `.then()` chain.
 *
 * @param event — Wix CRM contact-updated event payload
 */
export function wixCrm_onContactUpdated(event: {
  metadata?: { instanceId?: string };
  entity?: Record<string, any>;
  contactId?: string;
  contact?: Record<string, any>;
}): void {
  const instanceId =
    event.metadata?.instanceId ?? (event as Record<string, any>).instanceId ?? '';
  const contactId =
    event.contactId ?? event.entity?.id ?? event.entity?._id ?? event.contact?.id ?? event.contact?._id ?? '';
  const contactData: Record<string, any> = event.entity ?? event.contact ?? {};

  if (!instanceId || !contactId) {
    logger.warn('wixCrm_onContactUpdated: missing instanceId or contactId', {
      instanceId,
      contactId,
    });
    return;
  }

  resolveInstallation(instanceId, 'wixCrm_onContactUpdated')
    .then((installation) => {
      if (!installation) return;

      syncContactUpdated(installation, contactId, contactData, 'wix_webhook')
        .then((result) => {
          logger.info('wixCrm_onContactUpdated: sync complete', {
            instanceId,
            wixContactId: contactId,
            action: result.action,
            hubspotContactId: result.hubspotContactId,
          });
        })
        .catch((err: unknown) => {
          logger.error('wixCrm_onContactUpdated: sync failed', {
            instanceId,
            wixContactId: contactId,
            error: sanitizeMessage((err as Error).message ?? String(err)),
          });
        });
    })
    .catch((err: unknown) => {
      logger.error('wixCrm_onContactUpdated: installation lookup failed', {
        instanceId,
        wixContactId: contactId,
        error: sanitizeMessage((err as Error).message ?? String(err)),
      });
    });
}
