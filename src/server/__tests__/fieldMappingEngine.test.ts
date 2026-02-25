// =============================================================================
// Field Mapping Engine Tests (Module 6)
// =============================================================================
// Tests: wixToHubSpot, hubSpotToWix, applyTransform, validateRules,
//        flattenWixContact, isUndeletableDefault, getWixFieldRegistry
// =============================================================================

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.WIX_APP_ID = 'test-wix-app-id';
process.env.WIX_APP_SECRET = 'test-wix-app-secret';
process.env.HUBSPOT_CLIENT_ID = 'test-hs-id';
process.env.HUBSPOT_CLIENT_SECRET = 'test-hs-secret';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';

// ── Mock FieldMapping model ─────────────────────────────────────────────────
jest.mock('../models/FieldMapping', () => {
  const actual: any = {
    find: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue([]) }),
    deleteMany: jest.fn().mockResolvedValue({}),
    insertMany: jest.fn().mockResolvedValue([]),
    bulkWrite: jest.fn().mockResolvedValue({}),
  };

  // Re-export DEFAULT_FIELD_MAPPINGS from the real module
  actual.DEFAULT_FIELD_MAPPINGS = [
    { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional', transform: 'none' },
    { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional', transform: 'none' },
    { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional', transform: 'lowercase' },
    { wixField: 'primaryPhone', hubspotField: 'phone', direction: 'bidirectional', transform: 'phone_e164' },
    { wixField: 'company', hubspotField: 'company', direction: 'bidirectional', transform: 'none' },
    { wixField: 'jobTitle', hubspotField: 'jobtitle', direction: 'bidirectional', transform: 'none' },
    { wixField: 'birthdate', hubspotField: 'date_of_birth', direction: 'wix_to_hubspot', transform: 'none' },
    { wixField: 'addresses', hubspotField: 'address', direction: 'wix_to_hubspot', transform: 'none' },
  ];

  return {
    __esModule: true,
    default: actual,
    DEFAULT_FIELD_MAPPINGS: actual.DEFAULT_FIELD_MAPPINGS,
  };
});

jest.mock('../services/hubspotProperties', () => ({
  __esModule: true,
  fetchCustomProperties: jest.fn().mockResolvedValue([]),
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

import {
  applyTransform,
  wixToHubSpot,
  hubSpotToWix,
  validateRules,
  flattenWixContact,
  isUndeletableDefault,
  getWixFieldRegistry,
  clearAllRulesCache,
  loadMappingRules,
  saveMappingRules,
  seedDefaultMappings,
  invalidateRulesCache,
} from '../services/fieldMappingEngine';
import { IFieldMapping } from '../models/FieldMapping';

beforeEach(() => {
  clearAllRulesCache();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// applyTransform
// ─────────────────────────────────────────────────────────────────────────────

describe('applyTransform', () => {
  it('should return value unchanged with "none" transform', () => {
    expect(applyTransform('Hello World', 'none')).toBe('Hello World');
  });

  it('should convert to lowercase', () => {
    expect(applyTransform('John DOE', 'lowercase')).toBe('john doe');
  });

  it('should convert to uppercase', () => {
    expect(applyTransform('hello', 'uppercase')).toBe('HELLO');
  });

  it('should trim whitespace', () => {
    expect(applyTransform('  hello  ', 'trim')).toBe('hello');
  });

  it('should trim tabs and newlines', () => {
    expect(applyTransform('\t hello \n', 'trim')).toBe('hello');
  });

  it('should convert phone to E.164 (US number without country code)', () => {
    expect(applyTransform('(555) 123-4567', 'phone_e164')).toBe('+15551234567');
  });

  it('should convert phone to E.164 (US number with country code)', () => {
    expect(applyTransform('15551234567', 'phone_e164')).toBe('+15551234567');
  });

  it('should convert phone with dashes', () => {
    expect(applyTransform('555-123-4567', 'phone_e164')).toBe('+15551234567');
  });

  it('should return empty string for undefined value', () => {
    expect(applyTransform(undefined, 'lowercase')).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(applyTransform('', 'uppercase')).toBe('');
  });

  it('should return empty string for null-ish value', () => {
    expect(applyTransform(null as any, 'trim')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flattenWixContact
// ─────────────────────────────────────────────────────────────────────────────

describe('flattenWixContact', () => {
  it('should flatten a nested Wix v4 contact', () => {
    const wc = {
      info: {
        name: { first: 'John', last: 'Doe' },
        emails: [{ email: 'john@test.com' }],
        phones: [{ phone: '+15551234567' }],
        company: 'Acme',
        jobTitle: 'CEO',
        addresses: [{ city: 'NYC', country: 'US' }],
      },
    };

    const flat = flattenWixContact(wc);
    expect(flat.firstName).toBe('John');
    expect(flat.lastName).toBe('Doe');
    expect(flat.primaryEmail).toBe('john@test.com');
    expect(flat.email).toBe('john@test.com');
    expect(flat.primaryPhone).toBe('+15551234567');
    expect(flat.company).toBe('Acme');
    expect(flat.jobTitle).toBe('CEO');
    expect(flat.city).toBe('NYC');
    expect(flat.country).toBe('US');
  });

  it('should fall back to flat field names for legacy contacts', () => {
    const wc = {
      firstName: 'Jane',
      lastName: 'Smith',
      primaryEmail: 'jane@test.com',
    };

    const flat = flattenWixContact(wc);
    expect(flat.firstName).toBe('Jane');
    expect(flat.lastName).toBe('Smith');
    expect(flat.primaryEmail).toBe('jane@test.com');
  });

  it('should default missing fields to empty string', () => {
    const flat = flattenWixContact({});
    expect(flat.firstName).toBe('');
    expect(flat.lastName).toBe('');
    expect(flat.email).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wixToHubSpot — default mapping rules
// ─────────────────────────────────────────────────────────────────────────────

describe('wixToHubSpot', () => {
  // Build mock rules from the default mappings
  const defaultRules = [
    { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional', transform: 'lowercase', isActive: true, isDefault: true },
    { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional', transform: 'none', isActive: true, isDefault: true },
    { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional', transform: 'none', isActive: true, isDefault: true },
    { wixField: 'primaryPhone', hubspotField: 'phone', direction: 'bidirectional', transform: 'phone_e164', isActive: true, isDefault: true },
  ] as unknown as IFieldMapping[];

  it('should map email with lowercase transform', () => {
    const wixContact = {
      info: {
        name: { first: 'John', last: 'Doe' },
        emails: [{ email: 'JOHN@TEST.COM' }],
      },
    };
    const hsProps = wixToHubSpot(wixContact, defaultRules);
    expect(hsProps.email).toBe('john@test.com');
  });

  it('should map firstName and lastName with no transform', () => {
    const wixContact = {
      info: {
        name: { first: 'John', last: 'Doe' },
        emails: [{ email: 'john@test.com' }],
      },
    };
    const hsProps = wixToHubSpot(wixContact, defaultRules);
    expect(hsProps.firstname).toBe('John');
    expect(hsProps.lastname).toBe('Doe');
  });

  it('should map phone with phone_e164 transform', () => {
    const wixContact = {
      info: {
        phones: [{ phone: '(555) 123-4567' }],
      },
    };
    const hsProps = wixToHubSpot(wixContact, defaultRules);
    expect(hsProps.phone).toBe('+15551234567');
  });

  it('should not include fields with empty values', () => {
    const wixContact = {
      info: {
        name: { first: 'John', last: '' },
        emails: [{ email: 'john@test.com' }],
      },
    };
    const hsProps = wixToHubSpot(wixContact, defaultRules);
    expect(hsProps.firstname).toBe('John');
    expect(hsProps.lastname).toBeUndefined(); // empty value is skipped
    expect(hsProps.email).toBe('john@test.com');
  });

  it('should NOT apply rules with inactive status', () => {
    const rulesWithInactive = [
      ...defaultRules,
      {
        wixField: 'company',
        hubspotField: 'company',
        direction: 'bidirectional',
        transform: 'none',
        isActive: false,
        isDefault: false,
      } as unknown as IFieldMapping,
    ];

    const wixContact = {
      info: {
        name: { first: 'John' },
        company: 'Acme',
      },
    };

    const hsProps = wixToHubSpot(wixContact, rulesWithInactive);
    expect(hsProps.company).toBeUndefined();
  });

  it('should NOT apply rules with hubspot_to_wix direction only', () => {
    const oneWayRules = [
      {
        wixField: 'firstName',
        hubspotField: 'firstname',
        direction: 'hubspot_to_wix',
        transform: 'none',
        isActive: true,
      } as unknown as IFieldMapping,
    ];

    const wixContact = { info: { name: { first: 'John' } } };
    const hsProps = wixToHubSpot(wixContact, oneWayRules);
    expect(hsProps.firstname).toBeUndefined();
  });

  it('should apply active custom rules', () => {
    const customRules = [
      ...defaultRules,
      {
        wixField: 'company',
        hubspotField: 'company',
        direction: 'wix_to_hubspot',
        transform: 'uppercase',
        isActive: true,
        isDefault: false,
      } as unknown as IFieldMapping,
    ];

    const wixContact = {
      info: {
        name: { first: 'John' },
        company: 'acme corp',
      },
    };

    const hsProps = wixToHubSpot(wixContact, customRules);
    expect(hsProps.company).toBe('ACME CORP');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hubSpotToWix — reverse default mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('hubSpotToWix', () => {
  const defaultRules = [
    { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional', transform: 'lowercase', isActive: true },
    { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional', transform: 'none', isActive: true },
    { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional', transform: 'none', isActive: true },
    { wixField: 'primaryPhone', hubspotField: 'phone', direction: 'bidirectional', transform: 'phone_e164', isActive: true },
  ] as unknown as IFieldMapping[];

  it('should map HubSpot firstname → Wix firstName', () => {
    const hs = { firstname: 'John', lastname: 'Doe', email: 'john@test.com' };
    const wix = hubSpotToWix(hs, defaultRules);
    expect(wix.firstName).toBe('John');
    expect(wix.lastName).toBe('Doe');
    expect(wix.primaryEmail).toBe('john@test.com');
  });

  it('should apply phone_e164 transform for HS→Wix phone', () => {
    const hs = { phone: '5551234567' };
    const wix = hubSpotToWix(hs, defaultRules);
    expect(wix.primaryPhone).toBe('+15551234567');
  });

  it('should NOT apply wix_to_hubspot-only rules in reverse', () => {
    const oneWayRules = [
      {
        wixField: 'company',
        hubspotField: 'company',
        direction: 'wix_to_hubspot',
        transform: 'none',
        isActive: true,
      } as unknown as IFieldMapping,
    ];

    const hs = { company: 'Acme' };
    const wix = hubSpotToWix(hs, oneWayRules);
    expect(wix.company).toBeUndefined();
  });

  it('should NOT apply inactive rules', () => {
    const inactiveRules = [
      {
        wixField: 'firstName',
        hubspotField: 'firstname',
        direction: 'bidirectional',
        transform: 'none',
        isActive: false,
      } as unknown as IFieldMapping,
    ];

    const hs = { firstname: 'John' };
    const wix = hubSpotToWix(hs, inactiveRules);
    expect(wix.firstName).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateRules — catches duplicates and invalid fields
// ─────────────────────────────────────────────────────────────────────────────

describe('validateRules', () => {
  it('should return no errors for valid rules', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional' as const },
      { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules);
    expect(errors).toHaveLength(0);
  });

  it('should catch duplicate HubSpot property mappings in same direction', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'firstname', direction: 'wix_to_hubspot' as const },
      { wixField: 'lastName', hubspotField: 'firstname', direction: 'wix_to_hubspot' as const },
    ];
    const errors = validateRules(rules);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e: any) => e.message.includes('Duplicate target'))).toBe(true);
  });

  it('should catch duplicate Wix field mappings in hubspot_to_wix direction', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'firstname', direction: 'hubspot_to_wix' as const },
      { wixField: 'firstName', hubspotField: 'custom_prop', direction: 'hubspot_to_wix' as const },
    ];
    const errors = validateRules(rules);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e: any) => e.message.includes('Duplicate target'))).toBe(true);
  });

  it('should NOT flag same hubspotField when directions are non-overlapping', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'firstname', direction: 'wix_to_hubspot' as const },
      { wixField: 'lastName', hubspotField: 'firstname', direction: 'hubspot_to_wix' as const },
    ];
    // Same HS field but different effective directions — should be fine
    const errors = validateRules(rules);
    expect(errors).toHaveLength(0);
  });

  it('should catch missing wixField', () => {
    const rules = [
      { wixField: '', hubspotField: 'firstname', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules);
    expect(errors.some((e: any) => e.message.includes('wixField is required'))).toBe(true);
  });

  it('should catch missing hubspotField', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: '', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules);
    expect(errors.some((e: any) => e.message.includes('hubspotField is required'))).toBe(true);
  });

  it('should catch unknown Wix field names', () => {
    const rules = [
      { wixField: 'nonexistentField', hubspotField: 'something', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules);
    expect(errors.some((e: any) => e.message.includes('Unknown Wix field'))).toBe(true);
  });

  it('should catch unknown HubSpot properties when list is provided', () => {
    const knownProps = new Set(['email', 'firstname']);
    const rules = [
      { wixField: 'firstName', hubspotField: 'unknown_hs_prop', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules, knownProps);
    expect(errors.some((e: any) => e.message.includes('does not exist'))).toBe(true);
  });

  it('should skip HubSpot property validation when list is null', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'any_prop', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules, null);
    // No HS property error (only unknown Wix field check applies)
    expect(errors.filter((e: any) => e.message.includes('does not exist'))).toHaveLength(0);
  });

  it('should detect bidirectional duplicate in both directions', () => {
    const rules = [
      { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional' as const },
      { wixField: 'lastName', hubspotField: 'firstname', direction: 'bidirectional' as const },
    ];
    const errors = validateRules(rules);
    // firstname is duplicated in both wix_to_hubspot and hubspot_to_wix
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isUndeletableDefault
// ─────────────────────────────────────────────────────────────────────────────

describe('isUndeletableDefault', () => {
  it('should return true for the four default mappings', () => {
    expect(isUndeletableDefault('primaryEmail', 'email')).toBe(true);
    expect(isUndeletableDefault('firstName', 'firstname')).toBe(true);
    expect(isUndeletableDefault('lastName', 'lastname')).toBe(true);
    expect(isUndeletableDefault('primaryPhone', 'phone')).toBe(true);
  });

  it('should return false for non-default mappings', () => {
    expect(isUndeletableDefault('company', 'company')).toBe(false);
    expect(isUndeletableDefault('jobTitle', 'jobtitle')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getWixFieldRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe('getWixFieldRegistry', () => {
  it('should return a non-empty array of field definitions', () => {
    const fields = getWixFieldRegistry();
    expect(fields.length).toBeGreaterThan(0);
  });

  it('should include the four core fields', () => {
    const fields = getWixFieldRegistry();
    const values = fields.map((f: any) => f.value);
    expect(values).toContain('firstName');
    expect(values).toContain('lastName');
    expect(values).toContain('primaryEmail');
    expect(values).toContain('primaryPhone');
  });

  it('should return a copy (not mutate internal registry)', () => {
    const a = getWixFieldRegistry();
    const b = getWixFieldRegistry();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadMappingRules — cache behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('loadMappingRules', () => {
  const FieldMapping = require('../models/FieldMapping').default;

  it('should query the database on first call (cache miss)', async () => {
    FieldMapping.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([{ wixField: 'firstName' }]) });

    const rules = await loadMappingRules('inst-1');

    expect(FieldMapping.find).toHaveBeenCalledWith({ instanceId: 'inst-1', isActive: true });
    expect(rules).toHaveLength(1);
  });

  it('should return cached rules within TTL window', async () => {
    FieldMapping.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([{ wixField: 'firstName' }]) });

    // First call — populates cache
    const first = await loadMappingRules('inst-cache');
    const callCount = FieldMapping.find.mock.calls.length;

    // Second call — should hit cache
    const second = await loadMappingRules('inst-cache');

    expect(FieldMapping.find).toHaveBeenCalledTimes(callCount); // No additional call
    expect(second).toBe(first); // Same reference
  });

  it('should bypass cache when forceReload is true', async () => {
    FieldMapping.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([{ wixField: 'x' }]) });

    await loadMappingRules('inst-force');
    const callCount = FieldMapping.find.mock.calls.length;

    await loadMappingRules('inst-force', true);

    expect(FieldMapping.find.mock.calls.length).toBe(callCount + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidateRulesCache
// ─────────────────────────────────────────────────────────────────────────────

describe('invalidateRulesCache', () => {
  const FieldMapping = require('../models/FieldMapping').default;

  it('should cause next loadMappingRules to query DB again', async () => {
    FieldMapping.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    await loadMappingRules('inst-inv');
    const callCount = FieldMapping.find.mock.calls.length;

    invalidateRulesCache('inst-inv');

    await loadMappingRules('inst-inv');

    expect(FieldMapping.find.mock.calls.length).toBe(callCount + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// seedDefaultMappings
// ─────────────────────────────────────────────────────────────────────────────

describe('seedDefaultMappings', () => {
  const FieldMapping = require('../models/FieldMapping').default;

  it('should call bulkWrite with upsert operations for defaults', async () => {
    FieldMapping.bulkWrite.mockResolvedValue({});

    await seedDefaultMappings('inst-seed');

    expect(FieldMapping.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = FieldMapping.bulkWrite.mock.calls[0][0];
    expect(ops.length).toBe(4); // 4 undeletable defaults
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(ops[0].updateOne.update.$setOnInsert).toHaveProperty('isDefault', true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// saveMappingRules
// ─────────────────────────────────────────────────────────────────────────────

describe('saveMappingRules', () => {
  const FieldMapping = require('../models/FieldMapping').default;

  beforeEach(() => {
    FieldMapping.deleteMany.mockResolvedValue({});
    FieldMapping.insertMany.mockResolvedValue([]);
    FieldMapping.bulkWrite.mockResolvedValue({});
    FieldMapping.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
  });

  it('should return validation errors and not persist when rules are invalid', async () => {
    const badRules = [
      { wixField: '', hubspotField: 'email', direction: 'bidirectional' as const, transform: 'none' as const },
    ];

    const result = await saveMappingRules('inst-save', badRules);

    expect(result.ok).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(FieldMapping.deleteMany).not.toHaveBeenCalled();
  });

  it('should delete custom rules, insert new ones, and seed defaults', async () => {
    const rules = [
      { wixField: 'company', hubspotField: 'company', direction: 'bidirectional' as const, transform: 'none' as const },
    ];

    const result = await saveMappingRules('inst-save2', rules);

    expect(result.ok).toBe(true);
    expect(FieldMapping.deleteMany).toHaveBeenCalledWith({ instanceId: 'inst-save2', isDefault: false });
    expect(FieldMapping.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ wixField: 'company', hubspotField: 'company', isDefault: false }),
      ]),
    );
    expect(FieldMapping.bulkWrite).toHaveBeenCalled(); // seedDefaultMappings
  });

  it('should skip inserting rules that match undeletable defaults', async () => {
    const rules = [
      // This is a default → should NOT be inserted
      { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional' as const, transform: 'lowercase' as const },
      // This is custom → should be inserted
      { wixField: 'company', hubspotField: 'company', direction: 'bidirectional' as const, transform: 'none' as const },
    ];

    await saveMappingRules('inst-save3', rules);

    const insertedRules = FieldMapping.insertMany.mock.calls[0][0];
    // Only the custom rule is inserted (default is filtered out)
    expect(insertedRules).toHaveLength(1);
    expect(insertedRules[0].wixField).toBe('company');
  });

  it('should not call insertMany when only default mappings are provided', async () => {
    const rules = [
      { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional' as const, transform: 'lowercase' as const },
    ];

    await saveMappingRules('inst-save4', rules);

    // No custom rules → insertMany not called
    expect(FieldMapping.insertMany).not.toHaveBeenCalled();
  });

  it('should invalidate cache and reload rules after saving', async () => {
    FieldMapping.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([{ wixField: 'company', hubspotField: 'company' }]),
    });

    const rules = [
      { wixField: 'company', hubspotField: 'company', direction: 'bidirectional' as const, transform: 'none' as const },
    ];

    const result = await saveMappingRules('inst-save5', rules);

    expect(result.ok).toBe(true);
    expect(result.rules).toHaveLength(1);
  });

  it('should throw when database operations fail', async () => {
    FieldMapping.deleteMany.mockRejectedValue(new Error('DB connection lost'));

    const rules = [
      { wixField: 'company', hubspotField: 'company', direction: 'bidirectional' as const, transform: 'none' as const },
    ];

    await expect(saveMappingRules('inst-fail', rules)).rejects.toThrow('DB connection lost');
  });
});
