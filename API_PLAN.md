# API Plan — Wix ↔ HubSpot Integration

This document details every external API used, why it's used, and how it maps to each feature.

---

## Feature #1 — Bi-Directional Contact Sync

### Wix APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Wix Contacts API v4** | `POST /contacts/v4/contacts` | Create a new Wix contact when a HubSpot contact is synced inbound |
| **Wix Contacts API v4** | `PATCH /contacts/v4/contacts/{contactId}` | Update an existing Wix contact with changes from HubSpot |
| **Wix Contacts API v4** | `POST /contacts/v4/contacts/query` | Search for existing Wix contacts by email (de-duplication) |
| **Wix Webhooks** | `wix.contacts.v4.contact_created` | Real-time notification when a new contact is created in Wix → triggers sync to HubSpot |
| **Wix Webhooks** | `wix.contacts.v4.contact_updated` | Real-time notification when a contact is updated in Wix → triggers sync to HubSpot |

**Why Wix Contacts v4:**  
The v4 API is the latest version with full CRUD support, extended fields, and rich query capabilities. It supports the nested contact structure (info.name.first, info.emails[], etc.) that we need for comprehensive field mapping.

### HubSpot APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **CRM Contacts API v3** | `POST /crm/v3/objects/contacts` | Create a new HubSpot contact when a Wix contact is synced outbound |
| **CRM Contacts API v3** | `PATCH /crm/v3/objects/contacts/{contactId}` | Update an existing HubSpot contact with changes from Wix |
| **CRM Contacts API v3** | `POST /crm/v3/objects/contacts/search` | Search for existing HubSpot contacts by email (de-duplication) |
| **CRM Contacts API v3** | `GET /crm/v3/objects/contacts/{contactId}` | Fetch full contact details after receiving a webhook event |
| **Properties API v3** | `GET /crm/v3/properties/contacts` | List all available contact properties for the field-mapping UI dropdowns |
| **Webhooks API** | Subscription via Developer Settings | Subscribe to `contact.creation` and `contact.propertyChange` events for real-time HubSpot → Wix sync |

**Why CRM v3 + Webhooks:**  
HubSpot's v3 CRM API is the current standard with proper search, batch operations, and consistent response formats. Webhooks are preferred over polling because they provide real-time sync (sub-second latency) and reduce API quota consumption. The webhook subscription is configured in the HubSpot developer portal, not via API.

### Sync Architecture

```
Wix Contact Created/Updated
        │
        ▼
  Wix Webhook fires ──► Our Server
        │
        ▼
  SyncEngine.syncWixToHubSpot()
        │
        ├── Check ContactMapping table (WixId ↔ HubSpotId)
        ├── Loop guard: skip if lastSyncSource=hubspot + within dedupe window
        ├── Idempotency: skip if property hash hasn't changed
        ├── Apply FieldMapping rules + transforms
        ├── Create or Update HubSpot contact via CRM v3
        ├── Update ContactMapping (source=wix, syncId, hashes)
        └── Log SyncEvent for audit trail

HubSpot Contact Created/Updated
        │
        ▼
  HubSpot Webhook fires ──► Our Server
        │
        ▼
  SyncEngine.syncHubSpotToWix()
        │
        ├── Check ContactMapping table (HubSpotId ↔ WixId)
        ├── Loop guard: skip if lastSyncSource=wix + within dedupe window
        ├── Idempotency: skip if property hash hasn't changed
        ├── Apply FieldMapping rules + transforms (reverse direction)
        ├── Create or Update Wix contact via Contacts v4
        ├── Update ContactMapping (source=hubspot, syncId, hashes)
        └── Log SyncEvent for audit trail
```

### Infinite Loop Prevention (3 Layers)

1. **Source tracking + dedupe window:** Each sync records `lastSyncSource` (wix|hubspot) and `lastSyncedAt`. If an incoming event's opposing source wrote within the last 30 seconds, it's skipped.
2. **In-memory dedupe cache:** A TTL cache (node-cache) stores recently synced contact IDs with their correlation IDs. Any event for a contact in this cache is skipped.
3. **Property hash idempotency:** Before writing, we hash the mapped property values. If the hash matches the last-known hash, the write is skipped entirely (no API call made).

---

## Feature #2 — Form & Lead Capture Integration

### Approach Chosen: Wix Forms as UI → Push to HubSpot

