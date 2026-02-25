// =============================================================================
// Custom type declaration for @wix/contacts
// =============================================================================
// The published @wix/contacts package has an empty .d.ts file (0 bytes).
// This declaration provides the types we actually use in the codebase.
// =============================================================================

declare module '@wix/contacts' {
  /** Contact info structure for create/update operations */
  interface ContactInfo {
    name?: { first?: string; last?: string };
    emails?: Array<{ email: string; tag?: string }>;
    phones?: Array<{ phone: string; tag?: string }>;
    company?: string;
    jobTitle?: string;
    addresses?: Array<{
      address?: string;
      city?: string;
      subdivision?: string;
      postalCode?: string;
      country?: string;
    }>;
    extendedFields?: {
      items?: Record<string, string>;
    };
    [key: string]: unknown;
  }

  /** A Wix contact object as returned by the SDK */
  interface Contact {
    _id?: string;
    info?: ContactInfo;
    primaryEmail?: string;
    primaryPhone?: string;
    createdDate?: string;
    updatedDate?: string;
    [key: string]: unknown;
  }

  /** Response wrapper from contact creation */
  interface CreateContactResponse {
    contact?: Contact;
    _id?: string;
  }

  /** Query builder for contacts */
  interface ContactsQueryBuilder {
    eq(field: string, value: string): ContactsQueryBuilder;
    ne(field: string, value: string): ContactsQueryBuilder;
    limit(n: number): ContactsQueryBuilder;
    skip(n: number): ContactsQueryBuilder;
    ascending(field: string): ContactsQueryBuilder;
    descending(field: string): ContactsQueryBuilder;
    find(): Promise<{ items: Contact[]; _items?: Contact[]; cursors?: { next?: string } }>;
  }

  /** The contacts module namespace used by the Wix SDK */
  interface ContactsModule {
    getContact(contactId: string): Promise<Contact | { contact: Contact }>;
    createContact(input: { info: ContactInfo }): Promise<CreateContactResponse>;
    updateContact(contactId: string, input: { info: ContactInfo }): Promise<Contact>;
    deleteContact(contactId: string): Promise<void>;
    queryContacts(): ContactsQueryBuilder;
  }

  /**
   * The `contacts` export is passed to `createClient({ modules: { contacts } })`
   * and becomes available as `client.contacts`.
   */
  export const contacts: ContactsModule;
}
