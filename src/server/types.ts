// =============================================================================
// Shared Type Definitions
// =============================================================================

/** Sync direction for a field mapping rule */
export type SyncDirection = 'wix_to_hubspot' | 'hubspot_to_wix' | 'bidirectional';

/** Transform to apply before writing */
export type FieldTransform = 'none' | 'trim' | 'lowercase' | 'uppercase' | 'phone_e164';

/** Source of a sync event */
export type SyncSource = 'wix_webhook' | 'hubspot_webhook' | 'initial_sync' | 'manual';

/** Action taken during sync */
export type SyncAction = 'create' | 'update' | 'delete' | 'skip';

/** A single field mapping rule (Wix ↔ HubSpot) */
export interface FieldMappingRule {
  wixField: string;
  hubspotField: string;
  direction: SyncDirection;
  transform: FieldTransform;
}

/** Flat key-value contact representation (used internally) */
export interface FlatContact {
  [key: string]: string | undefined;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
}

/** HubSpot contact object from CRM API v3 */
export interface HubSpotContact {
  id: string;
  properties: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

/** Wix contact (simplified) */
export interface WixContact {
  id?: string;
  _id?: string;
  info?: {
    name?: { first?: string; last?: string };
    emails?: Array<{ email: string }>;
    phones?: Array<{ phone: string }>;
    company?: string;
    jobTitle?: string;
    addresses?: Array<{
      address?: string;
      city?: string;
      subdivision?: string;
      postalCode?: string;
      country?: string;
    }>;
  };
  [key: string]: unknown;
}

/** Wix form submission event data */
export interface WixFormSubmission {
  formId?: string;
  formName?: string;
  submissionId: string;
  contactId?: string;
  submissions?: Record<string, string>;
  fields?: Record<string, string>;
  extendedFields?: Record<string, string>;
}

/** Wix webhook event payload */
export interface WixWebhookEvent {
  eventType: string;
  instanceId: string;
  data: Record<string, unknown>;
}

/** HubSpot webhook event */
export interface HubSpotWebhookEvent {
  subscriptionType: string;
  objectId: number;
  portalId: number;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
}

/** Attribution data extracted from form submissions */
export interface Attribution {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  referrer: string;
  landingPage: string;
}

/** Result of a sync operation */
export interface SyncResult {
  action: SyncAction;
  source: SyncSource;
  hubspotContactId: string;
  wixContactId: string;
}

/** Field option for UI dropdowns */
export interface FieldOption {
  value: string;
  label: string;
  type?: string;
  description?: string;
}
