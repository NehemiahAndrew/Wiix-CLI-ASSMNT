// =============================================================================
// Deduplication Guard Tests (Module 5-A)
// =============================================================================
// Tests: registerSyncId, isSyncEcho, extractSyncId, clearMemoryCache,
//        memoryCacheSize
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';

// ── Mock SyncDedupeLog model ────────────────────────────────────────────────
jest.mock('../models/SyncDedupeLog', () => {
  const store = new Map<string, any>();
  return {
    __esModule: true,
    default: {
      create: jest.fn(async (doc: any) => {
        store.set(doc.syncId, doc);
        return doc;
      }),
      findOne: jest.fn((query: any) => ({
        lean: jest.fn(async () => store.get(query.syncId) ?? null),
      })),
      _store: store, // exposed for test cleanup
    },
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  registerSyncId,
  isSyncEcho,
  extractSyncId,
  clearMemoryCache,
  memoryCacheSize,
} from '../services/dedupeGuard';
import SyncDedupeLog from '../models/SyncDedupeLog';

beforeEach(() => {
  clearMemoryCache();
  (SyncDedupeLog as any)._store.clear();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// registerSyncId + isSyncEcho
// ─────────────────────────────────────────────────────────────────────────────

describe('registerSyncId', () => {
  it('should generate a UUID when none is provided', async () => {
    const id = await registerSyncId('inst-1', 'hubspot', 'contact-1');
    expect(id).toBeDefined();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(10);
  });

  it('should use a pre-generated syncId when provided', async () => {
    const id = await registerSyncId('inst-1', 'wix', 'contact-1', 'my-custom-id');
    expect(id).toBe('my-custom-id');
  });

  it('should persist the syncId to the database', async () => {
    await registerSyncId('inst-1', 'hubspot', 'c-1', 'db-test-id');
    expect(SyncDedupeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        syncId: 'db-test-id',
        instanceId: 'inst-1',
        side: 'hubspot',
        contactId: 'c-1',
      }),
    );
  });

  it('should store the syncId in the in-memory cache', async () => {
    const id = await registerSyncId('inst-1', 'hubspot', 'c-1');
    expect(memoryCacheSize()).toBe(1);
    expect(await isSyncEcho(id)).toBe(true);
  });
});

describe('isSyncEcho', () => {
  it('should return true for a registered sync ID (memory hit)', async () => {
    const id = await registerSyncId('inst-1', 'hubspot', 'c-1');
    const result = await isSyncEcho(id);
    expect(result).toBe(true);
  });

  it('should return false for an ID that was never registered', async () => {
    const result = await isSyncEcho('never-seen-id');
    expect(result).toBe(false);
  });

  it('should return false for undefined / empty', async () => {
    expect(await isSyncEcho(undefined)).toBe(false);
    expect(await isSyncEcho('')).toBe(false);
  });

  it('should return true via DB fallback when not in memory', async () => {
    // Manually insert into the mock DB store but NOT the memory cache
    (SyncDedupeLog as any)._store.set('db-only-id', {
      syncId: 'db-only-id',
      instanceId: 'inst-1',
      side: 'wix',
      contactId: 'c-1',
    });

    const result = await isSyncEcho('db-only-id');
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSyncId
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSyncId', () => {
  it('should extract from HubSpot contact properties.wix_sync_tag', () => {
    const data = { properties: { wix_sync_tag: 'sync-uuid-123' } };
    expect(extractSyncId(data, 'hubspot')).toBe('sync-uuid-123');
  });

  it('should extract from HubSpot top-level wix_sync_tag', () => {
    const data = { wix_sync_tag: 'top-level-tag' };
    expect(extractSyncId(data, 'hubspot')).toBe('top-level-tag');
  });

  it('should return undefined when HubSpot data has no sync tag', () => {
    const data = { properties: { firstname: 'John' } };
    expect(extractSyncId(data, 'hubspot')).toBeUndefined();
  });

  it('should extract from Wix extendedFields', () => {
    const data = {
      info: {
        extendedFields: {
          items: {
            'custom.wix_sync_tag': { value: 'wix-sync-uuid' },
          },
        },
      },
    };
    expect(extractSyncId(data, 'wix')).toBe('wix-sync-uuid');
  });

  it('should extract from Wix flat extended fields', () => {
    const data = {
      extendedFields: { 'custom.wix_sync_tag': 'flat-sync-tag' },
    };
    expect(extractSyncId(data, 'wix')).toBe('flat-sync-tag');
  });

  it('should return undefined when Wix data has no sync tag', () => {
    const data = { info: { name: { first: 'John' } } };
    expect(extractSyncId(data, 'wix')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearMemoryCache / memoryCacheSize
// ─────────────────────────────────────────────────────────────────────────────

describe('clearMemoryCache / memoryCacheSize', () => {
  it('should report 0 when empty', () => {
    expect(memoryCacheSize()).toBe(0);
  });

  it('should report correct size after registering IDs', async () => {
    await registerSyncId('inst-1', 'wix', 'c-1', 'id-a');
    await registerSyncId('inst-1', 'wix', 'c-2', 'id-b');
    expect(memoryCacheSize()).toBe(2);
  });

  it('should clear all entries', async () => {
    await registerSyncId('inst-1', 'wix', 'c-1', 'id-a');
    clearMemoryCache();
    expect(memoryCacheSize()).toBe(0);
    expect(await isSyncEcho('id-a')).toBe(true); // still in DB
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// should-ignore integration (register → echo → check)
// ─────────────────────────────────────────────────────────────────────────────

describe('should-ignore integration', () => {
  it('should correctly identify our own sync tag in a webhook payload', async () => {
    const syncId = await registerSyncId('inst-1', 'hubspot', 'hs-contact-1');

    // Simulate HubSpot echoing back with the sync tag
    const webhookData = { properties: { wix_sync_tag: syncId } };
    const extracted = extractSyncId(webhookData, 'hubspot');
    const isEcho = await isSyncEcho(extracted);

    expect(isEcho).toBe(true);
  });

  it('should NOT ignore a genuine webhook (no matching sync ID)', async () => {
    await registerSyncId('inst-1', 'hubspot', 'hs-contact-1');

    // Webhook from a different contact / user action — different tag
    const webhookData = { properties: { wix_sync_tag: 'external-user-edit' } };
    const extracted = extractSyncId(webhookData, 'hubspot');
    const isEcho = await isSyncEcho(extracted);

    expect(isEcho).toBe(false);
  });

  it('should NOT ignore a webhook with no sync tag at all', async () => {
    await registerSyncId('inst-1', 'hubspot', 'hs-contact-1');

    const webhookData = { properties: { firstname: 'Jane' } };
    const extracted = extractSyncId(webhookData, 'hubspot');
    const isEcho = await isSyncEcho(extracted);

    expect(isEcho).toBe(false);
  });
});
