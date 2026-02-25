// =============================================================================
// Token Encryption Tests
// =============================================================================
import { encrypt, decrypt, encryptTokens, decryptTokens } from '../utils/tokenEncryption';

describe('tokenEncryption', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    // Set a valid 32-byte hex key for testing
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  describe('encrypt / decrypt', () => {
    it('should round-trip a simple string', () => {
      const plaintext = 'my-secret-token-12345';
      const cipher = encrypt(plaintext);
      expect(cipher).toHaveProperty('encrypted');
      expect(cipher).toHaveProperty('iv');
      expect(cipher).toHaveProperty('tag');
      expect(decrypt(cipher)).toBe(plaintext);
    });

    it('should produce different ciphertexts for each call (unique IV)', () => {
      const text = 'same-input';
      const a = encrypt(text);
      const b = encrypt(text);
      expect(a).not.toBe(b); // unique IV each time
      expect(decrypt(a)).toBe(text);
      expect(decrypt(b)).toBe(text);
    });

    it('should handle empty strings', () => {
      const cipher = encrypt('');
      expect(decrypt(cipher)).toBe('');
    });

    it('should handle unicode', () => {
      const text = 'token-with-émojis-🔑';
      expect(decrypt(encrypt(text))).toBe(text);
    });
  });

  describe('encryptTokens / decryptTokens', () => {
    it('should encrypt and decrypt an access/refresh token pair', () => {
      const access = 'access-token-abc';
      const refresh = 'refresh-token-xyz';
      const encrypted = encryptTokens(access, refresh);

      expect(encrypted.accessToken).not.toBe(access);
      expect(encrypted.refreshToken).not.toBe(refresh);

      const decrypted = decryptTokens(encrypted);
      expect(decrypted.accessToken).toBe(access);
      expect(decrypted.refreshToken).toBe(refresh);
    });
  });
});