We use **Wix forms as the user-facing UI** and push submissions to HubSpot on the backend. This approach was chosen because:
- Users keep their existing Wix form designs and workflows
- We have full control over attribution capture before data reaches HubSpot
- No frontend HubSpot SDK is needed (simpler Wix site code)

### Wix APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Wix Forms Webhook** | `wix.forms.v4.form_submission_created` | Real-time notification when a form is submitted on the Wix site |
| **Wix Velo (optional)** | `wixForms_onFormSubmit()` event handler | Alternative trigger using Wix Velo backend code |

### HubSpot APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **CRM Contacts API v3** | `POST /crm/v3/objects/contacts` | Create a new HubSpot contact from form submission |
| **CRM Contacts API v3** | `PATCH /crm/v3/objects/contacts/{contactId}` | Update existing contact if email already exists |
| **CRM Contacts API v3** | `POST /crm/v3/objects/contacts/search` | De-duplicate by email before creating |
| **Forms API v3 (optional)** | `POST /submissions/v3/integration/submit/{portalId}/{formGuid}` | Submit directly to a specific HubSpot form (if user configures form GUID) |

### Attribution Data Mapping

| Captured Field | HubSpot Property | Description |
|---------------|------------------|-------------|
| `utm_source` | `hs_analytics_source` | Traffic source (google, newsletter, etc.) |
| `utm_medium` | `utm_medium` | Marketing medium (cpc, email, social) |
| `utm_campaign` | `utm_campaign` | Campaign name |
| `utm_term` | `utm_term` | Search keyword |
| `utm_content` | `utm_content` | Ad/content variant |
| `pageUrl` | `hs_analytics_first_url` | Page where form was submitted |
| `referrer` | `hs_analytics_first_referrer` | Referring URL |

---

## Security & Connection — OAuth 2.0

### APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **HubSpot OAuth** | `GET /oauth/authorize` | Redirect user to HubSpot to grant permissions |
| **HubSpot OAuth** | `POST /oauth/v1/token` | Exchange authorization code for access + refresh tokens |
| **HubSpot OAuth** | `POST /oauth/v1/token` (refresh) | Refresh expired access tokens using refresh token |
| **HubSpot OAuth** | `GET /oauth/v1/access-tokens/{token}` | Retrieve portal ID after token exchange |

### Scopes Requested (Least Privilege)

| Scope | Reason |
|-------|--------|
| `crm.objects.contacts.read` | Read contacts for sync |
| `crm.objects.contacts.write` | Create/update contacts |
| `crm.schemas.contacts.read` | Read property schemas for field-mapping dropdown |
| `crm.schemas.contacts.write` | (Reserved for custom property creation if needed) |
| `forms` | Submit data to HubSpot forms |
| `oauth` | Required for OAuth flow |

### Token Security

- **Encryption at rest:** AES-256-GCM with derived key from app secret
- **Auto-refresh:** Tokens are refreshed 5 minutes before expiry
- **Never in browser:** Tokens are stored server-side only; the frontend never sees them
- **Safe logging:** Winston logger redacts any key matching token/secret/password patterns

---

## Field Mapping UI

### APIs Used

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Our API** | `GET /api/field-mappings` | Load current mapping rules |
| **Our API** | `PUT /api/field-mappings` | Save updated mapping rules |
| **Our API** | `GET /api/field-mappings/wix-fields` | List available Wix contact fields for dropdown |
| **Our API** | `GET /api/field-mappings/hubspot-properties` | List available HubSpot properties for dropdown (fetches from HubSpot Properties API) |
| **HubSpot Properties API** | `GET /crm/v3/properties/contacts` | Source data for the HubSpot property dropdown |

### Mapping Rule Schema

```json
{
  "wixField": "firstName",
  "hubspotProperty": "firstname",
  "direction": "bidirectional",   // wix_to_hubspot | hubspot_to_wix | bidirectional
  "transform": "trim"             // none | trim | lowercase | uppercase | trim_lowercase
}
```

---

## Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Backend | Node.js + Express | Wix CLI compatible, fast async I/O for webhook processing |
| Database | MongoDB + Mongoose | Flexible schema for contact mappings, sync events, and field configs |
| Frontend | React + Vite | Modern SPA for the Wix dashboard panel |
| Auth | OAuth 2.0 + JWT | Industry standard, required by HubSpot |
| Encryption | AES-256-GCM | NIST-recommended symmetric encryption for token storage |
| Logging | Winston | Structured logging with built-in PII redaction |
| Caching | node-cache | In-memory TTL cache for sync loop dedupe |
