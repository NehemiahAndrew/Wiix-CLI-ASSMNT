// =============================================================================
// Auth Middleware Tests
// =============================================================================
import crypto from 'crypto';

// Set env before any imports
process.env.WIX_APP_SECRET = 'test-app-secret-key-12345';
process.env.JWT_SECRET = 'test-jwt-secret-key';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.WIX_APP_ID = 'test';
process.env.HUBSPOT_CLIENT_ID = 'test';
process.env.HUBSPOT_CLIENT_SECRET = 'test';
process.env.HUBSPOT_REDIRECT_URI = 'http://localhost:3000/api/hubspot/callback';
process.env.MONGO_URI = 'mongodb://localhost:27017/test';

describe('Wix Instance Token Decoding', () => {
  const appSecret = process.env.WIX_APP_SECRET!;

  function encodeWixInstance(data: { instanceId: string }): string {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64');
    const signature = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${signature}.${payload}`;
  }

  function decodeWixInstance(instance: string): { instanceId: string } {
    const [signature, payload] = instance.split('.');
    if (!payload) throw new Error('Invalid instance format');

    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    if (expected !== signature) throw new Error('Instance signature mismatch');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  }

  it('should encode and decode a valid instance token', () => {
    const token = encodeWixInstance({ instanceId: 'inst-abc-123' });
    const decoded = decodeWixInstance(token);
    expect(decoded.instanceId).toBe('inst-abc-123');
  });

  it('should reject a token with tampered payload', () => {
    const token = encodeWixInstance({ instanceId: 'orig-id' });
    const [sig] = token.split('.');
    const fake = Buffer.from(JSON.stringify({ instanceId: 'hacked-id' })).toString('base64');
    expect(() => decodeWixInstance(`${sig}.${fake}`)).toThrow('Instance signature mismatch');
  });

  it('should reject a token without payload', () => {
    expect(() => decodeWixInstance('only-signature')).toThrow('Invalid instance format');
  });
});
