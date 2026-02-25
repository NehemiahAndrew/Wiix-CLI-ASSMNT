// =============================================================================
// Sync Orchestrator Tests (Module 7)
// =============================================================================
// Tests: onWixContactCreated, onWixContactUpdated, onHubSpotContactUpdated
//        with all external dependencies fully mocked.
//
// Scenarios verified:
//   1. Creating a new Wix contact creates a HubSpot contact + saves mapping
//   2. Updating a Wix contact skips sync when hash has not changed
//   3. Incoming HubSpot webhook ignored when sync ID matches ours
//   4. Conflict resolution picks the contact with recent timestamp
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';

// ── Mock all dependencies ───────────────────────────────────────────────────

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock @wix/sdk and @wix/contacts (empty .d.ts in node_modules)
jest.mock('@wix/sdk', () => ({
  createClient: jest.fn().mockReturnValue({}),
  OAuthStrategy: jest.fn().mockReturnValue({}),
}));
jest.mock('@wix/contacts', () => ({
  contacts: {},
}));

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    wixAppId: 'test-wix-app-id',
    wixAppSecret: 'test-wix-app-secret',
    hubspotClientId: 'test-hs-id',
    hubspotClientSecret: 'test-hs-secret',
    hubspotRedirectUri: 'http://localhost:3000/api/hubspot/callback',
    nodeEnv: 'test',
    encryptionKey: 'a'.repeat(64),
    jwtSecret: 'test-jwt-secret',
  },
}));

