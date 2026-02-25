# Demo & Testing Guide

This document provides everything needed to test the Wix ↔ HubSpot Integration end-to-end.

---

## Demo Credentials

> **Fill in the values below before sharing with the reviewer.**

| Service | Field | Value |
|---------|-------|-------|
| **Wix Developer Center** | Login email | `nehemiahandrew78@gmail.com` |
| **Wix Developer Center** | Login password | `Pillars123@#$` |
| **Wix Developer Center** | App name | Wix-HubSpot Integration |
| **Wix Developer Center** | App ID | `8622be65-c66b-45d4-8b58-5afd938335ba` |
| **Wix Test Site** | Site URL | Dev site 1 (Stores V3) — accessible from Wix Studio dashboard |
| **HubSpot Developer** | Login email | `nehemiahandrew78@gmail.com` |
| **HubSpot Developer** | Login password | `Pillars123@#$` |
| **HubSpot Test Portal** | Portal ID | `147868769` (App ID: `32093126`) |
| **MongoDB Atlas** | Connection string | `mongodb+srv://wixhubbuild:JPWthd1UPrU4ZmfX@cluster0.na1uoow.mongodb.net/wix-hubspot-integration` |
| **Server URL (Production)** | Render | `https://wiix-cli-assmnt.onrender.com` |
| **Server URL (Dev tunnel)** | ngrok | `https://nontangentially-tristichic-suellen.ngrok-free.dev` |

---

## Quick-Start Testing (Local)

### 1. Prerequisites

- Node.js 18+
- MongoDB running locally **or** a MongoDB Atlas free-tier cluster
- A [Wix Developer account](https://dev.wix.com)
- A [HubSpot Developer account](https://developers.hubspot.com)

### 2. Install & Configure

```bash
git clone <repo-url>
cd wix-hubspot-integration
npm install

# Copy and fill environment variables
cp .env.example .env
# Open .env and fill in all credential fields (see table above)
```

### 3. Start the Dev Server

```bash
npm run dev
# → Server:  http://localhost:3000
# → Client:  http://localhost:5173
```

### 4. Expose via Tunnel (for webhooks)

```bash
npm run tunnel
# Copy the HTTPS tunnel URL and update:
#   - BASE_URL in .env
#   - HUBSPOT_REDIRECT_URI in .env
#   - Webhook URLs in Wix Developer Center & HubSpot Developer Portal
```

---

## Test Scenarios

### A. OAuth Connection

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open dashboard → "Connection" tab | Shows "Not Connected" status |
| 2 | Click **Connect HubSpot** | Redirected to HubSpot consent screen |
| 3 | Authorize with HubSpot credentials | Redirected back; status shows **Connected** with portal ID |
| 4 | Click **Disconnect** | Status returns to "Not Connected" |

### B. Field Mapping

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open "Field Mapping" tab | Default mappings loaded (firstName ↔ firstname, etc.) |
| 2 | Add a custom mapping row | Wix & HubSpot dropdowns populated |
| 3 | Set direction to "→" and transform to "lowercase" | Saved successfully |
| 4 | Click **Save** | Toast / confirmation shown |

### C. Bi-Directional Contact Sync

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Create a contact in Wix | Within ~5s, new contact appears in HubSpot |
| 2 | Update that contact's name in Wix | HubSpot contact name updated correspondingly |
| 3 | Create a contact in HubSpot | Within ~5s, new contact appears in Wix |
| 4 | Update that contact's email in HubSpot | Wix contact updated (if field-mapping direction allows) |
| 5 | Rapidly update the same contact in both | Loop prevention stops infinite ping-pong (check logs) |

### D. Form & Lead Capture

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Submit a Wix form on the test site | Form submission appears in "Forms" tab |
| 2 | Check HubSpot contacts | New contact created with form data + UTM attribution |
| 3 | Add `?utm_source=demo&utm_campaign=test` to the page URL and submit again | UTM fields populated on the HubSpot contact |

### E. HubSpot Form Widget (Module 12)

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | In Wix Editor, add the HubSpot Form Widget | Widget block appears on page |
| 2 | Open widget Settings panel → select a HubSpot form | Form ID saved to widget config |
| 3 | Preview / Publish the site | Embedded HubSpot form renders in an iframe |
| 4 | Submit the embedded form | Contact created in HubSpot; submission logged server-side |

### F. Sync Dashboard

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open "Sync" tab | Shows sync stats (total synced, errors, last sync time) |
| 2 | Click **Full Sync** | All existing contacts are synced bi-directionally |
| 3 | View history table | Paginated audit log of all sync events |

---

## Running Automated Tests

```bash
# Full test suite with coverage report
npm test

# Single test file
npx jest --testPathPattern=syncEngine

# Watch mode during development
npx jest --watch
```

### Expected Coverage Summary

| Module | Statement Coverage |
|--------|-------------------|
| Auth Middleware | 90%+ |
| Token Encryption | 95%+ |
| Sync Engine | 90%+ |
| Dedupe Guard | 94%+ |
| Idempotency Checker | 95%+ |
| Field Mapping Engine | 90%+ |
| Sync Orchestrator | 85%+ |
| HubSpot Webhooks | 89%+ |
| Integration (API routes) | 80%+ |

---

## API Quick Reference (for manual testing)

### Health Check
```bash
curl http://localhost:3000/api/health
# → {"status":"ok","uptime":123.45}
```

### Connection Status (requires Wix instance header)
```bash
curl -H "Authorization: <wix-instance-token>" \
  http://localhost:3000/api/connection/status
```

### Trigger Full Sync
```bash
curl -X POST \
  -H "Authorization: <wix-instance-token>" \
  http://localhost:3000/api/sync/full
```

### List Sync History
```bash
curl -H "Authorization: <wix-instance-token>" \
  "http://localhost:3000/api/sync/history?page=1&limit=20"
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `⚠️ Missing config: wixAppId` | Fill in `WIX_APP_ID` in `.env` |
| OAuth callback fails | Ensure `HUBSPOT_REDIRECT_URI` matches the URL registered in HubSpot Developer Portal |
| Webhooks not firing | Verify tunnel URL is active and webhook URLs are updated in both Wix & HubSpot dashboards |
| MongoDB connection error | Check `MONGODB_URI` — if using Atlas, whitelist your IP |
| Contact not syncing | Check "Sync" tab history for errors; inspect server logs in `logs/app.log` |
| Loop detected / skipped | Expected behavior — loop prevention working correctly |

---

## Notes for Reviewer

- All tokens are **encrypted at rest** (AES-256-GCM) — never stored in plaintext
- The `.env` file is gitignored; use `.env.example` as a template
- Server logs redact PII/secrets automatically (Winston logger)
- The `auth_token.txt` in the root is a **development-only** convenience file (gitignored)
- Test suite runs fully in-memory with mocked dependencies — no external services needed
