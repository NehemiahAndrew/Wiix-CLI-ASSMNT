// =============================================================================
// Module 4: Contact ID Mapping Store
// =============================================================================
// Remembers which Wix contact corresponds to which HubSpot contact.
//
// Stored in the MongoDB collection "HubSpotContactMapping". Each record links:
//   • wixContactId ↔ hubspotContactId
//   • lastSyncedAt, lastSyncSource ('wix' | 'hubspot')
//   • syncOperationId (UUID of the sync that created/updated the link)
//
// Five operations:
//   1. findByWixId        — look up a mapping by Wix contact ID
//   2. findByHubSpotId    — look up a mapping by HubSpot contact ID
//   3. upsertMapping      — create or update a mapping
//   4. deleteMapping      — remove a mapping when a contact is deleted
//   5. setupCollection    — ensure the collection and indexes exist
//
// Performance:
//   • LRU cache (max 500 entries, 5-minute TTL) avoids redundant DB reads
//   • Cache is keyed by both Wix ID and HubSpot ID for fast lookups from
//     either direction
//
// Error handling:
//   • All raw Mongoose errors are caught and re-thrown as DatabaseError
//   • Error messages never include actual contact data
// =============================================================================
import ContactMapping, { IContactMapping } from '../models/ContactMapping';
import { LRUCache } from '../utils/lruCache';
import { DatabaseError, DatabaseOperation } from '../utils/DatabaseError';
import logger from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Cache — 500 entries, 5-minute TTL
// ─────────────────────────────────────────────────────────────────────────────

/** Cache keyed as "wix:<instanceId>:<wixContactId>" or "hs:<instanceId>:<hubspotContactId>" */
const cache = new LRUCache<string, IContactMapping>(500, 5 * 60 * 1000);

/** Build a cache key for the Wix side */
function wixKey(instanceId: string, wixContactId: string): string {
  return `wix:${instanceId}:${wixContactId}`;
}

/** Build a cache key for the HubSpot side */
function hsKey(instanceId: string, hubspotContactId: string): string {
  return `hs:${instanceId}:${hubspotContactId}`;
}

/** Store a mapping in cache under both keys */
function cacheMapping(instanceId: string, mapping: IContactMapping): void {
  cache.set(wixKey(instanceId, mapping.wixContactId), mapping);
  cache.set(hsKey(instanceId, mapping.hubspotContactId), mapping);
}

