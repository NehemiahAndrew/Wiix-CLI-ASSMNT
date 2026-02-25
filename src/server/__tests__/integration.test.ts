// =============================================================================
// Integration Tests — Express API routes via Supertest
// =============================================================================
// Tests actual HTTP request/response cycles through the Express app without
// connecting to a real database or external APIs. All services are mocked.
//
// Routes tested:
//   GET  /api/health          — public health check
//   GET  /api/wix/install     — Wix app install callback
//   POST /api/widget/form-log — public widget form-log endpoint
//   GET  /api/connection/status  — auth-protected route (rejected without token)
//   GET  /api/field-mappings     — auth-protected route (rejected without token)
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';
process.env.NODE_ENV = 'test';

// ── Mock mongoose so the app doesn't try to connect ─────────────────────────
jest.mock('mongoose', () => {
  const mConnection = {
    on: jest.fn(),
    once: jest.fn(),
  };
  return {
    __esModule: true,
    default: {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      connection: mConnection,
    },
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    Schema: jest.fn().mockImplementation(() => ({
      index: jest.fn().mockReturnThis(),
      pre: jest.fn().mockReturnThis(),
      post: jest.fn().mockReturnThis(),
      static: jest.fn().mockReturnThis(),
      virtual: jest.fn().mockReturnThis(),
    })),
    model: jest.fn().mockReturnValue({
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
      bulkWrite: jest.fn().mockResolvedValue({}),
    }),
    connection: mConnection,
  };
});

// ── Mock all models ─────────────────────────────────────────────────────────
jest.mock('../models/Installation', () => {
  const mockInstallation = {
    findOne: jest.fn().mockResolvedValue(null),
    findOneAndUpdate: jest.fn().mockResolvedValue({ instanceId: 'inst-1' }),
    create: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: mockInstallation };
});

jest.mock('../models/SyncEvent', () => ({
  __esModule: true,
  default: { create: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../models/ContactMapping', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
  },
}));

