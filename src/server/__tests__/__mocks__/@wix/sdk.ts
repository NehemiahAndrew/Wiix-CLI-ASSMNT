// Mock for @wix/sdk
export const createClient = jest.fn().mockReturnValue({
  contacts: {
    createContact: jest.fn().mockResolvedValue({ contact: { _id: 'wix-new-123' } }),
    updateContact: jest.fn().mockResolvedValue({}),
    queryContacts: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue({ items: [], cursors: {} }),
    }),
  },
});

export const OAuthStrategy = jest.fn().mockReturnValue({});
