// =============================================================================
// Module 2-B: HubSpot Contacts Wrapper
// =============================================================================
// Five functions that cover every contact operation the integration needs:
//
//   1. getContactById       — fetch a single contact by HubSpot ID
//   2. getContactByEmail    — search for a contact by email address
//   3. createOrUpdateByEmail — upsert: check by email → update or create
//   4. writeSyncTag         — stamp a UUID on the contact after our own write
//   5. batchReadContacts    — fetch up to 100 contacts in one call
//
// All functions use the Module 2-A `withRetry` helper so rate-limit (429)
// and server errors (5xx) are handled transparently. Client errors (4xx)
// are NOT retried and bubble up immediately.
// =============================================================================
import { AxiosResponse } from 'axios';
import { withRetry } from './hubspotClient';
import logger from '../utils/logger';
import { HubSpotContact } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Get a contact by HubSpot ID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches a HubSpot contact by its internal ID.
 *
 * @param instanceId  — Wix site instance (for token resolution)
 * @param contactId   — HubSpot contact ID (numeric string)
 * @param properties  — List of property names to include in the response
 * @returns           — The contact object, or `null` if not found (404)
 */
export async function getContactById(
  instanceId: string,
  contactId: string,
  properties: string[] = [],
): Promise<HubSpotContact | null> {
  try {
    const res: AxiosResponse = await withRetry(instanceId, (client) =>
      client.get(`/crm/v3/objects/contacts/${contactId}`, {
        params: properties.length
          ? { properties: properties.join(',') }
          : undefined,
      }),
    );
    return res.data as HubSpotContact;
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Search for a contact by email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Searches HubSpot for a contact matching the given email address.
 *
 * Uses the CRM Search API (`/crm/v3/objects/contacts/search`). Returns
 * the first match or `null` if no contact has that email.
 *
 * @param instanceId  — Wix site instance
 * @param email       — Email address to search for
 * @param properties  — Extra properties to return (email is always included)
 * @returns           — The matching contact, or `null`
 */
export async function getContactByEmail(
  instanceId: string,
  email: string,
  properties: string[] = [],
): Promise<HubSpotContact | null> {
  const res: AxiosResponse = await withRetry(instanceId, (client) =>
    client.post('/crm/v3/objects/contacts/search', {
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'email',
              operator: 'EQ',
              value: email.toLowerCase().trim(),
            },
          ],
        },
      ],
      properties: ['email', ...properties],
      limit: 1,
    }),
  );

  const results = res.data?.results;
  if (!results || results.length === 0) return null;
  return results[0] as HubSpotContact;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create or update a contact by email (upsert)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts a HubSpot contact by email address.
 *
 * Steps:
 *   a. Check if a contact with this email already exists.
 *   b. If yes → PATCH the existing contact with the new properties.
 *   c. If no  → POST to create a new contact.
 *
 * @param instanceId  — Wix site instance
 * @param email       — Email address (used as the match key)
 * @param properties  — Key-value map of HubSpot contact properties to set
 * @returns           — `{ contact, action }` — the saved contact + whether
 *                      it was `'created'` or `'updated'`
 */
export async function createOrUpdateByEmail(
  instanceId: string,
  email: string,
  properties: Record<string, string>,
): Promise<{ contact: HubSpotContact; action: 'created' | 'updated' }> {
  // Always ensure the email property is set
  const mergedProps = { ...properties, email: email.toLowerCase().trim() };

  // ── a. Check if contact exists ────────────────────────────────────────
  const existing = await getContactByEmail(instanceId, email);

  if (existing) {
    // ── b. Update ───────────────────────────────────────────────────────
    const res: AxiosResponse = await withRetry(instanceId, (client) =>
      client.patch(`/crm/v3/objects/contacts/${existing.id}`, {
        properties: mergedProps,
      }),
    );

    logger.info('HubSpot contact updated (upsert)', {
      instanceId,
      hubspotContactId: existing.id,
    });

    return {
      contact: res.data as HubSpotContact,
      action: 'updated',
    };
  }

  // ── c. Create ───────────────────────────────────────────────────────
  const res: AxiosResponse = await withRetry(instanceId, (client) =>
    client.post('/crm/v3/objects/contacts', {
      properties: mergedProps,
    }),
  );

  logger.info('HubSpot contact created (upsert)', {
    instanceId,
    hubspotContactId: res.data.id,
  });

  return {
    contact: res.data as HubSpotContact,
    action: 'created',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Write a sync tag onto a contact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamps a unique sync-tag UUID on a HubSpot contact after we write to it.
 *
 * When HubSpot fires a webhook for this change, the sync engine reads the
 * tag and recognises that the update originated from our app — not from a
 * human — and skips processing it. This is the first layer of loop
 * prevention.
 *
 * The tag is written to a custom HubSpot property `wix_sync_tag` which
 * is automatically provisioned by the properties wrapper
 * (`ensureRequiredProperties`).
 *
 * @param instanceId  — Wix site instance
 * @param contactId   — HubSpot contact ID to tag
 * @param syncTagId   — A UUID (e.g. `crypto.randomUUID()`) unique to this sync
 */
export async function writeSyncTag(
  instanceId: string,
  contactId: string,
  syncTagId: string,
): Promise<void> {
  await withRetry(instanceId, (client) =>
    client.patch(`/crm/v3/objects/contacts/${contactId}`, {
      properties: {
        wix_sync_tag: syncTagId,
      },
    }),
  );

  logger.debug('Sync tag written to HubSpot contact', {
    instanceId,
    hubspotContactId: contactId,
    syncTagId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Batch read contacts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches up to 100 contacts at once using HubSpot's batch read endpoint.
 *
 * Useful for initial / full sync where reading contacts one at a time would
 * be too slow and burn through rate limits.
 *
 * @param instanceId  — Wix site instance
 * @param contactIds  — Array of HubSpot contact IDs (max 100)
 * @param properties  — List of property names to include
 * @returns           — Array of contacts (order not guaranteed)
 * @throws            — If more than 100 IDs are passed
 */
export async function batchReadContacts(
  instanceId: string,
  contactIds: string[],
  properties: string[] = [],
): Promise<HubSpotContact[]> {
  if (contactIds.length === 0) return [];

  if (contactIds.length > 100) {
    throw new Error(
      `batchReadContacts: max 100 IDs per call, received ${contactIds.length}`,
    );
  }

  const res: AxiosResponse = await withRetry(instanceId, (client) =>
    client.post('/crm/v3/objects/contacts/batch/read', {
      inputs: contactIds.map((id) => ({ id })),
      properties,
    }),
  );

  const contacts = (res.data?.results ?? []) as HubSpotContact[];

  logger.debug('Batch read contacts', {
    instanceId,
    requested: contactIds.length,
    returned: contacts.length,
  });

  return contacts;
}
