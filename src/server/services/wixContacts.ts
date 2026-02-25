// =============================================================================
// Module 3-A: Wix Contacts Wrapper (REST API)
// =============================================================================
// Uses the Wix REST API directly instead of the JS SDK to avoid the
// `__type` serialization bug in server-side environments.
//
// Three functions for reading and writing Wix contacts:
//   1. getWixContactById    — look up a contact by Wix ID
//   2. getWixContactByEmail — look up a contact by email address
//   3. createOrUpdateWixContact — upsert a contact with sync metadata
//
// Every create / update writes three extended fields onto the contact:
//   • custom.hubspot_contact_id  — the linked HubSpot contact ID
//   • custom.wix_sync_tag        — UUID from the last sync operation
//   • custom.wix_sync_source     — 'wix' or 'hubspot' (who triggered it)
// =============================================================================
import https from 'https';
import config from '../config';
import { IInstallation } from '../models/Installation';
import logger from '../utils/logger';
import { WixContact } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Extended field keys
// ─────────────────────────────────────────────────────────────────────────────
const EXT_FIELD_HUBSPOT_ID = 'custom.hubspot_contact_id';
const EXT_FIELD_SYNC_TAG = 'custom.wix_sync_tag';
const EXT_FIELD_SYNC_SOURCE = 'custom.wix_sync_source';

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────
export interface WixContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
}

export interface SyncMetadata {
  hubspotContactId: string;
  syncTagId: string;
  syncSource: 'wix' | 'hubspot';
}

// ─────────────────────────────────────────────────────────────────────────────
// Token cache — avoids refreshing on every single API call
// ─────────────────────────────────────────────────────────────────────────────
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getAccessToken(installation: IInstallation): Promise<string> {
  const cached = tokenCache.get(installation.instanceId);
  // Use cached token if it has at least 60s left
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: config.wixAppId,
    client_secret: config.wixAppSecret,
    refresh_token: installation.refreshToken,
  });

  const data = await wixRequest<any>('POST', 'https://www.wix.com/oauth/access', body, {
    'Content-Type': 'application/json',
  });

  if (!data.access_token) {
    throw new Error(`Wix token refresh failed: ${JSON.stringify(data)}`);
  }

  // Wix access tokens typically expire in 5 minutes (300s)
  tokenCache.set(installation.instanceId, {
    accessToken: data.access_token,
    expiresAt: Date.now() + 4 * 60_000, // conservative 4 min
  });

  return data.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic HTTPS request helper
