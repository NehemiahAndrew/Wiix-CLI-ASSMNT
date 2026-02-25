// =============================================================================
// Sync Engine — Backwards-compatible façade over Module 7 Orchestrator
// =============================================================================
// This file now delegates all sync logic to the Module 7 Sync Orchestrator
// (syncOrchestrator.ts). Existing callers that import from syncEngine.ts
// continue to work without changes.
//
// New code should import directly from syncOrchestrator.ts.
// =============================================================================
import { IInstallation } from '../models/Installation';
import {
  onWixContactCreated,
  onWixContactUpdated,
  onHubSpotContactCreated,
  onHubSpotContactUpdated,
  handleWixWebhook,
  handleHubSpotWebhook,
  runFullSync as orchestratorFullSync,
  type FullSyncResult,
} from './syncOrchestrator';
import { FlatContact, SyncResult, SyncSource } from '../types';

/* ────────────────────────────────────────────────────────────────────────────
 * Legacy wrappers — delegate to the appropriate orchestrator scenario
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Sync a Wix contact → HubSpot.
 *
 * Inspects whether a mapping exists to decide between create / update
 * scenarios in the orchestrator.
 *
 * @deprecated Use `handleWixWebhook` or the individual scenario functions
 *             from `syncOrchestrator` directly.
 */
export async function syncWixToHubspot(
  installation: IInstallation,
  wixContactId: string,
  wixContactData: Record<string, any>,
  source: SyncSource = 'wix_webhook',
): Promise<SyncResult> {
  // The orchestrator's onWixContactCreated already checks for an existing
  // mapping and delegates to onWixContactUpdated when necessary, so we can
  // safely route everything through the "created" handler — it will do the
  // right thing.
  return onWixContactCreated(installation, wixContactId, wixContactData, source);
}

/**
 * Sync a HubSpot contact → Wix.
 *
 * @deprecated Use `handleHubSpotWebhook` or the individual scenario
 *             functions from `syncOrchestrator` directly.
 */
export async function syncHubspotToWix(
  installation: IInstallation,
  hubspotContactId: string,
  hubspotProps: FlatContact,
  source: SyncSource = 'hubspot_webhook',
): Promise<SyncResult> {
  return onHubSpotContactCreated(installation, hubspotContactId, hubspotProps, source);
}

/**
 * Run a full sync (page through all Wix contacts → HubSpot).
 */
export async function runFullSync(
  installation: IInstallation,
): Promise<FullSyncResult> {
  return orchestratorFullSync(installation);
}

// Re-export the new scenario functions so callers can migrate gradually
export {
  onWixContactCreated,
  onWixContactUpdated,
  onHubSpotContactCreated,
  onHubSpotContactUpdated,
  handleWixWebhook,
  handleHubSpotWebhook,
  type FullSyncResult,
};
