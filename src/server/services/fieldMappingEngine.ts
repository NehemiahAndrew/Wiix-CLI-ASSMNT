// =============================================================================
// Module 6: Field Mapping Engine
// =============================================================================
// Translates contact data between Wix format and HubSpot format based on
// user-configurable rules stored in the FieldMapping (FieldMappingRules)
// MongoDB collection.
//
// Exports:
//   1. loadMappingRules       — cached rule loader (30 s in-memory TTL)
//   2. saveMappingRules       — validate + persist a new set of rules
//   3. wixToHubSpot           — convert a Wix contact → HubSpot properties
//   4. hubSpotToWix           — convert HubSpot properties → Wix fields
//   5. validateRules          — catch duplicates, unknown fields, etc.
//   6. getWixFieldRegistry    — mappable Wix fields with labels (for UI)
//   7. applyTransform         — apply a single FieldTransform
//   8. flattenWixContact      — normalise nested Wix contact → FlatContact
//   9. seedDefaultMappings    — ensure the 4 undeletable defaults exist
//  10. invalidateRulesCache   — force a fresh load on the next call
// =============================================================================
import FieldMapping, { IFieldMapping, DEFAULT_FIELD_MAPPINGS } from '../models/FieldMapping';
import { fetchCustomProperties } from './hubspotProperties';
import logger from '../utils/logger';
import {
  FlatContact,
  FieldTransform,
  SyncDirection,
  FieldOption,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Cache TTL — 30 seconds */
const RULES_CACHE_TTL_MS = 30_000;

/**
 * The four default mappings that always apply and can never be deleted.
 * Stored as a set of composite keys for fast lookup.
 */
const UNDELETABLE_DEFAULTS = new Set([
  'primaryEmail→email',
  'firstName→firstname',
  'lastName→lastname',
  'primaryPhone→phone',
]);

/** Check whether a mapping rule is one of the four undeletable defaults */
export function isUndeletableDefault(wixField: string, hubspotField: string): boolean {
  return UNDELETABLE_DEFAULTS.has(`${wixField}→${hubspotField}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wix Contact Field Registry — every mappable field with human label
// ─────────────────────────────────────────────────────────────────────────────

const WIX_FIELD_REGISTRY: FieldOption[] = [
  // ── Core identity ──
  { value: 'firstName',    label: 'First Name',    type: 'string', description: 'Contact first name' },
  { value: 'lastName',     label: 'Last Name',     type: 'string', description: 'Contact last name' },
  { value: 'primaryEmail', label: 'Email',          type: 'string', description: 'Primary email address' },
  { value: 'primaryPhone', label: 'Phone',          type: 'string', description: 'Primary phone number' },

  // ── Professional ──
  { value: 'company',      label: 'Company',        type: 'string', description: 'Company / organisation name' },
  { value: 'jobTitle',     label: 'Job Title',      type: 'string', description: 'Position or role' },

  // ── Personal ──
  { value: 'birthdate',    label: 'Birthdate',      type: 'date',   description: 'Date of birth (ISO-8601)' },

  // ── Address ──
  { value: 'street',       label: 'Street Address', type: 'string', description: 'Street line of the primary address' },
  { value: 'city',         label: 'City',           type: 'string', description: 'City of the primary address' },
  { value: 'state',        label: 'State / Region', type: 'string', description: 'State, province or region' },
  { value: 'postalCode',   label: 'Postal Code',    type: 'string', description: 'ZIP or postal code' },
  { value: 'country',      label: 'Country',        type: 'string', description: 'Country code (ISO 3166-1)' },

  // ── Social ──
  { value: 'website',      label: 'Website',        type: 'string', description: 'Personal or company website URL' },

  // ── Extended fields (Wix custom fields) ──
  { value: 'locale',       label: 'Locale',         type: 'string', description: 'e.g. en-US' },
  { value: 'labelIds',     label: 'Labels',         type: 'array',  description: 'Wix contact label IDs' },
];

/** Valid Wix field names — used for fast validation */
const VALID_WIX_FIELDS = new Set(WIX_FIELD_REGISTRY.map((f) => f.value));

// ─────────────────────────────────────────────────────────────────────────────
// 6. Get Wix Field Registry (for UI dropdowns)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns every mappable Wix contact field with a human-readable label.
 * Used by the dashboard UI to populate field-picker dropdowns.
 */
export function getWixFieldRegistry(): FieldOption[] {
  return [...WIX_FIELD_REGISTRY];
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory rules cache (30 s TTL, per instanceId)
// ─────────────────────────────────────────────────────────────────────────────

interface CachedRules {
  rules: IFieldMapping[];
  expiresAt: number;
}

const rulesCache = new Map<string, CachedRules>();

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load active mapping rules (cached)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all active mapping rules for the given instance.
 *
 * The result is cached in memory for 30 seconds so the sync engine
 * does not query MongoDB on every single webhook.
 *
 * @param instanceId — Wix site instance
 * @param forceReload — bypass cache
 */
export async function loadMappingRules(
  instanceId: string,
  forceReload = false,
): Promise<IFieldMapping[]> {
  if (!forceReload) {
    const cached = rulesCache.get(instanceId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.rules;
    }
  }

  const rules = await FieldMapping.find({ instanceId, isActive: true }).sort({
    isDefault: -1,
    createdAt: 1,
  });

  rulesCache.set(instanceId, {
    rules,
    expiresAt: Date.now() + RULES_CACHE_TTL_MS,
  });

  return rules;
}

/** Force the cache to be invalidated for an instance (call after rule edits). */
export function invalidateRulesCache(instanceId: string): void {
  rulesCache.delete(instanceId);
}

/** Clear the entire rules cache (for testing). */
export function clearAllRulesCache(): void {
  rulesCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Apply Transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Applies a single {@link FieldTransform} to a value.
 *
 * | Transform   | Effect                              |
 * |-------------|-------------------------------------|
 * | `none`      | Pass through unchanged              |
 * | `trim`      | Remove leading/trailing whitespace  |
 * | `lowercase` | Convert to lower case               |
 * | `uppercase` | Convert to UPPER CASE               |
 * | `phone_e164`| Strip non-digits, prefix with +1    |
 */
export function applyTransform(
  value: string | undefined,
  transform: FieldTransform,
): string {
  if (value === undefined || value === null || value === '') return '';
  switch (transform) {
    case 'lowercase':
      return value.toLowerCase();
    case 'uppercase':
      return value.toUpperCase();
    case 'trim':
      return value.trim();
    case 'phone_e164': {
      const digits = value.replace(/\D/g, '');
      return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
    }
    case 'none':
    default:
      return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Flatten a Wix contact object → FlatContact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises a deeply-nested Wix contact object into a flat key-value map
 * whose keys match the Wix field registry values.
 *
 * Handles both the v4 nested shape (`info.name.first`) and the legacy
 * flat shape (`firstName`).
 */
export function flattenWixContact(wc: Record<string, any>): FlatContact {
  const addr = wc.info?.addresses?.items?.[0] ?? wc.info?.addresses?.[0] ?? {};
  const emailVal = wc.info?.emails?.items?.[0]?.email ?? wc.info?.emails?.[0]?.email ?? wc.primaryInfo?.email ?? wc.primaryEmail ?? '';
  const phoneVal = wc.info?.phones?.items?.[0]?.phone ?? wc.info?.phones?.[0]?.phone ?? wc.primaryPhone ?? '';
  return {
    firstName:    wc.info?.name?.first      ?? wc.firstName    ?? '',
    lastName:     wc.info?.name?.last       ?? wc.lastName     ?? '',
    primaryEmail: emailVal,
    primaryPhone: phoneVal,
    company:      wc.info?.company           ?? wc.company      ?? '',
    jobTitle:     wc.info?.jobTitle           ?? wc.jobTitle     ?? '',
    birthdate:    wc.info?.birthdate         ?? wc.birthdate    ?? '',
    street:       addr.address               ?? wc.street       ?? '',
    city:         addr.city                  ?? wc.city         ?? '',
    state:        addr.subdivision           ?? wc.state        ?? '',
    postalCode:   addr.postalCode            ?? wc.postalCode   ?? '',
    country:      addr.country               ?? wc.country      ?? '',
    website:      wc.info?.urls?.[0]?.url    ?? wc.website      ?? '',
    locale:       wc.info?.locale            ?? wc.locale       ?? '',

    // Legacy compat aliases used by the sync engine
    email: emailVal,
    phone: phoneVal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Wix → HubSpot conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a Wix contact into HubSpot properties using the given rules.
 *
 * Only rules whose direction is `'bidirectional'` or `'wix_to_hubspot'`
 * are applied.
 *
 * @param wixContact — Raw Wix contact object (nested or flat)
 * @param rules      — Active mapping rules for this instance
 * @returns          — Flat HubSpot properties object
 */
export function wixToHubSpot(
  wixContact: Record<string, any>,
  rules: IFieldMapping[],
): FlatContact {
  const flat = flattenWixContact(wixContact);
  const result: FlatContact = {};

  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.direction !== 'bidirectional' && rule.direction !== 'wix_to_hubspot') continue;

    const raw = flat[rule.wixField];
    if (raw !== undefined && raw !== '') {
      result[rule.hubspotField] = applyTransform(raw, rule.transform);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. HubSpot → Wix conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts HubSpot contact properties into Wix contact fields using the
 * given rules.
 *
 * Only rules whose direction is `'bidirectional'` or `'hubspot_to_wix'`
 * are applied.
 *
 * @param hubspotProps — Flat HubSpot properties object (`{ firstname: "…", … }`)
 * @param rules        — Active mapping rules for this instance
 * @returns            — Flat Wix field object
 */
export function hubSpotToWix(
  hubspotProps: FlatContact,
  rules: IFieldMapping[],
): FlatContact {
  const result: FlatContact = {};

  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.direction !== 'bidirectional' && rule.direction !== 'hubspot_to_wix') continue;

    const raw = hubspotProps[rule.hubspotField];
    if (raw !== undefined && raw !== '') {
      result[rule.wixField] = applyTransform(raw, rule.transform);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Validation
// ─────────────────────────────────────────────────────────────────────────────

/** A single validation error. */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validates a set of mapping rules and returns any errors found.
 *
 * Checks:
 *   1. Duplicate HubSpot property in the same effective direction.
 *   2. Wix field name does not exist in the field registry.
 *   3. HubSpot property name does not exist in the portal
 *      (requires the `hubspotProperties` list — pass `null` to skip).
 *   4. Missing required fields (wixField, hubspotField).
 *
 * @param rules              — Array of rules to validate
 * @param hubspotProperties  — Known HS property names (pass null to skip HS check)
 * @returns                  — Array of validation errors (empty = valid)
 */
export function validateRules(
  rules: Array<{
    wixField: string;
    hubspotField: string;
    direction: SyncDirection;
    transform?: FieldTransform;
  }>,
  hubspotProperties: Set<string> | null = null,
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Track HubSpot properties per effective direction for duplicate detection
  const seenWixToHs = new Set<string>();
  const seenHsToWix = new Set<string>();

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const prefix = `rules[${i}]`;

    // Missing fields
    if (!r.wixField) {
      errors.push({ field: prefix, message: 'wixField is required' });
    }
    if (!r.hubspotField) {
      errors.push({ field: prefix, message: 'hubspotField is required' });
    }
    if (!r.wixField || !r.hubspotField) continue;

    // Unknown Wix field
    if (!VALID_WIX_FIELDS.has(r.wixField)) {
      errors.push({
        field: `${prefix}.wixField`,
        message: `Unknown Wix field: "${r.wixField}". Valid fields: ${[...VALID_WIX_FIELDS].join(', ')}`,
      });
    }

    // Unknown HubSpot property (only if list was provided)
    if (hubspotProperties && !hubspotProperties.has(r.hubspotField)) {
      errors.push({
        field: `${prefix}.hubspotField`,
        message: `HubSpot property "${r.hubspotField}" does not exist in the connected portal`,
      });
    }

    // Duplicate HubSpot property per direction
    const effectiveDirections: string[] = [];
    if (r.direction === 'wix_to_hubspot' || r.direction === 'bidirectional') {
      effectiveDirections.push('wix_to_hubspot');
    }
    if (r.direction === 'hubspot_to_wix' || r.direction === 'bidirectional') {
      effectiveDirections.push('hubspot_to_wix');
    }

    for (const dir of effectiveDirections) {
      const targetProp = dir === 'wix_to_hubspot' ? r.hubspotField : r.wixField;
      const set = dir === 'wix_to_hubspot' ? seenWixToHs : seenHsToWix;

      if (set.has(targetProp)) {
        errors.push({
          field: `${prefix}.${dir === 'wix_to_hubspot' ? 'hubspotField' : 'wixField'}`,
          message: `Duplicate target "${targetProp}" in ${dir} direction — a property can only be mapped once per direction`,
        });
      } else {
        set.add(targetProp);
      }
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Save mapping rules (bulk replace with validation)
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveRulesInput {
  wixField: string;
  hubspotField: string;
  direction: SyncDirection;
  transform: FieldTransform;
}

export interface SaveRulesResult {
  ok: boolean;
  rules?: IFieldMapping[];
  errors?: ValidationError[];
}

/**
 * Replaces all non-default mapping rules for an instance with a new set.
 *
 * Steps:
 *   1. Validate the incoming rules (duplicates, unknown fields).
 *   2. Delete existing custom (non-default) rules.
 *   3. Insert new custom rules.
 *   4. Ensure the 4 undeletable defaults still exist.
 *   5. Invalidate the in-memory rules cache.
 *
 * @param instanceId          — Wix site instance
 * @param incoming            — New rules to save
 * @param hubspotPropertyNames — Known HS property names (for validation)
 * @returns                   — Result with either the saved rules or errors
 */
export async function saveMappingRules(
  instanceId: string,
  incoming: SaveRulesInput[],
  hubspotPropertyNames: Set<string> | null = null,
): Promise<SaveRulesResult> {
  // Validate
  const validationErrors = validateRules(incoming, hubspotPropertyNames);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors };
  }

  try {
    // Remove custom rules (keep defaults)
    await FieldMapping.deleteMany({ instanceId, isDefault: false });

    // Filter out any incoming rules that duplicate a default
    const customRules = incoming.filter(
      (r) => !isUndeletableDefault(r.wixField, r.hubspotField),
    );

    // Insert custom rules
    if (customRules.length > 0) {
      await FieldMapping.insertMany(
        customRules.map((r) => ({
          instanceId,
          wixField: r.wixField,
          hubspotField: r.hubspotField,
          direction: r.direction,
          transform: r.transform,
          isDefault: false,
          isActive: true,
        })),
      );
    }

    // Ensure defaults exist
    await seedDefaultMappings(instanceId);

    // Invalidate cache
    invalidateRulesCache(instanceId);

    // Return the full set
    const rules = await loadMappingRules(instanceId, true);
    return { ok: true, rules };
  } catch (err) {
    logger.error('saveMappingRules failed', {
      instanceId,
      error: (err as Error).message,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Seed default mappings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the four undeletable default mappings exist for an instance.
 *
 * Uses `updateOne` with `$setOnInsert` so existing defaults are never
 * overwritten — only created if missing.
 */
export async function seedDefaultMappings(instanceId: string): Promise<void> {
  const defaults = DEFAULT_FIELD_MAPPINGS.filter((d) =>
    isUndeletableDefault(d.wixField, d.hubspotField),
  );

  const ops = defaults.map((d) => ({
    updateOne: {
      filter: { instanceId, wixField: d.wixField, hubspotField: d.hubspotField },
      update: {
        $setOnInsert: {
          instanceId,
          wixField: d.wixField,
          hubspotField: d.hubspotField,
          direction: d.direction,
          transform: d.transform,
          isDefault: true,
          isActive: true,
        },
      },
      upsert: true,
    },
  }));

  await FieldMapping.bulkWrite(ops);
}
