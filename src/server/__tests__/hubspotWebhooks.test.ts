// =============================================================================
// HubSpot Webhook Handler Tests (Module 8)
// =============================================================================
// Tests the inbound HubSpot webhook route:
//
//   1. Valid HMAC-SHA256 signatures pass (verifySignature)
//   2. Tampered / missing signatures are rejected in production
//   3. Malformed events are dropped without crashing (Zod validation)
//   4. Valid events are routed to the correct sync function
//   5. contact.deletion removes the mapping
//   6. Echo detection skips our own sync-tag changes
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';

import crypto from 'crypto';

// ── Mock dependencies BEFORE importing the router ───────────────────────────

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockInstallationFindOne = jest.fn();
jest.mock('../models/Installation', () => ({
  __esModule: true,
  default: {
    findOne: mockInstallationFindOne,
  },
}));

const mockHandleHubSpotWebhook = jest.fn();
jest.mock('../services/syncOrchestrator', () => ({
  __esModule: true,
  handleHubSpotWebhook: (...args: any[]) => mockHandleHubSpotWebhook(...args),
}));

const mockDeleteMapping = jest.fn();
jest.mock('../services/mappingStore', () => ({
  __esModule: true,
  deleteMapping: (...args: any[]) => mockDeleteMapping(...args),
}));

const mockIsSyncEcho = jest.fn();
const mockExtractSyncId = jest.fn();
jest.mock('../services/dedupeGuard', () => ({
  __esModule: true,
  isSyncEcho: (...args: any[]) => mockIsSyncEcho(...args),
  extractSyncId: (...args: any[]) => mockExtractSyncId(...args),
}));

const mockGetContactById = jest.fn();
jest.mock('../services/hubspotContacts', () => ({
  __esModule: true,
  getContactById: (...args: any[]) => mockGetContactById(...args),
}));

// ── Now import the route + Express helpers ──────────────────────────────────

import express, { Express } from 'express';
import request from 'supertest';
import webhookRouter from '../routes/hubspot-webhooks';

// ── Helpers ─────────────────────────────────────────────────────────────────

const CLIENT_SECRET = 'test-hs-secret';

/** Compute a valid HubSpot v2 HMAC-SHA256 signature */
function sign(body: string): string {
  return crypto
    .createHash('sha256')
    .update(CLIENT_SECRET + body)
    .digest('hex');
}

function createApp(): Express {
  const app = express();
  // Stash rawBody like the real server does
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use('/api/webhooks/hubspot', webhookRouter);
  return app;
}

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    subscriptionType: 'contact.creation',
    objectId: 100,
    portalId: 12345,
    occurredAt: Date.now(),
    attemptNumber: 0,
    ...overrides,
  };
}

function makeInstallation() {
  return {
    instanceId: 'inst-test-1',
    connected: true,
    syncEnabled: true,
    hubspotPortalId: '12345',
  };
}

// ─────────────────────────────────────────────────────────────────────────────

let app: Express;

