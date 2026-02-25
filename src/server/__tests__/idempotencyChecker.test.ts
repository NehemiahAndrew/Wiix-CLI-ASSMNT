// =============================================================================
// Idempotency Checker Tests (Module 5-B)
// =============================================================================
// Tests: computeHash, shouldSkipWrite, updateHash
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';

// ── Mock ContactHashCache model ─────────────────────────────────────────────
const hashStore = new Map<string, any>();

jest.mock('../models/ContactHashCache', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn((query: any) => {
      const key = `${query.instanceId}:${query.contactId}:${query.side}`;
      const entry = hashStore.get(key);
      return {
        lean: jest.fn(async () => (entry ? entry : null)),
      };
    }),
    findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
      const key = `${filter.instanceId}:${filter.contactId}:${filter.side}`;
      const doc = { ...filter, hash: update.$set.hash, updatedAt: new Date() };
      hashStore.set(key, doc);
      return doc;
    }),
    deleteMany: jest.fn(async (filter: any) => {
      for (const [key] of hashStore) {
        if (key.startsWith(`${filter.instanceId}:${filter.contactId}:`)) {
          hashStore.delete(key);
        }
      }
    }),
  },
}));

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
  computeHash,
  shouldSkipWrite,
  updateHash,
  clearHashesForContact,
} from '../services/idempotencyChecker';
import ContactHashCache from '../models/ContactHashCache';

beforeEach(() => {
  hashStore.clear();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// computeHash — deterministic hashing
// ─────────────────────────────────────────────────────────────────────────────

describe('computeHash', () => {
  it('should produce the same hash for identical properties', () => {
    const a = computeHash({ firstName: 'John', lastName: 'Doe', email: 'john@example.com' });
    const b = computeHash({ firstName: 'John', lastName: 'Doe', email: 'john@example.com' });
    expect(a).toBe(b);
  });

  it('should produce the same hash regardless of key insertion order', () => {
    const a = computeHash({ email: 'a@b.com', firstName: 'A' });
    const b = computeHash({ firstName: 'A', email: 'a@b.com' });
    expect(a).toBe(b);
  });

  it('should produce different hashes when any field value changes', () => {
    const base = computeHash({ firstName: 'John', email: 'john@test.com' });
    const changed = computeHash({ firstName: 'Jane', email: 'john@test.com' });
    expect(base).not.toBe(changed);
  });

  it('should produce different hash when email changes', () => {
    const base = computeHash({ firstName: 'John', email: 'a@b.com' });
    const changed = computeHash({ firstName: 'John', email: 'different@b.com' });
    expect(base).not.toBe(changed);
  });

  it('should produce a 64-char hex string (SHA-256)', () => {
    const hash = computeHash({ foo: 'bar' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should normalise undefined fields to empty string', () => {
    const a = computeHash({ firstName: undefined });
    const b = computeHash({ firstName: '' });
    expect(a).toBe(b);
  });

  it('should normalise case (toLowerCase) and trim whitespace', () => {
    const a = computeHash({ firstName: '  JOHN  ' });
    const b = computeHash({ firstName: 'john' });
    expect(a).toBe(b);
  });

  it('should produce different hashes for completely different contacts', () => {
    const contact1 = computeHash({ firstName: 'Alice', email: 'alice@wonderland.com' });
    const contact2 = computeHash({ firstName: 'Bob', email: 'bob@builder.com' });
    expect(contact1).not.toBe(contact2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldSkipWrite — idempotency check against stored hash
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldSkipWrite', () => {
  it('should return false when no hash is stored (contact never synced)', async () => {
    const hash = computeHash({ firstName: 'John' });
    const skip = await shouldSkipWrite('inst-1', 'c-1', 'hubspot', hash);
    expect(skip).toBe(false);
  });

  it('should return true when the hash matches the stored hash (not changed)', async () => {
    const hash = computeHash({ firstName: 'John', email: 'john@test.com' });

    // Pre-store a matching hash
    hashStore.set('inst-1:c-1:hubspot', {
      instanceId: 'inst-1',
      contactId: 'c-1',
      side: 'hubspot',
      hash,
    });

    const skip = await shouldSkipWrite('inst-1', 'c-1', 'hubspot', hash);
    expect(skip).toBe(true);
  });

  it('should return false when the hash differs (contact changed)', async () => {
    const oldHash = computeHash({ firstName: 'John' });
    const newHash = computeHash({ firstName: 'Jane' });

    hashStore.set('inst-1:c-1:hubspot', {
      instanceId: 'inst-1',
      contactId: 'c-1',
      side: 'hubspot',
      hash: oldHash,
    });

    const skip = await shouldSkipWrite('inst-1', 'c-1', 'hubspot', newHash);
    expect(skip).toBe(false);
  });

  it('should fail open (return false) if the DB lookup throws', async () => {
    (ContactHashCache.findOne as jest.Mock).mockReturnValueOnce({
      lean: jest.fn().mockRejectedValueOnce(new Error('DB connection lost')),
    });

    const hash = computeHash({ firstName: 'John' });
    const skip = await shouldSkipWrite('inst-1', 'c-fail', 'wix', hash);
    expect(skip).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateHash — persist after a successful write
// ─────────────────────────────────────────────────────────────────────────────

describe('updateHash', () => {
  it('should persist the hash to the database', async () => {
    const hash = computeHash({ firstName: 'John' });
    await updateHash('inst-1', 'c-1', 'hubspot', hash);

    expect(ContactHashCache.findOneAndUpdate).toHaveBeenCalledWith(
      { instanceId: 'inst-1', contactId: 'c-1', side: 'hubspot' },
      { $set: { hash, updatedAt: expect.any(Date) } },
      { upsert: true },
    );
  });

  it('should make subsequent shouldSkipWrite return true for the same hash', async () => {
    const hash = computeHash({ firstName: 'Updated' });
    await updateHash('inst-1', 'c-2', 'wix', hash);

    const skip = await shouldSkipWrite('inst-1', 'c-2', 'wix', hash);
    expect(skip).toBe(true);
  });

  it('should not throw if DB update fails (non-fatal)', async () => {
    (ContactHashCache.findOneAndUpdate as jest.Mock).mockRejectedValueOnce(
      new Error('DB write fail'),
    );

    // Should not throw
    await expect(
      updateHash('inst-1', 'c-fail', 'hubspot', 'some-hash'),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearHashesForContact
// ─────────────────────────────────────────────────────────────────────────────

describe('clearHashesForContact', () => {
  it('should delete all hashes for a given contact', async () => {
    hashStore.set('inst-1:c-1:hubspot', { hash: 'h1' });
    hashStore.set('inst-1:c-1:wix', { hash: 'h2' });

    await clearHashesForContact('inst-1', 'c-1');
    expect(ContactHashCache.deleteMany).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      contactId: 'c-1',
    });
  });
});
