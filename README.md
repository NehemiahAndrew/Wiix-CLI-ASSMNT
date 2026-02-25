# Wix ↔ HubSpot Integration

A full-stack Wix app that enables bi-directional contact sync and form/lead capture between Wix sites and HubSpot CRM.

Built as a **Self-Hosted Wix App** using **TypeScript**, Node.js, Express, React, and MongoDB.

---

## Features

### 1. Bi-Directional Contact Sync (Core)
- **Real-time sync** via webhooks (Wix → HubSpot and HubSpot → Wix)
- Supports both contact **creation** and **updates**
- User-configurable **field mapping** with transforms
- **3-layer loop prevention:**
  - Source tracking + 30s dedupe window
  - In-memory correlation ID cache
  - Property hash idempotency (skip identical writes)
- Persistent `WixContactId ↔ HubSpotContactId` mapping table
- Full audit trail via SyncEvent log (auto-expires after 90 days)

### 2. Form & Lead Capture
- Wix form submissions automatically pushed to HubSpot as contacts/leads
- **Full UTM attribution** preserved:
  - `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`
  - Page URL, referrer, timestamp
- Supports both webhook-based and Wix Velo-based form capture
- Optional: submit to a specific HubSpot form (with form GUID)
- Submission audit trail with status tracking

### 3. Secure OAuth 2.0 Connection
- Standard OAuth 2.0 Authorization Code flow with HubSpot
- Tokens encrypted at rest (AES-256-GCM)
- Automatic token refresh before expiry
- Least-privilege scopes (contacts + forms only)
- Tokens never exposed to browser
- PII/token redaction in all logs

### 4. Field Mapping UI
- Interactive table UI in the dashboard
- Dropdowns for Wix fields and HubSpot properties
- Configurable sync direction per field (→, ←, ↔)
- Optional transforms (trim, lowercase, uppercase)
- Validation: no duplicate HubSpot property mappings
- Save/load persisted to MongoDB

### 5. HubSpot Form Embed Widget (Module 12)
- **Drop-in Wix Editor widget** that embeds any HubSpot form on a published site
- Editor-side **Settings Panel** lets the site owner pick which HubSpot form to display
- Widget renders the HubSpot Forms SDK (`hbspt.forms.create`) inside an iframe
- Automatic **form submission logging** to the server for observability
- UTM parameters and page URL captured at submission time
- No extra auth needed on the published site — runs with the portal/form IDs only

---

## Project Structure

