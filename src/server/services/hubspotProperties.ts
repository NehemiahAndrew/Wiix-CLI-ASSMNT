// =============================================================================
// Module 2-C: HubSpot Properties Wrapper
// =============================================================================
// Three functions that manage custom contact properties in HubSpot:
//
//   1. fetchCustomProperties     — list all custom properties, filtering out
//                                   internal read-only ones
//   2. createCustomProperty      — create a new custom contact property
//   3. ensureRequiredProperties   — guarantee three special properties exist:
//                                   • wix_contact_id   (Wix Contact ID)
//                                   • wix_sync_tag     (Sync Tag UUID)
//                                   • wix_last_sync_at (Last Sync Timestamp)
//
// All functions use the Module 2-A `withRetry` helper for 429 / 5xx handling.
// =============================================================================
import { AxiosResponse, AxiosError } from 'axios';
import { withRetry } from './hubspotClient';
import logger from '../utils/logger';
import { FieldOption } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** HubSpot property definition as returned by the Properties API */
interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description: string;
  calculated: boolean;
  externalOptions: boolean;
  /** Properties where `hubspotDefined` is true are internal/system props */
  hubspotDefined: boolean;
  /** Read-only properties cannot be written to */
  modificationMetadata?: {
    readOnlyValue: boolean;
    readOnlyDefinition: boolean;
    archivable: boolean;
  };
  hidden: boolean;
  displayOrder: number;
  hasUniqueValue: boolean;
}

