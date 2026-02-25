// =============================================================================
// Token Encryption — AES-256-GCM at-rest encryption for OAuth tokens
// =============================================================================
// All HubSpot tokens are encrypted before saving to MongoDB and decrypted
// only in-memory when needed for API calls. Tokens NEVER appear in logs,
// responses, or frontend code.
// =============================================================================
import crypto from 'crypto';
import config from '../config';

const ALGORITHM = 'aes-256-gcm';
const KEY = crypto.createHash('sha256').update(config.jwtSecret).digest(); // 32 bytes

interface EncryptedData {
  encrypted: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): EncryptedData {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decrypt(data: EncryptedData): string {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    KEY,
    Buffer.from(data.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export interface EncryptedTokens {
  accessToken: string;  // "encrypted:tag"
  refreshToken: string; // "encrypted:tag"
  tokenIv: string;      // "accessIv:refreshIv"
}

/** Encrypt access + refresh tokens for safe MongoDB storage. */
export function encryptTokens(accessToken: string, refreshToken: string): EncryptedTokens {
  const access = encrypt(accessToken);
  const refresh = encrypt(refreshToken);
  return {
    accessToken: `${access.encrypted}:${access.tag}`,
    refreshToken: `${refresh.encrypted}:${refresh.tag}`,
    tokenIv: `${access.iv}:${refresh.iv}`,
  };
}

/** Decrypt tokens from an Installation document's hubspot field. */
export function decryptTokens(hubspotDoc: {
  accessToken: string;
  refreshToken: string;
  tokenIv: string;
}): { accessToken: string; refreshToken: string } {
  const [accessEnc, accessTag] = hubspotDoc.accessToken.split(':');
  const [refreshEnc, refreshTag] = hubspotDoc.refreshToken.split(':');
  const [accessIv, refreshIv] = hubspotDoc.tokenIv.split(':');

  return {
    accessToken: decrypt({ encrypted: accessEnc, iv: accessIv, tag: accessTag }),
    refreshToken: decrypt({ encrypted: refreshEnc, iv: refreshIv, tag: refreshTag }),
  };
}