```
├── src/
│   ├── server/                        # Backend (TypeScript + Express)
│   │   ├── index.ts                   # Server entry point
│   │   ├── config.ts                  # Centralised typed configuration
│   │   ├── types.ts                   # Shared TypeScript interfaces & types
│   │   ├── __tests__/                 # Jest test suites
│   │   │   ├── authMiddleware.test.ts
│   │   │   ├── dedupeGuard.test.ts
│   │   │   ├── fieldMappingEngine.test.ts
│   │   │   ├── hubspotWebhooks.test.ts
│   │   │   ├── idempotencyChecker.test.ts
│   │   │   ├── integration.test.ts    # Supertest integration tests
│   │   │   ├── syncEngine.test.ts
│   │   │   ├── syncOrchestrator.test.ts
│   │   │   ├── tokenEncryption.test.ts
│   │   │   ├── types.test.ts
│   │   │   └── __mocks__/             # Shared test mocks
│   │   ├── backend/                   # Wix Velo backend code
│   │   │   ├── backendMethods.ts      # Exported backend methods
│   │   │   ├── events.ts              # Wix backend event handlers
│   │   │   ├── formSubmissionHandler.ts
│   │   │   └── webMethod.ts           # Wix web-method wrapper
│   │   ├── models/                    # Mongoose models (typed)
│   │   │   ├── Installation.ts        # Per-site Wix + HubSpot credentials
│   │   │   ├── ContactMapping.ts      # WixContactId ↔ HubSpotContactId
│   │   │   ├── FieldMapping.ts        # User-configurable field mapping rules
│   │   │   ├── SyncEvent.ts           # Audit log for sync operations
│   │   │   ├── SyncDedupeLog.ts       # 30s dedupe log for loop prevention
│   │   │   ├── ContactHashCache.ts    # Property hash cache for idempotency
│   │   │   ├── SyncError.ts           # Sync error records
│   │   │   └── FormSubmission.ts      # Form submission metadata log
│   │   ├── routes/                    # Express route handlers
│   │   │   ├── hubspot-oauth.ts       # OAuth authorize/callback
│   │   │   ├── wix-webhooks.ts        # Wix webhook receiver
│   │   │   ├── hubspot-webhooks.ts    # HubSpot webhook receiver
│   │   │   ├── field-mapping.ts       # CRUD for field mapping rules
│   │   │   ├── sync.ts               # Sync trigger, history & stats
│   │   │   ├── forms.ts              # Form submission & HubSpot forms
│   │   │   ├── connection.ts          # Connection status / disconnect
│   │   │   ├── widget.ts             # Widget config & form-log
│   │   │   └── backend-methods.ts     # Wix Velo backend methods
│   │   ├── services/                  # Business logic
│   │   │   ├── syncOrchestrator.ts    # Bi-directional sync orchestrator
│   │   │   ├── syncEngine.ts          # Core sync engine + loop prevention
│   │   │   ├── fieldMappingEngine.ts  # Field mapping + transforms
│   │   │   ├── hubspotService.ts      # HubSpot API v3 wrapper with auto-refresh
│   │   │   ├── hubspotClient.ts       # Low-level HubSpot HTTP client
│   │   │   ├── hubspotContacts.ts     # HubSpot contacts CRUD
│   │   │   ├── hubspotOAuth.ts        # HubSpot OAuth flow
│   │   │   ├── hubspotProperties.ts   # HubSpot property fetcher
│   │   │   ├── hubspotWebhookRegistration.ts  # Webhook subscription setup
│   │   │   ├── wixContacts.ts         # Wix contacts CRUD
│   │   │   ├── dedupeGuard.ts         # Sync-ID based echo suppression
│   │   │   ├── idempotencyChecker.ts  # Property hash idempotency
│   │   │   ├── mappingStore.ts        # ContactMapping CRUD
│   │   │   ├── tokenManager.ts        # Token refresh & status
│   │   │   ├── formCaptureService.ts  # Form → HubSpot with UTM attribution
│   │   │   ├── formHandler.ts         # Form processing pipeline
│   │   │   └── cleanupScheduler.ts    # Periodic SyncDedupeLog cleanup
│   │   ├── typings/                   # Custom type declarations
│   │   │   └── wix-contacts.d.ts      # Wix Contacts SDK type overrides
│   │   └── utils/                     # Utilities
│   │       ├── logger.ts              # Winston logger with PII redaction
│   │       ├── authMiddleware.ts      # Wix instance auth middleware
│   │       ├── tokenEncryption.ts     # AES-256-GCM token encryption
│   │       ├── lruCache.ts            # TTL-based in-memory cache
│   │       ├── utmParser.ts           # UTM parameter parser
│   │       ├── sanitizeError.ts       # Safe error serialisation
│   │       └── DatabaseError.ts       # Typed DB error wrapper
│   ├── client/                        # Frontend (React + Vite + TSX)
│   │   ├── index.html                 # HTML entry (dashboard)
│   │   ├── widget.html                # HTML entry (embeddable widget)
│   │   ├── settings.html              # HTML entry (editor settings panel)
│   │   ├── main.tsx                   # React entry (dashboard)
│   │   ├── widget-main.tsx            # React entry (widget)
│   │   ├── settings-main.tsx          # React entry (settings panel)
│   │   ├── App.tsx                    # Main app with tab navigation
│   │   ├── api.ts                     # Typed API client
│   │   ├── global.css                 # Dashboard styles
│   │   ├── ConnectionPanel.tsx        # OAuth connect/disconnect UI
│   │   ├── ContactList.tsx            # Contact list view
│   │   ├── FieldMappingTable.tsx      # Field mapping configuration table
│   │   ├── SyncDashboard.tsx          # Sync stats, history, controls
│   │   ├── FormCapture.tsx            # Form submission viewer + retry
│   │   ├── HubSpotFormWidget.tsx      # Embeddable HubSpot form component
│   │   └── HubSpotFormSettings.tsx    # Widget settings panel
│   └── dashboard/                     # Wix dashboard page
│       └── pages/hubspot-sync/        # HubSpot sync dashboard page
├── scripts/
│   └── tunnel.mjs                     # Cloudflare / ngrok tunnel helper
├── API_PLAN.md                        # Detailed API plan per feature
├── DEMO_TESTING.md                    # Demo credentials & testing guide
├── jest.config.ts                     # Jest test configuration
├── package.json
├── tsconfig.json                      # Client TypeScript config
├── tsconfig.server.json               # Server TypeScript config
├── vite.config.ts                     # Vite build config (multi-page)
├── render.yaml                        # Render.com deployment config
├── wix.config.json                    # Wix CLI app configuration
├── .env.example                       # Environment variable template
├── .gitignore
├── LICENSE
└── README.md
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- A Wix Developer account with an app
- A HubSpot Developer account with an app

### 1. Clone & Install

```bash
git clone https://github.com/NehemiahAndrew/Wiix-CLI-ASSMNT.git
cd Wiix-CLI-ASSMNT
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials — see Environment Variables below
```

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | `development` or `production` |
| `BASE_URL` | Yes | Public URL of the server (e.g. `https://your-server.com`) |
| `WIX_APP_ID` | Yes | Wix app ID from Developer Center |
| `WIX_APP_SECRET` | Yes | Wix app secret key |
| `WIX_WEBHOOK_PUBLIC_KEY` | Yes | Public key for verifying Wix webhook signatures |
| `HUBSPOT_CLIENT_ID` | Yes | HubSpot app client ID |
| `HUBSPOT_CLIENT_SECRET` | Yes | HubSpot app client secret |
| `HUBSPOT_REDIRECT_URI` | Yes | OAuth callback URL (e.g. `https://your-server.com/api/hubspot/oauth/callback`) |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Random string for JWT signing & key derivation |
| `ENCRYPTION_KEY` | No | 64-char hex string for AES-256 token encryption (auto-derived from JWT_SECRET if omitted) |
| `SYNC_DEDUPE_WINDOW_MS` | No | Dedupe window in ms (default: `30000`) |
| `SYNC_BATCH_SIZE` | No | Max contacts per batch sync (default: `50`) |