/** Input for creating a new custom property */
export interface CreatePropertyInput {
  name: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'enumeration' | 'bool';
  fieldType: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'booleancheckbox';
  groupName?: string;
  description?: string;
  displayOrder?: number;
  hasUniqueValue?: boolean;
  options?: Array<{ label: string; value: string; displayOrder?: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants — the three required properties
// ─────────────────────────────────────────────────────────────────────────────

/** Custom property group we create to keep our props organized */
const WIX_PROPERTY_GROUP = 'wix_integration';

/** The three properties that must exist on every connected HubSpot portal */
const REQUIRED_PROPERTIES: CreatePropertyInput[] = [
  {
    name: 'wix_contact_id',
    label: 'Wix Contact ID',
    type: 'string',
    fieldType: 'text',
    groupName: WIX_PROPERTY_GROUP,
    description:
      'The unique contact ID from the connected Wix site. Set automatically by the Wix–HubSpot integration.',
    hasUniqueValue: false,
  },
  {
    name: 'wix_sync_tag',
    label: 'Wix Sync Tag',
    type: 'string',
    fieldType: 'text',
    groupName: WIX_PROPERTY_GROUP,
    description:
      'UUID written by the integration after each sync write. Used for loop-prevention — webhooks triggered by this write are identified and skipped.',
    hasUniqueValue: false,
  },
  {
    name: 'wix_last_sync_at',
    label: 'Wix Last Sync At',
    type: 'datetime',
    fieldType: 'date',
    groupName: WIX_PROPERTY_GROUP,
    description:
      'ISO-8601 timestamp of the last time this contact was synced by the Wix–HubSpot integration.',
    hasUniqueValue: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Fetch custom contact properties (filtered)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves all custom contact properties from HubSpot, filtering out
 * internal, read-only, and HubSpot-defined system properties.
 *
 * The returned list is useful for the field-mapping UI — it shows only
 * properties that can actually be written to by the integration.
 *
 * @param instanceId — Wix site instance
 * @returns          — Array of writable custom properties
 */
export async function fetchCustomProperties(
  instanceId: string,
): Promise<FieldOption[]> {
  const res: AxiosResponse = await withRetry(instanceId, (client) =>
    client.get('/crm/v3/properties/contacts'),
  );

  const allProps = (res.data?.results ?? []) as HubSpotProperty[];

  // Filter out:
  //   • hubspotDefined (system/internal props like hs_email_domain)
  //   • hidden properties
  //   • read-only value properties
  //   • calculated properties
  const writable = allProps.filter((p) => {
    if (p.hubspotDefined) return false;
    if (p.hidden) return false;
    if (p.calculated) return false;
    if (p.modificationMetadata?.readOnlyValue) return false;
    return true;
  });

  logger.debug('Fetched custom HubSpot properties', {
    instanceId,
    total: allProps.length,
    writable: writable.length,
  });

  return writable.map((p) => ({
    value: p.name,
    label: p.label,
    type: p.type,
    description: p.description,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Create a custom contact property
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new custom contact property in HubSpot.
 *
 * If the property already exists (HTTP 409 Conflict), this function logs
 * a warning and returns gracefully — it does NOT throw.
 *
 * @param instanceId — Wix site instance
 * @param input      — Property definition (name, label, type, etc.)
 */
export async function createCustomProperty(
  instanceId: string,
  input: CreatePropertyInput,
): Promise<void> {
  try {
    await withRetry(instanceId, (client) =>
      client.post('/crm/v3/properties/contacts', {
        name: input.name,
        label: input.label,
        type: input.type,
        fieldType: input.fieldType,
        groupName: input.groupName || 'contactinformation',
        description: input.description || '',
        displayOrder: input.displayOrder ?? -1,
        hasUniqueValue: input.hasUniqueValue ?? false,
        ...(input.options ? { options: input.options } : {}),
      }),
    );

    logger.info('Custom HubSpot property created', {
      instanceId,
      propertyName: input.name,
    });
  } catch (err: any) {
    const status = (err as AxiosError)?.response?.status;

    // 409 Conflict = property already exists — that's fine
    if (status === 409) {
      logger.warn('HubSpot property already exists (409), skipping creation', {
        instanceId,
        propertyName: input.name,
      });
      return;
    }

    logger.error('Failed to create custom HubSpot property', {
      instanceId,
      propertyName: input.name,
      status,
      message: (err as Error).message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ensure required properties exist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Makes sure three special properties exist on the connected HubSpot portal:
 *
 *   | Property Name     | Purpose                              |
 *   |-------------------|---------------------------------------|
 *   | wix_contact_id    | Store the linked Wix contact ID       |
 *   | wix_sync_tag      | UUID for loop-prevention sync tagging |
 *   | wix_last_sync_at  | Timestamp of the last sync write      |
 *
 * For each property, the function:
 *   a. Tries to fetch it from HubSpot.
 *   b. If it doesn't exist (404), creates it automatically.
 *   c. If it already exists, does nothing.
 *
 * Also ensures the `wix_integration` property group exists before creating
 * properties that reference it.
 *
 * This should be called once after a new HubSpot portal is connected
 * (e.g. in the OAuth callback or on first sync).
 *
 * @param instanceId — Wix site instance
 */
export async function ensureRequiredProperties(
  instanceId: string,
): Promise<void> {
  logger.info('Ensuring required HubSpot properties exist', { instanceId });

  // ── Ensure the property group exists ──────────────────────────────────
  await ensurePropertyGroup(instanceId);

  // ── Check + create each required property ─────────────────────────────
  for (const propDef of REQUIRED_PROPERTIES) {
    const exists = await propertyExists(instanceId, propDef.name);

    if (exists) {
      logger.debug('Required property already exists', {
        instanceId,
        propertyName: propDef.name,
      });
    } else {
      logger.info('Creating missing required property', {
        instanceId,
        propertyName: propDef.name,
      });
      await createCustomProperty(instanceId, propDef);
    }
  }

  logger.info('All required HubSpot properties are in place', { instanceId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a contact property with the given name exists in HubSpot.
 */
async function propertyExists(
  instanceId: string,
  propertyName: string,
): Promise<boolean> {
  try {
    await withRetry(instanceId, (client) =>
      client.get(`/crm/v3/properties/contacts/${propertyName}`),
    );
    return true;
  } catch (err: any) {
    if ((err as AxiosError)?.response?.status === 404) return false;
    // For other errors (network, 5xx that exhausted retries), re-throw
    throw err;
  }
}

/**
 * Ensures the `wix_integration` property group exists.
 * If it already exists (409), silently succeeds.
 */
async function ensurePropertyGroup(instanceId: string): Promise<void> {
  try {
    await withRetry(instanceId, (client) =>
      client.post('/crm/v3/properties/contacts/groups', {
        name: WIX_PROPERTY_GROUP,
        label: 'Wix Integration',
        displayOrder: -1,
      }),
    );
    logger.info('Created HubSpot property group', {
      instanceId,
      groupName: WIX_PROPERTY_GROUP,
    });
  } catch (err: any) {
    const status = (err as AxiosError)?.response?.status;
    if (status === 409) {
      // Group already exists — fine
      return;
    }
    // Some portals may not support custom groups — log and continue
    logger.warn('Could not create property group (non-fatal)', {
      instanceId,
      groupName: WIX_PROPERTY_GROUP,
      status,
    });
  }
}
