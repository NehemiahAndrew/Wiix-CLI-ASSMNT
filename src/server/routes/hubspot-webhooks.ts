// =============================================================================
// Module 8 — Inbound HubSpot Webhook Handler
// =============================================================================
// POST /api/webhooks/hubspot
//
// Receives contact-change events from HubSpot, validates the HMAC-SHA256
// signature, parses each event through a Zod schema, and routes valid events
// to the Module 7 sync orchestrator.
//
// Key design decisions:
//   • Signature verification uses `crypto.timingSafeEqual` to prevent timing
//     attacks. The signature value itself is NEVER logged.
//   • Events are validated individually via Zod. Malformed ones are dropped
//     with a warning log — one bad event does not crash the batch.
//   • All valid events are processed concurrently with `Promise.allSettled`
//     so one failure does not block others.
//   • The 200 response is returned BEFORE processing begins. HubSpot expects
//     a fast response and will retry if we are slow.
// =============================================================================

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import config from '../config';
import Installation from '../models/Installation';
import { handleHubSpotWebhook } from '../services/syncOrchestrator';
import { deleteMapping } from '../services/mappingStore';
import { isSyncEcho, extractSyncId } from '../services/dedupeGuard';
import { getContactById } from '../services/hubspotContacts';
import logger from '../utils/logger';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Zod schema — validates a single HubSpot webhook event
// ─────────────────────────────────────────────────────────────────────────────

const HubSpotWebhookEventSchema = z.object({
  subscriptionType: z.string().min(1),
  objectId: z.number({ coerce: true }).int().positive(),
  portalId: z.number({ coerce: true }).int().positive(),
  appId: z.number({ coerce: true }).optional(),
  attemptNumber: z.number().optional(),
  occurredAt: z.number().optional(),
  eventId: z.number().optional(),
  subscriptionId: z.number().optional(),
  propertyName: z.string().optional(),
  propertyValue: z.string().optional(),
  changeSource: z.string().optional(),
  sourceId: z.string().optional(),
});

type ValidatedEvent = z.infer<typeof HubSpotWebhookEventSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// HMAC-SHA256 Signature Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the HubSpot webhook signature.
 *
 * HubSpot v2 signature:
 *   SHA256( clientSecret + rawRequestBody )
 *
 * Uses `crypto.timingSafeEqual` so an attacker cannot infer the expected
 * hash by measuring response times.
 *
 * @returns `true` if the signature is valid, `false` otherwise.
 */
function verifySignature(
  rawBody: Buffer | string,
  signature: string | undefined,
): boolean {
  if (!signature || !config.hubspotClientSecret) return false;

  const sourceString =
    typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  const expected = crypto
    .createHash('sha256')
    .update(config.hubspotClientSecret + sourceString)
    .digest('hex');

  // Both must be the same length for timingSafeEqual
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');

  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties we fetch for every contact involved in a webhook
// ─────────────────────────────────────────────────────────────────────────────

const CONTACT_PROPERTIES: readonly string[] = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'company',
  'jobtitle',
  'wix_sync_tag',
  'hs_lastmodifieddate',
];

// ─────────────────────────────────────────────────────────────────────────────
// Process a single validated event
// ─────────────────────────────────────────────────────────────────────────────