### 3. Configure Wix App

1. Go to [Wix Developer Center](https://dev.wix.com)
2. Create a new app (or use existing)
3. Set the app URL to your server (e.g., `https://your-server.com`)
4. Configure OAuth redirect URL
5. Add Webhooks:
   - `wix.contacts.v4.contact_created` → `POST https://your-server.com/api/webhooks/wix`
   - `wix.contacts.v4.contact_updated` → `POST https://your-server.com/api/webhooks/wix`
   - `wix.forms.v4.form_submission_created` → `POST https://your-server.com/api/forms/webhook`

### 4. Configure HubSpot App

1. Go to [HubSpot Developer Portal](https://developers.hubspot.com)
2. Create a new app
3. Set OAuth redirect URL to `https://your-server.com/api/hubspot/oauth/callback`
4. Configure scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.schemas.contacts.read`, `forms`
5. Configure Webhooks:
   - Subscribe to `contact.creation` and `contact.propertyChange`
   - Webhook URL: `https://your-server.com/api/webhooks/hubspot`

### 5. Start Development

```bash
npm run dev
# Server: http://localhost:3000
# Client: http://localhost:5173
```

### 6. Production

```bash
npm run build
npm start
```

---

## API Endpoints

### OAuth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/hubspot/auth` | Wix instance | Redirect to HubSpot consent screen |
| `GET` | `/api/hubspot/callback` | — | OAuth callback (exchanges code → encrypted tokens) |

### Connection
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/connection/status` | Wix instance | Check HubSpot connection status |
| `POST` | `/api/connection/disconnect` | Wix instance | Disconnect HubSpot account |

### Field Mapping
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/field-mappings` | Wix instance | List all field mapping rules |
| `POST` | `/api/field-mappings` | Wix instance | Create a new mapping rule |
| `PUT` | `/api/field-mappings/:id` | Wix instance | Update a mapping rule |
| `DELETE` | `/api/field-mappings/:id` | Wix instance | Delete a mapping rule |
| `POST` | `/api/field-mappings/reset` | Wix instance | Reset to default mappings |
| `GET` | `/api/field-mappings/hubspot-properties` | Wix instance | HubSpot contact properties |
| `GET` | `/api/field-mappings/wix-fields` | Wix instance | Available Wix contact fields |

### Sync
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/sync/full` | Wix instance | Trigger full bi-directional sync |
| `POST` | `/api/sync/toggle` | Wix instance | Enable / pause automatic sync |
| `GET` | `/api/sync/history` | Wix instance | Paginated sync event audit log |
| `GET` | `/api/sync/stats` | Wix instance | Sync statistics & health metrics |

### Webhooks (signature-verified, no auth token)
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/webhooks/wix` | Wix contact created/updated/deleted |
| `POST` | `/api/webhooks/hubspot` | HubSpot contact.creation / propertyChange / deletion |

### Forms
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/forms/webhook` | — (signature) | Wix form submission webhook |
| `GET` | `/api/forms` | Wix instance | List form submissions (paginated) |
| `POST` | `/api/forms/map` | Wix instance | Map Wix form → HubSpot form |
| `GET` | `/api/forms/hubspot-forms` | Wix instance | List HubSpot forms |
| `POST` | `/api/forms/:id/retry` | Wix instance | Retry a failed submission |

### Widget (Module 12)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/widget/form-log` | — (public) | Log a widget form submission |
| `GET` | `/api/widget/config` | Wix instance | Get widget config (portalId, formId) |
| `GET` | `/api/widget/hubspot-forms` | Wix instance | List HubSpot forms for settings panel |

### Utility
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check (status, uptime) |
| `GET` | `/api/wix/install` | Wix app install callback |

---

## Conflict Handling

The sync engine uses a **"last updated wins"** conflict resolution strategy:

1. When a contact is modified in both Wix and HubSpot simultaneously, the **most recently modified** version takes priority.
2. The `lastSyncSource` field on each `ContactMapping` record tracks whether the last write came from Wix or HubSpot.
3. The 30-second dedupe window prevents rapid ping-pong updates from creating infinite loops.

### Loop Prevention Details

| Layer | Mechanism | Description |
|-------|-----------|-------------|
| 1 | Source + Timestamp | Skip if `lastSyncSource` is the opposite platform AND within `SYNC_DEDUPE_WINDOW_MS` |
| 2 | In-Memory Cache | TTL cache of recently synced `(platform:instanceId:contactId)` → skip if present |
| 3 | Property Hash | SHA-256 hash of sorted property values → skip if hash matches previous sync |

---

## Security

- **OAuth 2.0** — No API keys in frontend; standard authorization code flow
- **AES-256-GCM** — Tokens encrypted at rest in MongoDB with unique IVs
- **Token rotation** — Automatic refresh 5 minutes before expiration
- **Webhook verification** — HMAC-SHA256 signature verification for both Wix and HubSpot webhooks
- **Auth middleware** — Every dashboard API endpoint validates the Wix instance token
- **PII redaction** — Logger automatically redacts token/password/secret/key fields
- **Least privilege** — Only `contacts.read/write`, `schemas.read`, and `forms` scopes requested

---

## Testing

### Running Tests

```bash
# Run all tests with coverage
npm test

# Run a specific test file
npx jest --testPathPattern=syncOrchestrator

# Run tests in watch mode
npx jest --watch
```

### Test Suite Overview

| File | Module | Coverage |
|------|--------|----------|
| `authMiddleware.test.ts` | Wix instance auth | Middleware validation |
| `tokenEncryption.test.ts` | AES-256-GCM | Encrypt/decrypt/key validation |
| `syncEngine.test.ts` | Core sync engine | State machine + loop prevention |
| `dedupeGuard.test.ts` | Dedupe guard (Module 5-A) | 94%+ statement coverage |
| `idempotencyChecker.test.ts` | Idempotency (Module 5-B) | 95%+ statement coverage |
| `fieldMappingEngine.test.ts` | Field mapping (Module 6) | Transforms, cache, save/seed |
| `syncOrchestrator.test.ts` | Bi-dir sync (Module 7) | All 4 scenarios + full sync |
| `hubspotWebhooks.test.ts` | Webhook routes (Module 8) | 89%+ statement coverage |
| `integration.test.ts` | API routes (supertest) | Health, install, auth, widget |

### Manual End-to-End Testing

1. Install the app on a Wix site from the Wix Developer Center
2. Open the app dashboard → click "Connect HubSpot"
3. Authorize the HubSpot OAuth flow
4. Configure field mappings in the "Field Mapping" tab
5. Create or update a contact in Wix → verify it appears in HubSpot
6. Create or update a contact in HubSpot → verify it appears in Wix
7. Submit a Wix form → verify a HubSpot contact is created with UTM attribution
8. Add the HubSpot Form Widget to a page in the Wix Editor
9. Select a HubSpot form in the widget settings panel
10. Preview/publish → submit the embedded form → verify the contact in HubSpot

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Server | Node.js + Express 4 |
| Client | React 18 + Vite 5 |
| Database | MongoDB + Mongoose 8 |
| Wix SDK | `@wix/sdk`, `@wix/contacts` |
| HubSpot | CRM API v3 (REST via Axios) |
| Auth | OAuth 2.0 Authorization Code |
| Encryption | AES-256-GCM (tokens at rest) |
| Logging | Winston (PII-redacted) |
| Testing | Jest + ts-jest + Supertest |
| Deploy | Render.com (render.yaml) |

---

## Additional Documentation

- [API_PLAN.md](API_PLAN.md) — Detailed external API usage per feature
- [DEMO_TESTING.md](DEMO_TESTING.md) — Demo credentials, test scenarios & troubleshooting
- [.env.example](.env.example) — Environment variable template

---

## License

ISC — see [LICENSE](LICENSE) for details.