/** Evict a mapping from cache by both keys */
function evictMapping(
  instanceId: string,
  wixContactId: string,
  hubspotContactId: string,
): void {
  cache.delete(wixKey(instanceId, wixContactId));
  cache.delete(hsKey(instanceId, hubspotContactId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: wrap DB calls with DatabaseError
// ─────────────────────────────────────────────────────────────────────────────

async function safeDbCall<T>(
  operation: DatabaseOperation,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new DatabaseError(operation, err as Error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Find by Wix contact ID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Looks up a mapping by the Wix contact ID.
 *
 * Checks the in-memory cache first. On a cache miss, queries MongoDB
 * and caches the result.
 *
 * @param instanceId    — Wix site instance
 * @param wixContactId  — Wix contact ID
 * @returns             — The mapping, or `null` if none exists
 * @throws DatabaseError
 */
export async function findByWixId(
  instanceId: string,
  wixContactId: string,
): Promise<IContactMapping | null> {
  // Cache check
  const cached = cache.get(wixKey(instanceId, wixContactId));
  if (cached) {
    logger.debug('Mapping cache hit (wix)', { instanceId });
    return cached;
  }

  // DB lookup
  const mapping = await safeDbCall('findByWixId', () =>
    ContactMapping.findOne({ instanceId, wixContactId }),
  );

  if (mapping) {
    cacheMapping(instanceId, mapping);
  }

  return mapping;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Find by HubSpot contact ID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Looks up a mapping by the HubSpot contact ID.
 *
 * @param instanceId        — Wix site instance
 * @param hubspotContactId  — HubSpot contact ID
 * @returns                 — The mapping, or `null` if none exists
 * @throws DatabaseError
 */
export async function findByHubSpotId(
  instanceId: string,
  hubspotContactId: string,
): Promise<IContactMapping | null> {
  // Cache check
  const cached = cache.get(hsKey(instanceId, hubspotContactId));
  if (cached) {
    logger.debug('Mapping cache hit (hubspot)', { instanceId });
    return cached;
  }

  // DB lookup
  const mapping = await safeDbCall('findByHubSpotId', () =>
    ContactMapping.findOne({ instanceId, hubspotContactId }),
  );

  if (mapping) {
    cacheMapping(instanceId, mapping);
  }

  return mapping;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create or update a mapping
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertMappingInput {
  instanceId: string;
  wixContactId: string;
  hubspotContactId: string;
  lastSyncSource: 'wix' | 'hubspot' | 'manual';
  syncOperationId: string;
  propertyHash?: string;
}

/**
 * Creates a new mapping or updates an existing one.
 *
 * The mapping is matched by `instanceId + wixContactId`. If found, it is
 * updated in place. If not found, a new document is created.
 *
 * The cache is updated after a successful write.
 *
 * @param input — Mapping data
 * @returns     — The created or updated mapping document
 * @throws DatabaseError
 */
export async function upsertMapping(
  input: UpsertMappingInput,
): Promise<IContactMapping> {
  const mapping = await safeDbCall('upsert', () =>
    ContactMapping.findOneAndUpdate(
      {
        instanceId: input.instanceId,
        wixContactId: input.wixContactId,
      },
      {
        $set: {
          hubspotContactId: input.hubspotContactId,
          lastSyncSource: input.lastSyncSource,
          lastSyncedAt: new Date(),
          syncOperationId: input.syncOperationId,
          ...(input.propertyHash !== undefined
            ? { propertyHash: input.propertyHash }
            : {}),
        },
        $setOnInsert: {
          instanceId: input.instanceId,
          wixContactId: input.wixContactId,
        },
      },
      { upsert: true, new: true },
    ),
  );

  // Update cache
  cacheMapping(input.instanceId, mapping!);

  logger.debug('Mapping upserted', {
    instanceId: input.instanceId,
    syncSource: input.lastSyncSource,
  });

  return mapping!;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Delete a mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes a mapping when a contact is removed from either system.
 *
 * Can be called with either side's ID — the function figures out which
 * key was provided. Both cache entries are evicted.
 *
 * @param instanceId        — Wix site instance
 * @param wixContactId      — Wix contact ID (optional if hubspotContactId is provided)
 * @param hubspotContactId  — HubSpot contact ID (optional if wixContactId is provided)
 * @returns                 — `true` if a mapping was deleted, `false` if none found
 * @throws DatabaseError
 */
export async function deleteMapping(
  instanceId: string,
  wixContactId?: string,
  hubspotContactId?: string,
): Promise<boolean> {
  if (!wixContactId && !hubspotContactId) {
    throw new DatabaseError(
      'delete',
      new Error('Either wixContactId or hubspotContactId must be provided'),
    );
  }

  // Build the query filter
  const filter: Record<string, string> = { instanceId };
  if (wixContactId) filter.wixContactId = wixContactId;
  if (hubspotContactId) filter.hubspotContactId = hubspotContactId;

  // Find first so we can evict cache with both IDs
  const existing = await safeDbCall('delete', () =>
    ContactMapping.findOneAndDelete(filter),
  );

  if (!existing) return false;

  // Evict cache
  evictMapping(instanceId, existing.wixContactId, existing.hubspotContactId);

  logger.debug('Mapping deleted', { instanceId });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Setup — ensure collection and indexes exist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the HubSpotContactMapping collection and its indexes exist.
 *
 * This should be called once when the app first starts or when a new
 * installation is created. It is idempotent — calling it multiple times
 * is safe.
 *
 * Mongoose automatically creates indexes defined in the schema on
 * `ensureIndexes()`, but we call it explicitly here so the setup can
 * be invoked at a predictable time rather than relying on lazy creation.
 *
 * @throws DatabaseError
 */
export async function setupCollection(): Promise<void> {
  await safeDbCall('setup', async () => {
    // Force Mongoose to create the collection if it doesn't exist
    await ContactMapping.createCollection();

    // Ensure all indexes defined in the schema are built
    await ContactMapping.ensureIndexes();

    logger.info('HubSpotContactMapping collection and indexes verified');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: count mappings (used by the stats endpoint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the total number of mappings for an instance.
 *
 * @param instanceId — Wix site instance
 * @throws DatabaseError
 */
export async function countMappings(instanceId: string): Promise<number> {
  return safeDbCall('count', () =>
    ContactMapping.countDocuments({ instanceId }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache management (exposed for testing / admin)
// ─────────────────────────────────────────────────────────────────────────────

/** Clear the entire mapping cache. */
export function clearCache(): void {
  cache.clear();
}

/** Get the current cache size. */
export function cacheSize(): number {
  return cache.size;
}
