// =============================================================================
// Forms Routes — Form submissions dashboard & HubSpot form mapping
// =============================================================================
import { Router, Request, Response } from 'express';
import authMiddleware from '../utils/authMiddleware';
import { processFormSubmission, getFormSubmissions } from '../services/formCaptureService';
import { handleFormSubmission } from '../services/formHandler';
import FormSubmission from '../models/FormSubmission';
import * as hubspotService from '../services/hubspotService';
import logger from '../utils/logger';
import { WixFormSubmission } from '../types';

const router = Router();

/* ── Wix form-submission webhook (no auth — verified by signature) ── */
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  res.status(200).json({ ok: true });

  try {
    const { data, instanceId } = req.body as {
      data?: WixFormSubmission;
      instanceId?: string;
    };

    if (!data || !instanceId) return;

    const Installation = (await import('../models/Installation')).default;
    const installation = await Installation.findOne({ instanceId });
    if (!installation?.connected) return;

    // Module 3 form handler: extract email, build HS props, upsert contact
    await handleFormSubmission(installation, data);

    // Legacy form capture service: persists locally + submits HS form if mapped
    await processFormSubmission(installation, data);
  } catch (err) {
    logger.error('Form webhook error', { error: (err as Error).message });
  }
});

/* ── Protected routes ── */
router.use(authMiddleware);

/* ── List form submissions ── */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await getFormSubmissions(req.instanceId!, page, limit);
    res.json(result);
  } catch (err) {
    logger.error('List form submissions error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

/* ── Map a Wix form to a HubSpot form ── */
router.post('/map', async (req: Request, res: Response): Promise<void> => {
  try {
    const { wixFormId, hubspotFormGuid } = req.body;
    if (!wixFormId || !hubspotFormGuid) {
      res.status(400).json({ error: 'wixFormId and hubspotFormGuid are required' });
      return;
    }

    await FormSubmission.updateMany(
      { instanceId: req.instanceId!, wixFormId },
      { hubspotFormGuid },
    );

    res.json({ ok: true, wixFormId, hubspotFormGuid });
  } catch (err) {
    logger.error('Form map error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to map form' });
  }
});

/* ── List HubSpot forms (for dropdown in UI) ── */
router.get('/hubspot-forms', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }
    const forms = await hubspotService.listForms(req.installation);
    res.json({ forms });
  } catch (err) {
    logger.error('List HubSpot forms error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch HubSpot forms' });
  }
});

/* ── Retry a failed submission ── */
router.post('/:id/retry', async (req: Request, res: Response): Promise<void> => {
  try {
    const submission = await FormSubmission.findOne({
      _id: req.params.id,
      instanceId: req.instanceId!,
    });
    if (!submission) {
      res.status(404).json({ error: 'Submission not found' });
      return;
    }
    if (!req.installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }

    const result = await processFormSubmission(req.installation, {
      submissionId: submission.submissionId,
      formId: submission.wixFormId,
      formName: submission.wixFormName,
      submissions: submission.fields,
      contactId: '',
      extendedFields: {
        utm_source: submission.attribution.utmSource,
        utm_medium: submission.attribution.utmMedium,
        utm_campaign: submission.attribution.utmCampaign,
        utm_term: submission.attribution.utmTerm,
        utm_content: submission.attribution.utmContent,
        referrer: submission.attribution.referrer,
        landing_page: submission.attribution.landingPage,
      },
    });

    res.json({ ok: true, syncedToHubspot: result.syncedToHubspot });
  } catch (err) {
    logger.error('Form retry error', { error: (err as Error).message });
    res.status(500).json({ error: 'Retry failed' });
  }
});

export default router;
