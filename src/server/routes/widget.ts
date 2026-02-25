// =============================================================================
// Widget Routes — Module 12: HubSpot Form Embed Widget
// =============================================================================
// Endpoints consumed by the widget iframe and the editor settings panel.
//   GET  /config        — returns portalId + selected formId for the widget
//   POST /form-log      — lightweight observability log when a form is submitted
//   GET  /hubspot-forms — lists available HubSpot forms (for the settings panel)
// =============================================================================
import { Router, Request, Response } from 'express';
import authMiddleware from '../utils/authMiddleware';
import * as hubspotService from '../services/hubspotService';
import logger from '../utils/logger';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /form-log — Log form submission metadata from the widget.
// The actual submission goes directly to HubSpot via the Forms SDK; this
// endpoint is an observability side-channel so we have our own record.
//
// Body: { portalId, formId, pageUrl, referrer, utmParams }
// No auth required — the widget runs on the published site, not the editor.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/form-log', async (req: Request, res: Response): Promise<void> => {
  try {
    const { portalId, formId, pageUrl, referrer, utmParams, instanceId } = req.body;

    if (!formId) {
      res.status(400).json({ error: 'formId is required' });
      return;
    }

    logger.info('Widget form submission logged', {
      instanceId: instanceId || 'unknown',
      portalId: portalId || '',
      formId,
      pageUrl: pageUrl || '',
      referrer: referrer || '',
      utmParams: utmParams || {},
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Widget form-log error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to log form submission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Protected routes (editor-side only)
// ─────────────────────────────────────────────────────────────────────────────
router.use(authMiddleware);

// GET /config — Widget configuration (portalId, selected formId)
router.get('/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const installation = req.installation;
    if (!installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }

    res.json({
      portalId: installation.hubspotPortalId || '',
      formId: installation.widgetFormId || '',
    });
  } catch (err) {
    logger.error('Widget config error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch widget config' });
  }
});

// PUT /config — Save selected formId
router.put('/config', async (req: Request, res: Response): Promise<void> => {
  try {
    const installation = req.installation;
    if (!installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }

    const { formId } = req.body;
    if (!formId) {
      res.status(400).json({ error: 'formId is required' });
      return;
    }

    // Persist the selected formId on the installation record
    installation.widgetFormId = formId;
    await installation.save();

    res.json({ ok: true, formId });
  } catch (err) {
    logger.error('Widget config save error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to save widget config' });
  }
});

// GET /hubspot-forms — List forms from HubSpot Marketing Forms API
router.get('/hubspot-forms', async (req: Request, res: Response): Promise<void> => {
  try {
    const installation = req.installation;
    if (!installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }

    const forms = await hubspotService.listForms(installation);
    res.json({ forms });
  } catch (err) {
    const message = (err as Error).message || '';
    // HubSpot returns 403 if the forms scope is missing
    if (message.includes('403') || message.includes('FORBIDDEN') || message.includes('insufficient')) {
      res.status(403).json({
        error: 'forms_permission_required',
        message:
          'The forms permission is not enabled. Please reconnect HubSpot with the "forms" scope to use this feature.',
      });
      return;
    }
    logger.error('Widget list forms error', { error: message });
    res.status(500).json({ error: 'Failed to fetch HubSpot forms' });
  }
});

export default router;
