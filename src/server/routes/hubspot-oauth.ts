// =============================================================================
// HubSpot OAuth Routes — delegates to Module 1 (hubspotOAuth + tokenManager)
// =============================================================================
// GET  /api/hubspot/auth         → Redirect user to HubSpot consent screen
// GET  /api/hubspot/callback     → Exchange code for tokens, encrypt & store
// =============================================================================
import { Router, Request, Response } from 'express';
import { getAuthorizationUrl, handleCallback } from '../services/hubspotOAuth';
import { ensureRequiredProperties } from '../services/hubspotProperties';
import { registerWebhookSubscriptions } from '../services/hubspotWebhookRegistration';
import FieldMapping, { DEFAULT_FIELD_MAPPINGS } from '../models/FieldMapping';
import logger from '../utils/logger';
import authMiddleware from '../utils/authMiddleware';

const router = Router();

/* ── Initiate OAuth ── */
router.get('/auth', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    // authMiddleware decodes the ?instance= token and sets req.instanceId
    const instanceId = req.instanceId || (req.query.instanceId as string);
    if (!instanceId) {
      res.status(400).send('Missing instanceId — pass ?instance= token');
      return;
    }
    const url = await getAuthorizationUrl(instanceId);
    res.redirect(url);
  } catch (err) {
    logger.error('Failed to build authorization URL', { error: (err as Error).message });
    res.status(500).send('Failed to start OAuth flow');
  }
});

/* ── OAuth Callback ── */
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  try {
    const { portalId, instanceId } = await handleCallback(code, state);

    // Ensure custom HubSpot properties exist (wix_contact_id, wix_sync_tag, wix_last_sync_at)
    // Fire-and-forget — don't block the user from seeing the success page
    ensureRequiredProperties(instanceId).catch((err) =>
      logger.error('Failed to ensure required properties', {
        instanceId,
        error: (err as Error).message,
      }),
    );

    // Register webhook subscriptions with HubSpot (fire-and-forget)
    // This calls HubSpot's Webhooks API to subscribe to contact creation,
    // property change, and deletion events pointing at our endpoint.
    registerWebhookSubscriptions().catch((err) =>
      logger.error('Failed to register webhook subscriptions', {
        instanceId,
        error: (err as Error).message,
      }),
    );

    // Seed default field mappings if none exist
    const existing = await FieldMapping.countDocuments({ instanceId });
    if (existing === 0) {
      const docs = DEFAULT_FIELD_MAPPINGS.map((m) => ({
        ...m,
        instanceId,
        isDefault: true,
        isActive: true,
      }));
      await FieldMapping.insertMany(docs);
      logger.info('Default field mappings seeded', { instanceId });
    }

    logger.info('HubSpot OAuth complete', { instanceId, portalId });

    // Success page — tells opener to refresh, then closes the popup
    res.send(`
      <html><body>
        <h2>Connected to HubSpot!</h2>
        <p>Portal ID: ${portalId || 'unknown'}</p>
        <p>You can close this window and return to your Wix dashboard.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'HUBSPOT_CONNECTED' }, '*'); window.close(); }
        </script>
      </body></html>
    `);
  } catch (err) {
    logger.error('HubSpot OAuth callback failed', { error: (err as Error).message });
    res.status(500).send('OAuth failed. Please try again.');
  }
});

export default router;
