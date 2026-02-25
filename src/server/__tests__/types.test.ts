// =============================================================================
// Type Definitions Tests — ensures types compile and are correct
// =============================================================================
import {
  SyncDirection,
  FieldTransform,
  SyncSource,
  SyncAction,
  FlatContact,
  HubSpotContact,
  Attribution,
  SyncResult,
  FieldOption,
  WixFormSubmission,
  HubSpotWebhookEvent,
} from '../types';

describe('Type definitions compile correctly', () => {
  it('should accept valid SyncDirection values', () => {
    const dirs: SyncDirection[] = ['wix_to_hubspot', 'hubspot_to_wix', 'bidirectional'];
    expect(dirs).toHaveLength(3);
  });

  it('should accept valid FieldTransform values', () => {
    const transforms: FieldTransform[] = ['none', 'trim', 'lowercase', 'uppercase', 'phone_e164'];
    expect(transforms).toHaveLength(5);
  });

  it('should accept valid SyncSource values', () => {
    const sources: SyncSource[] = ['wix_webhook', 'hubspot_webhook', 'initial_sync', 'manual'];
    expect(sources).toHaveLength(4);
  });

  it('should accept valid SyncAction values', () => {
    const actions: SyncAction[] = ['create', 'update', 'delete', 'skip'];
    expect(actions).toHaveLength(4);
  });

  it('should create a valid FlatContact', () => {
    const contact: FlatContact = {
      email: 'test@example.com',
      firstName: 'John',
      lastName: 'Doe',
    };
    expect(contact.email).toBe('test@example.com');
  });

  it('should create a valid HubSpotContact', () => {
    const contact: HubSpotContact = {
      id: '123',
      properties: { firstname: 'John', email: 'j@test.com' },
    };
    expect(contact.id).toBe('123');
  });

  it('should create a valid Attribution', () => {
    const attr: Attribution = {
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'test',
      utmTerm: '',
      utmContent: '',
      referrer: 'https://google.com',
      landingPage: '/contact',
    };
    expect(attr.utmSource).toBe('google');
  });

  it('should create a valid SyncResult', () => {
    const result: SyncResult = {
      action: 'create',
      source: 'wix_webhook',
      hubspotContactId: 'hs-123',
      wixContactId: 'wix-456',
    };
    expect(result.action).toBe('create');
  });

  it('should create a valid FieldOption', () => {
    const opt: FieldOption = {
      value: 'email',
      label: 'Email Address',
      type: 'string',
    };
    expect(opt.value).toBe('email');
  });

  it('should create a valid WixFormSubmission', () => {
    const sub: WixFormSubmission = {
      submissionId: 'sub-123',
      formId: 'form-1',
      submissions: { email: 'test@test.com' },
    };
    expect(sub.submissionId).toBe('sub-123');
  });

  it('should create a valid HubSpotWebhookEvent', () => {
    const event: HubSpotWebhookEvent = {
      subscriptionType: 'contact.creation',
      objectId: 123,
      portalId: 456,
    };
    expect(event.subscriptionType).toBe('contact.creation');
  });
});