async function processEvent(event: ValidatedEvent): Promise<void> {
  const portalId = String(event.portalId);
  const objectId = String(event.objectId);
  const subscriptionType = event.subscriptionType;

  // Look up installation by HubSpot portal ID
  const installation = await Installation.findOne({ hubspotPortalId: portalId });
  if (!installation?.connected || !installation.syncEnabled) {
    logger.debug('HubSpot webhook ignored (not connected or sync disabled)', {
      portalId,
      objectId,
    });
    return;
  }

  const instanceId = installation.instanceId;

  switch (subscriptionType) {
    // ─── Contact Created ──────────────────────────────────────────────
    case 'contact.creation': {
      const fullContact = await getContactById(instanceId, objectId, [
        ...CONTACT_PROPERTIES,
      ]);

      if (!fullContact) {
        logger.warn('HubSpot webhook: contact not found after creation event', {
          instanceId,
          hubspotContactId: objectId,
        });
        return;
      }

      // Module 5 — Dedupe guard: is this our own echo?
      const syncId = extractSyncId(fullContact, 'hubspot');
      if (await isSyncEcho(syncId)) {
        logger.debug('HubSpot creation webhook is our own echo — skipping', {
          instanceId,
          hubspotContactId: objectId,
          syncId: syncId?.slice(0, 8),
        });
        return;
      }

      await handleHubSpotWebhook(
        installation,
        objectId,
        fullContact.properties,
        'created',
        'hubspot_webhook',
      );
      break;
    }

    // ─── Contact Property Changed ─────────────────────────────────────
    case 'contact.propertyChange': {
      // Skip changes to our own sync tag — those are echoes by definition
      if (event.propertyName === 'wix_sync_tag') {
        logger.debug('Skipping webhook for sync tag property change', {
          instanceId,
          hubspotContactId: objectId,
        });
        return;
      }

      const fullContact = await getContactById(instanceId, objectId, [
        ...CONTACT_PROPERTIES,
      ]);

      if (!fullContact) {
        logger.warn('HubSpot webhook: contact not found after property change', {
          instanceId,
          hubspotContactId: objectId,
        });
        return;
      }

      // Module 5 — Dedupe guard
      const syncId = extractSyncId(fullContact, 'hubspot');
      if (await isSyncEcho(syncId)) {
        logger.debug('HubSpot property-change webhook is our own echo — skipping', {
          instanceId,
          hubspotContactId: objectId,
          syncId: syncId?.slice(0, 8),
        });
        return;
      }

      await handleHubSpotWebhook(
        installation,
        objectId,
        fullContact.properties,
        'updated',
        'hubspot_webhook',
      );
      break;
    }

    // ─── Contact Deleted ──────────────────────────────────────────────
    case 'contact.deletion': {
      await deleteMapping(instanceId, undefined, objectId);
      logger.info('HubSpot contact deleted, mapping removed', {
        instanceId,
        hubspotContactId: objectId,
      });
      break;
    }

    default:
      logger.debug('Unhandled HubSpot subscriptionType', { subscriptionType });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<void> => {
  // ── Step 1: Respond immediately ────────────────────────────────────
  // HubSpot expects a 2xx within a few seconds; processing happens after.
  res.status(200).json({ received: true });

  try {
    // ── Step 2: Verify HMAC-SHA256 signature ─────────────────────────
    const signature = req.headers['x-hubspot-signature'] as string | undefined;
    // Use the raw body buffer stashed by the express.json verify callback
    const rawBody: Buffer | string =
      (req as any).rawBody ?? JSON.stringify(req.body);

    if (!verifySignature(rawBody, signature)) {
      if (config.nodeEnv === 'production') {
        // Log that the request was suspicious, but NEVER log the signature
        logger.warn('Invalid HubSpot webhook signature — request rejected', {
          ip: req.ip,
        });
        return;
      }
      logger.debug(
        'HubSpot webhook signature verification skipped (non-production)',
      );
    }

    // ── Step 3: Parse the array of events ────────────────────────────
    const rawEvents: unknown[] = Array.isArray(req.body)
      ? req.body
      : [req.body];

    // ── Step 4: Validate each event with Zod ─────────────────────────
    const validEvents: ValidatedEvent[] = [];

    for (let i = 0; i < rawEvents.length; i++) {
      const parsed = HubSpotWebhookEventSchema.safeParse(rawEvents[i]);
      if (parsed.success) {
        validEvents.push(parsed.data);
      } else {
        logger.warn('Malformed HubSpot webhook event dropped', {
          index: i,
          errors: parsed.error.issues.map((iss: { path: (string | number)[]; message: string }) => ({
            path: iss.path.join('.'),
            message: iss.message,
          })),
        });
      }
    }

    if (validEvents.length === 0) {
      logger.debug('No valid HubSpot webhook events after Zod validation');
      return;
    }

    // ── Step 5: Process all events concurrently ──────────────────────
    const results = await Promise.allSettled(
      validEvents.map((event) => processEvent(event)),
    );

    // Log any failures (successes are logged inside the orchestrator)
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const event = validEvents[i];
        logger.error('HubSpot webhook event processing failed', {
          subscriptionType: event.subscriptionType,
          objectId: event.objectId,
          portalId: event.portalId,
          error:
            (result.reason as Error)?.message ?? String(result.reason),
        });
      }
    }

    logger.debug('HubSpot webhook batch processed', {
      total: rawEvents.length,
      valid: validEvents.length,
      succeeded: results.filter((r) => r.status === 'fulfilled').length,
      failed: results.filter((r) => r.status === 'rejected').length,
    });
  } catch (err) {
    logger.error('HubSpot webhook top-level error', {
      error: (err as Error).message,
    });
  }
});

export default router;
