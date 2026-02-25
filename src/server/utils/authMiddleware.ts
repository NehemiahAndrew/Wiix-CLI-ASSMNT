// =============================================================================
// Auth Middleware — Validates Wix instance identity on every API request
// =============================================================================
// Every dashboard-facing endpoint MUST use this middleware.
// Tokens and PII are NEVER exposed to the browser.
// =============================================================================
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import Installation from '../models/Installation';
import logger from './logger';

// Extend Express Request to include instance data
declare global {
  namespace Express {
    interface Request {
      instanceId?: string;
      installation?: InstanceType<typeof Installation> | null;
    }
  }
}

/**
 * Decode Wix instance token.
 * Format: base64Signature.base64Payload (signed with app secret HMAC-SHA256)
 */
function decodeWixInstance(instance: string): { instanceId: string } {
  const [signature, payload] = instance.split('.');
  if (!payload) throw new Error('Invalid instance format');

  const expected = crypto
    .createHmac('sha256', config.wixAppSecret)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (expected !== signature) throw new Error('Instance signature mismatch');

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

export default async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token =
      req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
      (req.query.instance as string) ||
      (req.headers['x-wix-instance'] as string);

    if (!token) {
      res.status(401).json({ error: 'Missing authentication token' });
      return;
    }

    let instanceId: string | undefined;

    // Try Wix instance token first
    try {
      const decoded = decodeWixInstance(token);
      instanceId = decoded.instanceId;
    } catch {
      // Fall back to our own JWT
      try {
        const decoded = jwt.verify(token, config.jwtSecret) as { instanceId: string };
        instanceId = decoded.instanceId;
      } catch {
        res.status(401).json({ error: 'Invalid authentication token' });
        return;
      }
    }

    if (!instanceId) {
      res.status(401).json({ error: 'Could not resolve instanceId' });
      return;
    }

    req.instanceId = instanceId;
    req.installation = await Installation.findOne({ instanceId });

    next();
  } catch (err) {
    logger.error('Auth middleware error', { message: (err as Error).message });
    res.status(500).json({ error: 'Authentication failed' });
  }
}
