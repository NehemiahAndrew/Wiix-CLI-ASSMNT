// =============================================================================
// Module 5-B: Idempotency Checker
// =============================================================================
// Second layer of loop prevention.  Even if a webhook passes the dedupe
// guard, we still do not want to write the same values to a contact
// repeatedly.
//
// How it works:
//   1. computeHash(props) — SHA-256 of sorted normalised field values
//   2. shouldSkipWrite()  — compare the new hash to the stored hash
//   3. updateHash()       — persist the new hash after a successful write
//
// Hashes are stored in the ContactHashCache MongoDB collection, keyed by
// (instanceId, contactId, side).  The collection has a 30-day TTL on
// updatedAt so stale entries are cleaned up automatically.
// =============================================================================
import crypto from 'crypto';
import ContactHashCache from '../models/ContactHashCache';
import logger from '../utils/logger';
import { FlatContact } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Compute a deterministic hash from mapped field values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a SHA-256 hex digest of the contact's mapped field values.
 *
 * Keys are sorted alphabetically.  Empty / undefined values are
 * normalised to the empty string so that key order and whitespace
 * differences do not produce false mismatches.
 *
 * @param props — Flat key-value object of mapped contact fields
 */
export function computeHash(props: FlatContact): string {
  const sorted = Object.keys(props)
    .sort()
    .map((k) => `${k}=${(props[k] ?? '').toString().trim().toLowerCase()}`)
    .join('|');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Compare new hash against stored hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `true` if the new hash matches the stored hash — meaning
 * nothing has actually changed and the write should be skipped.
 *
 * @param instanceId — Wix site instance
 * @param contactId  — Contact ID on whichever side we are about to write
 * @param side       — 'wix' or 'hubspot'
 * @param newHash    — The hash we just computed from the mapped fields
 */
export async function shouldSkipWrite(
  instanceId: string,
  contactId: string,
  side: 'wix' | 'hubspot',
  newHash: string,
): Promise<boolean> {
  try {
    const entry = await ContactHashCache.findOne({
      instanceId,
      contactId,
      side,
    }).lean();

    if (entry && entry.hash === newHash) {
      logger.debug('Idempotency skip — hash unchanged', {
        instanceId,
        side,
        hash: newHash.slice(0, 12),
      });
      return true;
    }
  } catch (err) {
    // On DB error, fail open — allow the write to proceed rather than
    // risk silently dropping a genuine change
    logger.warn('ContactHashCache lookup failed, failing open', {
      instanceId,
      error: (err as Error).message,
    });
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Persist the hash after a successful write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores (or updates) the hash for a contact so future writes can be
 * compared against it.
 *
 * @param instanceId — Wix site instance
 * @param contactId  — Contact ID on the written side
 * @param side       — 'wix' or 'hubspot'
 * @param hash       — SHA-256 hex digest to store
 */
export async function updateHash(
  instanceId: string,
  contactId: string,
  side: 'wix' | 'hubspot',
  hash: string,
): Promise<void> {
  try {
    await ContactHashCache.findOneAndUpdate(
      { instanceId, contactId, side },
      { $set: { hash, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    // Non-fatal: the next sync cycle will simply recompute and retry
    logger.warn('Failed to update ContactHashCache', {
      instanceId,
      side,
      error: (err as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes all cached hashes for a given contact (called when a contact
 * is deleted from either side).
 */
export async function clearHashesForContact(
  instanceId: string,
  contactId: string,
): Promise<void> {
  try {
    await ContactHashCache.deleteMany({ instanceId, contactId });
  } catch (err) {
    logger.warn('Failed to clear hashes for contact', {
      instanceId,
      error: (err as Error).message,
    });
  }
}