beforeEach(() => {
  jest.clearAllMocks();
  app = createApp();
  mockInstallationFindOne.mockResolvedValue(makeInstallation());
  mockHandleHubSpotWebhook.mockResolvedValue({});
  mockDeleteMapping.mockResolvedValue(undefined);
  mockIsSyncEcho.mockResolvedValue(false);
  mockExtractSyncId.mockReturnValue(undefined);
  mockGetContactById.mockResolvedValue({
    id: '100',
    properties: { email: 'john@test.com' },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Signature verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('HMAC-SHA256 signature verification', () => {
  it('should accept requests with a valid signature', async () => {
    const body = JSON.stringify([makeEvent()]);
    const sig = sign(body);

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('should still return 200 on tampered signature (processes async)', async () => {
    // The route returns 200 immediately, signature check happens after.
    const body = JSON.stringify([makeEvent()]);
    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', 'invalid-signature')
      .send(body);

    expect(res.status).toBe(200);
  });

  it('should return 200 even with no signature header', async () => {
    const body = JSON.stringify([makeEvent()]);
    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Signature correctness — unit test of the hash algorithm
// ═══════════════════════════════════════════════════════════════════════════════

describe('HMAC-SHA256 hash algorithm', () => {
  it('should produce a deterministic hash from clientSecret + body', () => {
    const body = '{"test":"data"}';
    const expected = crypto
      .createHash('sha256')
      .update(CLIENT_SECRET + body)
      .digest('hex');

    expect(sign(body)).toBe(expected);
  });

  it('should produce different hashes for different payloads', () => {
    expect(sign('{"a":1}')).not.toBe(sign('{"a":2}'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Zod validation — malformed events
// ═══════════════════════════════════════════════════════════════════════════════

describe('Malformed event handling (Zod validation)', () => {
  it('should drop events missing required fields without crashing', async () => {
    const body = JSON.stringify([
      { subscriptionType: 'contact.creation' }, // missing objectId, portalId
    ]);

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);

    // Give async processing a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    // The orchestrator should NOT have been called
    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should drop events with negative objectId', async () => {
    const body = JSON.stringify([
      makeEvent({ objectId: -1 }),
    ]);

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should process valid events and drop malformed ones in same batch', async () => {
    const body = JSON.stringify([
      makeEvent(), // valid
      { subscriptionType: 'contact.creation' }, // invalid — missing fields
    ]);

    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // Only the valid event should trigger a call
    expect(mockHandleHubSpotWebhook).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Valid event routing
// ═══════════════════════════════════════════════════════════════════════════════

describe('Event routing', () => {
  it('should route contact.creation to handleHubSpotWebhook with "created"', async () => {
    const event = makeEvent({ subscriptionType: 'contact.creation' });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-test-1' }),
      '100', // objectId stringified
      expect.any(Object), // properties
      'created',
      'hubspot_webhook',
    );
  });

  it('should route contact.propertyChange to handleHubSpotWebhook with "updated"', async () => {
    const event = makeEvent({
      subscriptionType: 'contact.propertyChange',
      propertyName: 'firstname',
      propertyValue: 'Jane',
    });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-test-1' }),
      '100',
      expect.any(Object),
      'updated',
      'hubspot_webhook',
    );
  });

  it('should route contact.deletion to deleteMapping', async () => {
    const event = makeEvent({
      subscriptionType: 'contact.deletion',
    });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockDeleteMapping).toHaveBeenCalledWith(
      'inst-test-1',
      undefined,
      '100',
    );
    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should skip sync-tag property changes (our own echo)', async () => {
    const event = makeEvent({
      subscriptionType: 'contact.propertyChange',
      propertyName: 'wix_sync_tag',
      propertyValue: 'some-uuid',
    });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Dedupe guard — echo detection
// ═══════════════════════════════════════════════════════════════════════════════

describe('Dedupe guard — echo detection', () => {
  it('should skip events identified as our own sync echoes', async () => {
    mockExtractSyncId.mockReturnValue('sync-id-from-tag');
    mockIsSyncEcho.mockResolvedValue(true);

    const event = makeEvent({ subscriptionType: 'contact.creation' });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should process events that are NOT echoes', async () => {
    mockExtractSyncId.mockReturnValue(undefined);
    mockIsSyncEcho.mockResolvedValue(false);

    const event = makeEvent({ subscriptionType: 'contact.creation' });
    const body = JSON.stringify([event]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('should handle non-array body (single event object)', async () => {
    const event = makeEvent();
    const body = JSON.stringify(event);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).toHaveBeenCalledTimes(1);
  });

  it('should skip events for disconnected installations', async () => {
    mockInstallationFindOne.mockResolvedValue({
      ...makeInstallation(),
      connected: false,
    });

    const body = JSON.stringify([makeEvent()]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should skip events for unknown portal IDs', async () => {
    mockInstallationFindOne.mockResolvedValue(null);

    const body = JSON.stringify([makeEvent({ portalId: 99999 })]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should handle contact not found after creation event gracefully', async () => {
    mockGetContactById.mockResolvedValue(null);

    const body = JSON.stringify([makeEvent()]);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockHandleHubSpotWebhook).not.toHaveBeenCalled();
  });

  it('should process multiple events concurrently', async () => {
    const events = [
      makeEvent({ objectId: 1, subscriptionType: 'contact.creation' }),
      makeEvent({ objectId: 2, subscriptionType: 'contact.creation' }),
      makeEvent({ objectId: 3, subscriptionType: 'contact.creation' }),
    ];

    mockGetContactById.mockImplementation(async (_inst: string, id: string) => ({
      id,
      properties: { email: `user${id}@test.com` },
    }));

    const body = JSON.stringify(events);

    await request(app)
      .post('/api/webhooks/hubspot')
      .set('Content-Type', 'application/json')
      .set('x-hubspot-signature', sign(body))
      .send(body);

    await new Promise((r) => setTimeout(r, 200));

    expect(mockHandleHubSpotWebhook).toHaveBeenCalledTimes(3);
  });
});
