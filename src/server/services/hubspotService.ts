// =============================================================================
// HubSpot Service — Backwards-compatible facade over Module 2
// =============================================================================
// This file now delegates to the dedicated Module 2 wrappers:
//   • hubspotClient.ts    — client factory + retry helper
//   • hubspotContacts.ts  — 5 contact functions
//   • hubspotProperties.ts — custom property management
//
// Functions that Module 2 doesn't cover (forms) are implemented here
// using the Module 2 client factory + retry helper.
// =============================================================================
import { AxiosError } from 'axios';
import { createHubSpotClient, withRetry } from './hubspotClient';
import {
  getContactById,
  getContactByEmail,
  createOrUpdateByEmail,
  writeSyncTag,
  batchReadContacts,
} from './hubspotContacts';
import { fetchCustomProperties } from './hubspotProperties';
import { IInstallation } from '../models/Installation';
import logger from '../utils/logger';
import { FlatContact, FieldOption, HubSpotContact } from '../types';

/* ════════════════════════════════════════════════════════════════════════════
 * Contact operations — delegate to Module 2-B (hubspotContacts)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Get a HubSpot contact by ID.
 * @deprecated Use `hubspotContacts.getContactById` directly.
 */
export async function getContact(
  installation: IInstallation,
  contactId: string,
  properties: string[],
): Promise<HubSpotContact | null> {
  return getContactById(installation.instanceId, contactId, properties);
}

/**
 * Search for a HubSpot contact by email.
 * @deprecated Use `hubspotContacts.getContactByEmail` directly.
 */
export async function findContactByEmail(
  installation: IInstallation,
  email: string,
): Promise<HubSpotContact | null> {
  return getContactByEmail(installation.instanceId, email);
}

/**
 * Create a new HubSpot contact.
 */
export async function createContact(
  installation: IInstallation,
  properties: FlatContact,
): Promise<HubSpotContact> {
  const res = await withRetry(installation.instanceId, (client) =>
    client.post('/crm/v3/objects/contacts', { properties }),
  );
  logger.info('HubSpot contact created', {
    instanceId: installation.instanceId,
    hubspotContactId: res.data.id,
  });
  return res.data as HubSpotContact;
}

/**
 * Update an existing HubSpot contact.
 */
export async function updateContact(
  installation: IInstallation,
  contactId: string,
  properties: FlatContact,
): Promise<HubSpotContact> {
  const res = await withRetry(installation.instanceId, (client) =>
    client.patch(`/crm/v3/objects/contacts/${contactId}`, { properties }),
  );
  logger.info('HubSpot contact updated', {
    instanceId: installation.instanceId,
    hubspotContactId: contactId,
  });
  return res.data as HubSpotContact;
}

/**
 * Delete (archive) a HubSpot contact.
 */
export async function deleteContact(
  installation: IInstallation,
  contactId: string,
): Promise<void> {
  await withRetry(installation.instanceId, (client) =>
    client.delete(`/crm/v3/objects/contacts/${contactId}`),
  );
  logger.info('HubSpot contact deleted', {
    instanceId: installation.instanceId,
    hubspotContactId: contactId,
  });
}

/* ════════════════════════════════════════════════════════════════════════════
 * Properties — delegate to Module 2-C (hubspotProperties)
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * List available HubSpot contact properties for field-mapping UI.
 * @deprecated Use `hubspotProperties.fetchCustomProperties` directly.
 */
export async function listContactProperties(
  installation: IInstallation,
): Promise<FieldOption[]> {
  return fetchCustomProperties(installation.instanceId);
}

/* ════════════════════════════════════════════════════════════════════════════
 * Forms — still implemented here (not covered by Module 2 spec)
 * Uses Module 2-A client factory + retry helper
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Submit a form to HubSpot via the Forms API v3.
 */
export async function submitForm(
  installation: IInstallation,
  formGuid: string,
  fields: Array<{ name: string; value: string }>,
  context: { pageUri?: string; pageName?: string; hutk?: string },
): Promise<void> {
  const { default: axios } = await import('axios');
  await axios.post(
    `https://api.hsforms.com/submissions/v3/integration/submit/${installation.hubspotPortalId}/${formGuid}`,
    {
      fields,
      context: {
        pageUri: context.pageUri || '',
        pageName: context.pageName || '',
        hutk: context.hutk || undefined,
      },
    },
    { timeout: 10_000 },
  );
  logger.info('HubSpot form submitted', {
    instanceId: installation.instanceId,
    formGuid,
  });
}

/**
 * List HubSpot forms.
 */
export async function listForms(
  installation: IInstallation,
): Promise<Array<{ id: string; name: string }>> {
  const res = await withRetry(installation.instanceId, (client) =>
    client.get('/marketing/v3/forms', { params: { limit: 100 } }),
  );
  return (res.data.results as Array<{ id: string; name: string }>).map((f) => ({
    id: f.id,
    name: f.name,
  }));
}
