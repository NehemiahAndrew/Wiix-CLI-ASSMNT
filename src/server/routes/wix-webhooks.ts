// =============================================================================
// Wix Webhook Routes — Receive Wix contact-change events
// =============================================================================
// POST /api/webhooks/wix  — Wix sends contact created/updated/deleted
// =============================================================================
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import config from '../config';
import Installation from '../models/Installation';
import { handleWixWebhook } from '../services/syncOrchestrator';
import { deleteMapping } from '../services/mappingStore';
import { isSyncEcho, extractSyncId } from '../services/dedupeGuard';
import logger from '../utils/logger';

const router = Router();

/** Verify Wix webhook signature (HMAC-SHA256) */
function verifyWixSignature(body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', config.wixWebhookPublicKey || config.wixAppSecret)
    .update(body)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
  // Acknowledge immediately (Wix expects <3 s response)
  res.status(200).json({ ok: true });

  try {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-wix-signature'] as string | undefined;

    // Verify signature in production
    if (config.nodeEnv === 'production' && !verifyWixSignature(rawBody, signature)) {
      logger.warn('Invalid Wix webhook signature');
      return;
    }

    const { data, instanceId, eventType } = req.body as {
      data?: any;
      instanceId?: string;
      eventType?: string;
    };

    if (!instanceId || !eventType) {
      logger.warn('Wix webhook missing instanceId or eventType');
      return;
    }

    const installation = await Installation.findOne({ instanceId });
    if (!installation?.connected || !installation.syncEnabled) {
      logger.debug('Wix webhook ignored (not connected or sync disabled)', { instanceId });
      return;
    }

    const contactData = data?.contact ?? data;
    const contactId: string = contactData?._id ?? contactData?.contactId ?? '';

    if (!contactId) {
      logger.warn('Wix webhook: no contact ID found', { eventType });
      return;
    }

    switch (eventType) {
      case 'wix.contacts.v4.contact_created':
      case 'contact/created': {
        // Module 5 — Dedupe guard: check if this webhook was triggered
        // by our own write to Wix. If so, skip processing.
        const syncIdCreate = extractSyncId(contactData, 'wix');
        if (await isSyncEcho(syncIdCreate)) {
          logger.debug('Wix webhook is our own echo — skipping', {
            instanceId,
            contactId,
            syncId: syncIdCreate?.slice(0, 8),
          });
          break;
        }

        await handleWixWebhook(installation, contactId, contactData, 'created', 'wix_webhook');
        break;
      }

      case 'wix.contacts.v4.contact_updated':
      case 'contact/updated': {
        // Module 5 — Dedupe guard
        const syncIdUpdate = extractSyncId(contactData, 'wix');
        if (await isSyncEcho(syncIdUpdate)) {
          logger.debug('Wix webhook is our own echo — skipping', {
            instanceId,
            contactId,
            syncId: syncIdUpdate?.slice(0, 8),
          });
          break;
        }

        await handleWixWebhook(installation, contactId, contactData, 'updated', 'wix_webhook');
        break;
      }

      case 'wix.contacts.v4.contact_deleted':
      case 'contact/deleted': {
        // Remove mapping via Module 4 mapping store (evicts cache too)
        await deleteMapping(instanceId, contactId);
        logger.info('Wix contact deleted, mapping removed', { instanceId, contactId });
        break;
      }

      default:
        logger.debug('Unhandled Wix eventType', { eventType });
    }
  } catch (err) {
    logger.error('Wix webhook processing error', { error: (err as Error).message });
  }
});

export default router;