// ─────────────────────────────────────────────────────────────────────────────
function wixRequest<T>(
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      },
    };

    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', (chunk) => (data += chunk));
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode && resp.statusCode >= 400) {
            const errMsg = parsed.message || parsed.details?.applicationError?.description || `Wix API error ${resp.statusCode}`;
            logger.error('Wix API error response', {
              statusCode: resp.statusCode,
              message: errMsg,
              details: JSON.stringify(parsed).substring(0, 500),
            });
            const err: any = new Error(errMsg);
            err.statusCode = resp.statusCode;
            err.response = parsed;
            reject(err);
          } else {
            resolve(parsed as T);
          }
        } catch {
          if (resp.statusCode && resp.statusCode >= 400) {
            reject(new Error(`Wix API error ${resp.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve(data as unknown as T);
          }
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Authenticated Wix API call (auto-retries once on 403 with a fresh token) */
async function wixApi<T>(
  installation: IInstallation,
  method: string,
  path: string,
  body?: Record<string, any>,
): Promise<T> {
  const token = await getAccessToken(installation);
  const url = `https://www.wixapis.com${path}`;
  try {
    return await wixRequest<T>(method, url, body ? JSON.stringify(body) : undefined, {
      Authorization: token,
    });
  } catch (err: any) {
    if (err.statusCode === 403) {
      // Invalidate cached token and retry once with a fresh token
      logger.warn('Wix API 403 — clearing token cache and retrying', {
        instanceId: installation.instanceId,
        path,
      });
      tokenCache.delete(installation.instanceId);
      const freshToken = await getAccessToken(installation);
      return wixRequest<T>(method, url, body ? JSON.stringify(body) : undefined, {
        Authorization: freshToken,
      });
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Get a contact by Wix ID
// ─────────────────────────────────────────────────────────────────────────────
export async function getWixContactById(
  installation: IInstallation,
  contactId: string,
): Promise<WixContact | null> {
  try {
    const result = await wixApi<any>(
      installation,
      'GET',
      `/contacts/v4/contacts/${contactId}`,
    );
    return (result?.contact ?? result) as WixContact;
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    const msg = err.message ?? '';
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) return null;
    logger.error('Failed to get Wix contact by ID', {
      instanceId: installation.instanceId,
      contactId,
      error: msg,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Get a contact by email address
// ─────────────────────────────────────────────────────────────────────────────
export async function getWixContactByEmail(
  installation: IInstallation,
  email: string,
): Promise<WixContact | null> {
  try {
    const emailLower = email.toLowerCase().trim();
    const result = await wixApi<any>(installation, 'POST', '/contacts/v4/contacts/query', {
      query: {
        filter: {
          'info.emails.email': { $eq: emailLower },
        },
        paging: { limit: 1 },
      },
    });

    const items = result?.contacts ?? [];
    if (items.length === 0) return null;
    return items[0] as WixContact;
  } catch (err) {
    logger.error('Failed to search Wix contacts by email', {
      instanceId: installation.instanceId,
      error: (err as Error).message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: List all Wix contacts (for full sync Phase 1)
// ─────────────────────────────────────────────────────────────────────────────
export async function listWixContacts(
  installation: IInstallation,
  limit = 100,
  offset = 0,
): Promise<{ contacts: WixContact[]; total: number }> {
  const result = await wixApi<any>(installation, 'POST', '/contacts/v4/contacts/query', {
    query: {
      paging: { limit, offset },
    },
  });

  return {
    contacts: (result?.contacts ?? []) as WixContact[],
    total: result?.pagingMetadata?.total ?? result?.contacts?.length ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create or update a Wix contact (with sync metadata)
// ─────────────────────────────────────────────────────────────────────────────
export async function createOrUpdateWixContact(
  installation: IInstallation,
  data: WixContactInput,
  syncMeta: SyncMetadata,
  wixContactId?: string,
): Promise<{ contactId: string; action: 'created' | 'updated' }> {
  const instanceId = installation.instanceId;

  // Build the contact info payload
  const info: Record<string, any> = {};
  if (data.firstName || data.lastName) {
    info.name = { first: data.firstName ?? '', last: data.lastName ?? '' };
  }
  if (data.email) {
    info.emails = [{ email: data.email.toLowerCase().trim(), tag: 'MAIN' }];
  }
  if (data.phone) {
    info.phones = [{ phone: data.phone, tag: 'MAIN' }];
  }
  if (data.company) info.company = data.company;
  if (data.jobTitle) info.jobTitle = data.jobTitle;

  // Attach extended fields for loop prevention (skip if custom fields don't exist)
  // The MongoDB-based ContactMapping + SyncDedupeLog provide the primary
  // loop-prevention mechanism; extended fields are a secondary safeguard.
  const extendedFields = {
    items: {
      [EXT_FIELD_HUBSPOT_ID]: syncMeta.hubspotContactId,
      [EXT_FIELD_SYNC_TAG]: syncMeta.syncTagId,
      [EXT_FIELD_SYNC_SOURCE]: syncMeta.syncSource,
    },
  };
  // Will be attached below; stripped out on EXTENDED_FIELD_NOT_FOUND errors

  /** Try a Wix API call; on EXTENDED_FIELD_NOT_FOUND, retry without extended fields */
  async function tryWithFallback<T>(
    fn: (payload: Record<string, any>) => Promise<T>,
    payload: Record<string, any>,
  ): Promise<T> {
    try {
      // First attempt: include extended fields
      const withExt = { ...payload, info: { ...payload.info, extendedFields } };
      return await fn(withExt);
    } catch (err: any) {
      const msg = err.message ?? '';
      const details = JSON.stringify(err.response ?? '');
      if (msg.includes('EXTENDED_FIELD_NOT_FOUND') || details.includes('EXTENDED_FIELD_NOT_FOUND')) {
        logger.warn('Extended fields not found on site — retrying without them', { instanceId });
        return await fn(payload);
      }
      throw err;
    }
  }

  // ── a. Direct update by known ID ──────────────────────────────────────
  if (wixContactId) {
    try {
      await tryWithFallback(
        (p) => wixApi(installation, 'PATCH', `/contacts/v4/contacts/${wixContactId}`, p),
        { info, revision: undefined },
      );

      logger.info('Wix contact updated', { instanceId, wixContactId, syncSource: syncMeta.syncSource });
      return { contactId: wixContactId, action: 'updated' };
    } catch (err: any) {
      // If the PATCH fails because revision is required, fetch and retry
      if (err.statusCode === 409 || err.message?.includes('REVISION')) {
        const existing = await getWixContactById(installation, wixContactId);
        const revision = (existing as any)?.revision ?? 1;
        await tryWithFallback(
          (p) => wixApi(installation, 'PATCH', `/contacts/v4/contacts/${wixContactId}`, p),
          { info, revision },
        );
        logger.info('Wix contact updated (with revision)', { instanceId, wixContactId });
        return { contactId: wixContactId, action: 'updated' };
      }
      logger.error('Failed to update Wix contact by ID', {
        instanceId,
        wixContactId,
        error: err.message,
      });
      throw err;
    }
  }

  // ── b. Search by email ────────────────────────────────────────────────
  let existingId: string | null = null;
  let existingRevision: number | undefined;

  if (data.email) {
    const existing = await getWixContactByEmail(installation, data.email);
    existingId = existing?.id ?? existing?._id ?? null;
    existingRevision = (existing as any)?.revision;
  }

  if (existingId) {
    await tryWithFallback(
      (p) => wixApi(installation, 'PATCH', `/contacts/v4/contacts/${existingId}`, p),
      { info, revision: existingRevision },
    );

    logger.info('Wix contact updated (upsert by email)', {
      instanceId,
      wixContactId: existingId,
      syncSource: syncMeta.syncSource,
    });
    return { contactId: existingId, action: 'updated' };
  }

  // ── c. Create new ─────────────────────────────────────────────────────
  const created = await tryWithFallback<any>(
    (p) => wixApi<any>(installation, 'POST', '/contacts/v4/contacts', p),
    { info },
  );

  const newId = created?.contact?.id ?? created?.contact?._id ?? created?.id ?? created?._id ?? '';
  if (!newId) {
    logger.error('Wix contact creation returned no ID', { instanceId, response: JSON.stringify(created).substring(0, 300) });
    throw new Error('Wix contact created but no id was returned');
  }

  logger.info('Wix contact created', {
    instanceId,
    wixContactId: newId,
    syncSource: syncMeta.syncSource,
  });
  return { contactId: newId, action: 'created' };
}