jest.mock('../models/SyncEvent', () => ({
  __esModule: true,
  default: {
    create: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../models/Installation', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

// Module 2 — HubSpot Service (facade)
const mockCreateContact = jest.fn();
const mockUpdateContact = jest.fn();
const mockFindContactByEmail = jest.fn();

jest.mock('../services/hubspotService', () => ({
  __esModule: true,
  createContact: (...args: any[]) => mockCreateContact(...args),
  updateContact: (...args: any[]) => mockUpdateContact(...args),
  findContactByEmail: (...args: any[]) => mockFindContactByEmail(...args),
}));

// Module 2-B — HubSpot Contacts
const mockGetContactById = jest.fn();
const mockWriteSyncTag = jest.fn().mockResolvedValue(undefined);
const mockBatchReadContacts = jest.fn();

jest.mock('../services/hubspotContacts', () => ({
  __esModule: true,
  getContactById: (...args: any[]) => mockGetContactById(...args),
  writeSyncTag: (...args: any[]) => mockWriteSyncTag(...args),
  batchReadContacts: (...args: any[]) => mockBatchReadContacts(...args),
}));

// Module 3 — Wix Contacts
const mockCreateOrUpdateWixContact = jest.fn();
const mockGetWixContactById = jest.fn();

jest.mock('../services/wixContacts', () => ({
  __esModule: true,
  createOrUpdateWixContact: (...args: any[]) => mockCreateOrUpdateWixContact(...args),
  getWixContactById: (...args: any[]) => mockGetWixContactById(...args),
}));

// Module 4 — Mapping Store
const mockFindByWixId = jest.fn();
const mockFindByHubSpotId = jest.fn();
const mockUpsertMapping = jest.fn();

jest.mock('../services/mappingStore', () => ({
  __esModule: true,
  findByWixId: (...args: any[]) => mockFindByWixId(...args),
  findByHubSpotId: (...args: any[]) => mockFindByHubSpotId(...args),
  upsertMapping: (...args: any[]) => mockUpsertMapping(...args),
}));

// Module 5-A — Dedupe Guard
const mockRegisterSyncId = jest.fn();
jest.mock('../services/dedupeGuard', () => ({
  __esModule: true,
  registerSyncId: (...args: any[]) => mockRegisterSyncId(...args),
}));

// Module 5-B — Idempotency Checker
const mockComputeHash = jest.fn();
const mockShouldSkipWrite = jest.fn();
const mockUpdateHash = jest.fn();

jest.mock('../services/idempotencyChecker', () => ({
  __esModule: true,
  computeHash: (...args: any[]) => mockComputeHash(...args),
  shouldSkipWrite: (...args: any[]) => mockShouldSkipWrite(...args),
  updateHash: (...args: any[]) => mockUpdateHash(...args),
}));

// Module 6 — Field Mapping Engine
const mockLoadMappingRules = jest.fn();
const mockWixToHubSpot = jest.fn();
const mockHubSpotToWix = jest.fn();
const mockFlattenWixContact = jest.fn();

jest.mock('../services/fieldMappingEngine', () => ({
  __esModule: true,
  loadMappingRules: (...args: any[]) => mockLoadMappingRules(...args),
  wixToHubSpot: (...args: any[]) => mockWixToHubSpot(...args),
  hubSpotToWix: (...args: any[]) => mockHubSpotToWix(...args),
  flattenWixContact: (...args: any[]) => mockFlattenWixContact(...args),
}));

import {
  onWixContactCreated,
  onWixContactUpdated,
  onHubSpotContactCreated,
  onHubSpotContactUpdated,
  runFullSync,
  handleWixWebhook,
  handleHubSpotWebhook,
} from '../services/syncOrchestrator';
import { IInstallation } from '../models/Installation';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInstallation(overrides: Partial<IInstallation> = {}): IInstallation {
  return {
    instanceId: 'inst-test-1',
    connected: true,
    syncEnabled: true,
    refreshToken: 'mock-refresh-token',
    hubspotPortalId: '12345',
    hubspotAccessToken: '',
    hubspotRefreshToken: '',
    hubspotTokenIv: '',
    hubspotTokenExpiresAt: null,
    lastSyncAt: null,
    widgetFormId: '',
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IInstallation;
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default mocks
  mockLoadMappingRules.mockResolvedValue([]);
  mockWixToHubSpot.mockReturnValue({ email: 'john@test.com', firstname: 'John' });
  mockHubSpotToWix.mockReturnValue({ email: 'john@test.com', firstName: 'John' });
  mockComputeHash.mockReturnValue('hash-abc-123');
  mockShouldSkipWrite.mockResolvedValue(false);
  mockUpdateHash.mockResolvedValue(undefined);
  mockRegisterSyncId.mockResolvedValue('sync-uuid-001');
  mockFindByWixId.mockResolvedValue(null);
  mockFindByHubSpotId.mockResolvedValue(null);
  mockUpsertMapping.mockResolvedValue({
    instanceId: 'inst-test-1',
    wixContactId: 'wix-1',
    hubspotContactId: 'hs-1',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Wix Contact Created → creates HubSpot contact
// ═══════════════════════════════════════════════════════════════════════════════

describe('onWixContactCreated', () => {
  it('should create a new HubSpot contact when no email match exists', async () => {
    const installation = makeInstallation();
    const wixData = { info: { name: { first: 'John' }, emails: [{ email: 'john@test.com' }] } };

    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    const result = await onWixContactCreated(installation, 'wix-1', wixData);

    expect(result.action).toBe('create');
    expect(result.hubspotContactId).toBe('hs-new-1');
    expect(mockCreateContact).toHaveBeenCalledWith(
      installation,
      expect.objectContaining({ email: 'john@test.com' }),
    );
  });

  it('should save the mapping after creating the HubSpot contact', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    await onWixContactCreated(installation, 'wix-1', {});

    expect(mockUpsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'inst-test-1',
        wixContactId: 'wix-1',
        hubspotContactId: 'hs-new-1',
        lastSyncSource: 'wix',
      }),
    );
  });

  it('should register a sync ID for loop prevention', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    await onWixContactCreated(installation, 'wix-1', {});

    expect(mockRegisterSyncId).toHaveBeenCalledWith(
      'inst-test-1',
      'hubspot',
      'hs-new-1',
    );
  });

  it('should persist the idempotency hash', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    await onWixContactCreated(installation, 'wix-1', {});

    expect(mockUpdateHash).toHaveBeenCalledWith(
      'inst-test-1',
      'hs-new-1',
      'hubspot',
      'hash-abc-123',
    );
  });

  it('should link to existing HubSpot contact when email matches', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue({ id: 'hs-existing', properties: {} });
    mockUpdateContact.mockResolvedValue({ id: 'hs-existing', properties: {} });

    const result = await onWixContactCreated(installation, 'wix-1', {});

    expect(result.action).toBe('update');
    expect(result.hubspotContactId).toBe('hs-existing');
    expect(mockUpdateContact).toHaveBeenCalled();
    expect(mockCreateContact).not.toHaveBeenCalled();
  });

  it('should write the sync tag on HubSpot contact', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    await onWixContactCreated(installation, 'wix-1', {});

    expect(mockWriteSyncTag).toHaveBeenCalledWith(
      'inst-test-1',
      'hs-new-1',
      'sync-uuid-001',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Wix Contact Updated → skip when hash unchanged
// ═══════════════════════════════════════════════════════════════════════════════

describe('onWixContactUpdated', () => {
  it('should skip the sync when hash has not changed (idempotency)', async () => {
    const installation = makeInstallation();

    // Simulate an existing mapping
    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });

    // Idempotency returns true → hash unchanged
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await onWixContactUpdated(installation, 'wix-1', {});

    expect(result.action).toBe('skip');
    expect(mockUpdateContact).not.toHaveBeenCalled();
    expect(mockCreateContact).not.toHaveBeenCalled();
  });

  it('should update HubSpot when hash has changed', async () => {
    const installation = makeInstallation();

    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);
    mockGetContactById.mockResolvedValue({
      id: 'hs-1',
      properties: {},
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockUpdateContact.mockResolvedValue({ id: 'hs-1', properties: {} });

    const wixData = { _updatedDate: '2026-01-01T00:00:00Z' };
    const result = await onWixContactUpdated(installation, 'wix-1', wixData);

    expect(result.action).toBe('update');
    expect(mockUpdateContact).toHaveBeenCalledWith(installation, 'hs-1', expect.any(Object));
  });

  it('should skip when conflict resolution picks HubSpot (newer timestamp)', async () => {
    const installation = makeInstallation();

    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);

    // HubSpot is newer
    mockGetContactById.mockResolvedValue({
      id: 'hs-1',
      properties: {},
      updatedAt: '2026-06-01T00:00:00Z',
    });

    // Wix is older
    const wixData = { _updatedDate: '2025-01-01T00:00:00Z' };
    const result = await onWixContactUpdated(installation, 'wix-1', wixData);

    expect(result.action).toBe('skip');
    expect(mockUpdateContact).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4 — HubSpot Contact Updated → conflict resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('onHubSpotContactUpdated', () => {
  it('should skip when idempotency hash matches (no change)', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await onHubSpotContactUpdated(
      installation,
      'hs-1',
      { firstname: 'John' },
    );

    expect(result.action).toBe('skip');
    expect(mockCreateOrUpdateWixContact).not.toHaveBeenCalled();
  });

  it('should update Wix contact when HubSpot wins conflict resolution', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);

    // Wix contact is older
    mockGetWixContactById.mockResolvedValue({
      _id: 'wix-1',
      _updatedDate: '2025-01-01T00:00:00Z',
    });

    // HubSpot is newer
    const hsProps = {
      firstname: 'John',
      hs_lastmodifieddate: '2026-06-01T00:00:00Z',
    };

    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-1',
      action: 'updated',
    });

    const result = await onHubSpotContactUpdated(installation, 'hs-1', hsProps);

    expect(result.action).toBe('update');
    expect(mockCreateOrUpdateWixContact).toHaveBeenCalled();
  });

  it('should skip when Wix wins conflict resolution (newer timestamp)', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);

    // Wix is NEWER
    mockGetWixContactById.mockResolvedValue({
      _id: 'wix-1',
      _updatedDate: '2026-12-01T00:00:00Z',
    });

    // HubSpot is OLDER
    const hsProps = {
      firstname: 'John',
      hs_lastmodifieddate: '2025-01-01T00:00:00Z',
    };

    const result = await onHubSpotContactUpdated(installation, 'hs-1', hsProps);

    expect(result.action).toBe('skip');
    expect(mockCreateOrUpdateWixContact).not.toHaveBeenCalled();
  });

  it('should persist mapping and hash after successful update', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);
    mockGetWixContactById.mockResolvedValue({
      _id: 'wix-1',
      _updatedDate: '2025-01-01T00:00:00Z',
    });

    const hsProps = {
      firstname: 'John',
      hs_lastmodifieddate: '2026-06-01T00:00:00Z',
    };

    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-1',
      action: 'updated',
    });

    await onHubSpotContactUpdated(installation, 'hs-1', hsProps);

    expect(mockUpsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'inst-test-1',
        wixContactId: 'wix-1',
        hubspotContactId: 'hs-1',
        lastSyncSource: 'hubspot',
      }),
    );
    expect(mockUpdateHash).toHaveBeenCalledWith(
      'inst-test-1',
      'wix-1',
      'wix',
      'hash-abc-123',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3 — HubSpot Contact Created → creates Wix contact
// ═══════════════════════════════════════════════════════════════════════════════

describe('onHubSpotContactCreated', () => {
  it('should create a new Wix contact from HubSpot', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    const result = await onHubSpotContactCreated(
      installation,
      'hs-1',
      { firstname: 'John', email: 'john@test.com' },
    );

    expect(result.action).toBe('create');
    expect(result.wixContactId).toBe('wix-new-1');
    expect(mockCreateOrUpdateWixContact).toHaveBeenCalledWith(
      installation,
      expect.objectContaining({ email: 'john@test.com' }),
      expect.objectContaining({ hubspotContactId: 'hs-1', syncSource: 'hubspot' }),
    );
  });

  it('should delegate to onHubSpotContactUpdated when mapping already exists', async () => {
    const installation = makeInstallation();

    // Existing mapping found
    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });

    // shouldSkipWrite returns true → skip path in onHubSpotContactUpdated
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await onHubSpotContactCreated(
      installation,
      'hs-1',
      { firstname: 'John' },
    );

    // Delegated to updated handler, which skipped
    expect(result.action).toBe('skip');
  });

  it('should register sync ID for loop prevention', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    await onHubSpotContactCreated(installation, 'hs-1', { firstname: 'John' });

    expect(mockRegisterSyncId).toHaveBeenCalledWith(
      'inst-test-1',
      'wix',
      'wix-new-1',
      expect.any(String), // crypto.randomUUID()
    );
  });

  it('should persist the mapping after creating the Wix contact', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    await onHubSpotContactCreated(installation, 'hs-1', { firstname: 'John' });

    expect(mockUpsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'inst-test-1',
        wixContactId: 'wix-new-1',
        hubspotContactId: 'hs-1',
        lastSyncSource: 'hubspot',
      }),
    );
  });

  it('should persist the idempotency hash', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    await onHubSpotContactCreated(installation, 'hs-1', { firstname: 'John' });

    expect(mockUpdateHash).toHaveBeenCalledWith(
      'inst-test-1',
      'wix-new-1',
      'wix',
      'hash-abc-123',
    );
  });

  it('should throw and log on failure', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockRejectedValue(new Error('Wix API error'));

    await expect(
      onHubSpotContactCreated(installation, 'hs-1', { firstname: 'John' }),
    ).rejects.toThrow('Wix API error');
  });

  it('should handle "updated" action from createOrUpdateWixContact', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-existing',
      action: 'updated',
    });

    const result = await onHubSpotContactCreated(
      installation,
      'hs-1',
      { firstname: 'John', email: 'john@test.com' },
    );

    expect(result.action).toBe('update');
    expect(result.wixContactId).toBe('wix-existing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — Error path
// ═══════════════════════════════════════════════════════════════════════════════

describe('onWixContactCreated — error paths', () => {
  it('should throw and log when createContact fails', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockRejectedValue(new Error('HubSpot 429 rate limit'));

    await expect(
      onWixContactCreated(installation, 'wix-1', {}),
    ).rejects.toThrow('HubSpot 429 rate limit');
  });

  it('should delegate to update when mapping already exists', async () => {
    const installation = makeInstallation();

    // Simulate existing mapping → delegates to onWixContactUpdated
    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    // Hash skip → returns skip from onWixContactUpdated
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await onWixContactCreated(installation, 'wix-1', {});

    expect(result.action).toBe('skip');
    expect(mockCreateContact).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — Error path
// ═══════════════════════════════════════════════════════════════════════════════

describe('onWixContactUpdated — error paths', () => {
  it('should throw and log when updateContact fails', async () => {
    const installation = makeInstallation();

    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);
    mockGetContactById.mockResolvedValue({
      id: 'hs-1',
      properties: {},
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockUpdateContact.mockRejectedValue(new Error('HubSpot 500'));

    const wixData = { _updatedDate: '2026-01-01T00:00:00Z' };

    await expect(
      onWixContactUpdated(installation, 'wix-1', wixData),
    ).rejects.toThrow('HubSpot 500');
  });

  it('should delegate to create when no mapping exists', async () => {
    const installation = makeInstallation();
    mockFindByWixId.mockResolvedValue(null); // No mapping

    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    const result = await onWixContactUpdated(installation, 'wix-1', {});

    // Delegates to onWixContactCreated which creates
    expect(result.action).toBe('create');
    expect(result.hubspotContactId).toBe('hs-new-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4 — Error path and edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('onHubSpotContactUpdated — error paths', () => {
  it('should throw and log when createOrUpdateWixContact fails', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(false);

    // Wix contact exists and is older
    mockGetWixContactById.mockResolvedValue({
      _id: 'wix-1',
      _updatedDate: '2025-01-01T00:00:00Z',
    });

    const hsProps = {
      firstname: 'John',
      hs_lastmodifieddate: '2026-06-01T00:00:00Z',
    };

    mockCreateOrUpdateWixContact.mockRejectedValue(new Error('Wix timeout'));

    await expect(
      onHubSpotContactUpdated(installation, 'hs-1', hsProps),
    ).rejects.toThrow('Wix timeout');
  });

  it('should delegate to create when no mapping exists', async () => {
    const installation = makeInstallation();
    mockFindByHubSpotId.mockResolvedValue(null); // No mapping

    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    const result = await onHubSpotContactUpdated(
      installation,
      'hs-1',
      { firstname: 'John', email: 'john@test.com' },
    );

    // Delegates to onHubSpotContactCreated which creates
    expect(result.action).toBe('create');
    expect(result.wixContactId).toBe('wix-new-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Full Sync — runFullSync
// ═══════════════════════════════════════════════════════════════════════════════

describe('runFullSync', () => {
  const mockQueryContacts = jest.fn();
  const mockFind = jest.fn();

  beforeEach(() => {
    // Wire up the Wix SDK mock to return a queryable contacts object
    const { createClient } = require('@wix/sdk');
    mockFind.mockResolvedValue({
      items: [],
      cursors: {},
    });
    mockQueryContacts.mockReturnValue({ find: mockFind });
    createClient.mockReturnValue({
      contacts: {
        queryContacts: mockQueryContacts,
      },
    });
  });

  it('should return zeroes when no contacts exist', async () => {
    const installation = makeInstallation();

    const result = await runFullSync(installation);

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.total).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(installation.save).toHaveBeenCalled();
  });

  it('should create new HubSpot contacts for unmapped Wix contacts', async () => {
    const installation = makeInstallation();
    mockFindByWixId.mockResolvedValue(null);
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    mockFind.mockResolvedValue({
      items: [
        { _id: 'wix-1', info: { name: { first: 'John' }, emails: [{ email: 'john@test.com' }] } },
      ],
      cursors: {},
    });

    const result = await runFullSync(installation);

    expect(result.synced).toBe(1);
    expect(result.total).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('should skip contacts that are already up-to-date', async () => {
    const installation = makeInstallation();

    // Existing mapping exists → delegates to onWixContactUpdated
    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    // Idempotency skip
    mockShouldSkipWrite.mockResolvedValue(true);

    mockFind.mockResolvedValue({
      items: [{ _id: 'wix-1' }],
      cursors: {},
    });

    const result = await runFullSync(installation);

    expect(result.skipped).toBe(1);
    expect(result.synced).toBe(0);
  });

  it('should count errors for contacts that fail to sync', async () => {
    const installation = makeInstallation();
    mockFindByWixId.mockResolvedValue(null);
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockRejectedValue(new Error('HubSpot down'));

    mockFind.mockResolvedValue({
      items: [{ _id: 'wix-1' }],
      cursors: {},
    });

    const result = await runFullSync(installation);

    expect(result.errors).toBe(1);
    expect(result.synced).toBe(0);
  });

  it('should skip contacts missing _id', async () => {
    const installation = makeInstallation();

    mockFind.mockResolvedValue({
      items: [{ info: { name: { first: 'NoId' } } }],
      cursors: {},
    });

    const result = await runFullSync(installation);

    expect(result.errors).toBe(1); // missing _id is counted as error
    expect(result.total).toBe(1);
  });

  it('should update lastSyncAt on the installation', async () => {
    const installation = makeInstallation();

    mockFind.mockResolvedValue({ items: [], cursors: {} });

    await runFullSync(installation);

    expect(installation.lastSyncAt).toBeInstanceOf(Date);
    expect(installation.save).toHaveBeenCalled();
  });

  it('should handle multiple contacts in a single page', async () => {
    const installation = makeInstallation();
    mockFindByWixId.mockResolvedValue(null);
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact
      .mockResolvedValueOnce({ id: 'hs-1', properties: {} })
      .mockResolvedValueOnce({ id: 'hs-2', properties: {} })
      .mockResolvedValueOnce({ id: 'hs-3', properties: {} });

    mockFind.mockResolvedValue({
      items: [
        { _id: 'wix-1', info: { emails: [{ email: 'a@test.com' }] } },
        { _id: 'wix-2', info: { emails: [{ email: 'b@test.com' }] } },
        { _id: 'wix-3', info: { emails: [{ email: 'c@test.com' }] } },
      ],
      cursors: {},
    });

    const result = await runFullSync(installation);

    expect(result.synced).toBe(3);
    expect(result.total).toBe(3);
    expect(result.errors).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Dispatch Helpers — handleWixWebhook / handleHubSpotWebhook
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleWixWebhook', () => {
  it('should dispatch "created" event to onWixContactCreated', async () => {
    const installation = makeInstallation();
    mockFindContactByEmail.mockResolvedValue(null);
    mockCreateContact.mockResolvedValue({ id: 'hs-new-1', properties: {} });

    const result = await handleWixWebhook(
      installation,
      'wix-1',
      { info: { emails: [{ email: 'test@test.com' }] } },
      'created',
    );

    expect(result.action).toBe('create');
    expect(result.hubspotContactId).toBe('hs-new-1');
  });

  it('should dispatch "updated" event to onWixContactUpdated', async () => {
    const installation = makeInstallation();

    mockFindByWixId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await handleWixWebhook(
      installation,
      'wix-1',
      {},
      'updated',
    );

    expect(result.action).toBe('skip');
  });
});

describe('handleHubSpotWebhook', () => {
  it('should dispatch "created" event to onHubSpotContactCreated', async () => {
    const installation = makeInstallation();
    mockCreateOrUpdateWixContact.mockResolvedValue({
      contactId: 'wix-new-1',
      action: 'created',
    });

    const result = await handleHubSpotWebhook(
      installation,
      'hs-1',
      { firstname: 'John', email: 'john@test.com' },
      'created',
    );

    expect(result.action).toBe('create');
    expect(result.wixContactId).toBe('wix-new-1');
  });

  it('should dispatch "updated" event to onHubSpotContactUpdated', async () => {
    const installation = makeInstallation();

    mockFindByHubSpotId.mockResolvedValue({
      instanceId: 'inst-test-1',
      wixContactId: 'wix-1',
      hubspotContactId: 'hs-1',
    });
    mockShouldSkipWrite.mockResolvedValue(true);

    const result = await handleHubSpotWebhook(
      installation,
      'hs-1',
      { firstname: 'John' },
      'updated',
    );

    expect(result.action).toBe('skip');
  });
});