jest.mock('../models/FieldMapping', () => {
  const actual: any = {
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
    deleteMany: jest.fn().mockResolvedValue({}),
    insertMany: jest.fn().mockResolvedValue([]),
    bulkWrite: jest.fn().mockResolvedValue({}),
  };
  actual.DEFAULT_FIELD_MAPPINGS = [
    { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional', transform: 'none' },
    { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional', transform: 'none' },
    { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional', transform: 'lowercase' },
    { wixField: 'primaryPhone', hubspotField: 'phone', direction: 'bidirectional', transform: 'phone_e164' },
  ];
  return { __esModule: true, default: actual, DEFAULT_FIELD_MAPPINGS: actual.DEFAULT_FIELD_MAPPINGS };
});

jest.mock('../models/SyncDedupeLog', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../models/ContactHashCache', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../models/FormSubmission', () => ({
  __esModule: true,
  default: {
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }),
    create: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../models/SyncError', () => ({
  __esModule: true,
  default: { create: jest.fn().mockResolvedValue({}) },
}));

// ── Mock services ───────────────────────────────────────────────────────────
jest.mock('../services/cleanupScheduler', () => ({
  __esModule: true,
  startCleanupScheduler: jest.fn(),
  stopCleanupScheduler: jest.fn(),
}));

jest.mock('../services/hubspotService', () => ({
  __esModule: true,
  createContact: jest.fn(),
  updateContact: jest.fn(),
  findContactByEmail: jest.fn(),
}));

jest.mock('../services/hubspotContacts', () => ({
  __esModule: true,
  getContactById: jest.fn(),
  writeSyncTag: jest.fn().mockResolvedValue(undefined),
  batchReadContacts: jest.fn(),
}));

jest.mock('../services/hubspotProperties', () => ({
  __esModule: true,
  fetchCustomProperties: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/wixContacts', () => ({
  __esModule: true,
  createOrUpdateWixContact: jest.fn(),
  getWixContactById: jest.fn(),
}));

jest.mock('../services/tokenManager', () => ({
  __esModule: true,
  getConnectionStatus: jest.fn().mockResolvedValue({ connected: false }),
  refreshIfNeeded: jest.fn(),
}));

jest.mock('../services/hubspotOAuth', () => ({
  __esModule: true,
  disconnect: jest.fn().mockResolvedValue(undefined),
  getAuthUrl: jest.fn().mockReturnValue('https://app.hubspot.com/oauth/authorize'),
  handleCallback: jest.fn().mockResolvedValue({}),
}));

jest.mock('../services/hubspotWebhookRegistration', () => ({
  __esModule: true,
  registerWebhooks: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/formCaptureService', () => ({
  __esModule: true,
  default: { listForms: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/formHandler', () => ({
  __esModule: true,
  default: { handleSubmission: jest.fn() },
}));

jest.mock('../services/syncOrchestrator', () => ({
  __esModule: true,
  onWixContactCreated: jest.fn(),
  onWixContactUpdated: jest.fn(),
  onHubSpotContactCreated: jest.fn(),
  onHubSpotContactUpdated: jest.fn(),
  runFullSync: jest.fn(),
  handleWixWebhook: jest.fn(),
  handleHubSpotWebhook: jest.fn(),
}));

jest.mock('@wix/sdk', () => ({
  createClient: jest.fn().mockReturnValue({}),
  OAuthStrategy: jest.fn().mockReturnValue({}),
}));
jest.mock('@wix/contacts', () => ({
  contacts: {},
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

import request from 'supertest';
import app from '../index';

// index.ts calls start() at import time, which triggers app.listen() →
// creates a TCP server that Jest will flag as an open handle.
// We find and close it in afterAll.
afterAll((done) => {
  // The http.Server is registered on the Express app via app.listen()
  // but isn't exported. We use a workaround: ask supertest to bind its own
  // ephemeral server and trust Jest's --forceExit for the leaked start() server.
  // Alternatively, set a short timeout so Jest doesn't hang indefinitely.
  done();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/health', () => {
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Wix Install Callback
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/wix/install', () => {
  it('should return 400 when instanceId is missing', async () => {
    const res = await request(app).get('/api/wix/install');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing instanceId');
  });

  it('should redirect on successful install', async () => {
    const res = await request(app).get('/api/wix/install?instanceId=test-1&token=tok');

    // Express redirect returns 302
    expect(res.status).toBe(302);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Widget Form Log (public — no auth required)
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/widget/form-log', () => {
  it('should return 200 for valid form-log payload', async () => {
    const res = await request(app)
      .post('/api/widget/form-log')
      .send({
        formId: 'form-123',
        portalId: '12345',
        pageUrl: 'https://test.com/contact',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('should return 400 when formId is missing', async () => {
    const res = await request(app)
      .post('/api/widget/form-log')
      .send({ portalId: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('formId is required');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Auth-Protected Routes — should reject unauthenticated requests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Auth-protected routes (no token)', () => {
  it('GET /api/connection/status should return 401', async () => {
    const res = await request(app).get('/api/connection/status');

    expect(res.status).toBe(401);
  });

  it('GET /api/field-mappings should return 401', async () => {
    const res = await request(app).get('/api/field-mappings');

    expect(res.status).toBe(401);
  });

  it('POST /api/sync/full should return 401', async () => {
    const res = await request(app).post('/api/sync/full');

    expect(res.status).toBe(401);
  });

  it('GET /api/widget/config should return 401', async () => {
    const res = await request(app).get('/api/widget/config');

    expect(res.status).toBe(401);
  });

  it('GET /api/widget/hubspot-forms should return 401', async () => {
    const res = await request(app).get('/api/widget/hubspot-forms');

    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 404 for unknown API routes
// ═══════════════════════════════════════════════════════════════════════════════

describe('Unknown routes', () => {
  it('should return 404 for non-existent API endpoint', async () => {
    const res = await request(app).get('/api/nonexistent');

    // In non-production mode, no catch-all — Express returns 404
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Webhook routes — should accept POST
// ═══════════════════════════════════════════════════════════════════════════════

describe('Webhook routes', () => {
  it('POST /api/webhooks/hubspot should accept POST requests', async () => {
    const res = await request(app)
      .post('/api/webhooks/hubspot')
      .send([]);

    // May return 200 or 400 depending on validation, but not 404
    expect(res.status).not.toBe(404);
  });
});
