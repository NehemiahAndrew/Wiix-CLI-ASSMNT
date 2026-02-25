// =============================================================================
// Sync Routes — Trigger & monitor sync operations
// =============================================================================
import { Router, Request, Response } from 'express';
import authMiddleware from '../utils/authMiddleware';
import { runFullSync } from '../services/syncOrchestrator';
import SyncEvent from '../models/SyncEvent';
import ContactMapping from '../models/ContactMapping';
import { countMappings } from '../services/mappingStore';
import { batchReadContacts } from '../services/hubspotContacts';
import { withRetry } from '../services/hubspotClient';
import logger from '../utils/logger';

const router = Router();
router.use(authMiddleware);

/* ── Trigger full sync ── */
router.post('/full', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }
    const result = await runFullSync(req.installation);
    res.json(result);
  } catch (err) {
    logger.error('Full sync error', { error: (err as Error).message });
    res.status(500).json({ error: 'Sync failed' });
  }
});

/* ── Toggle sync on/off ── */
router.post('/toggle', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.installation) {
      res.status(404).json({ error: 'Installation not found' });
      return;
    }
    req.installation.syncEnabled = !req.installation.syncEnabled;
    await req.installation.save();
    res.json({ syncEnabled: req.installation.syncEnabled });
  } catch (err) {
    logger.error('Toggle sync error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to toggle sync' });
  }
});

/* ── Sync history (paginated) ── */
router.get('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const total = await SyncEvent.countDocuments({ instanceId: req.instanceId! });
    const pages = Math.ceil(total / limit);
    const events = await SyncEvent.find({ instanceId: req.instanceId! })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ events, total, page, pages });
  } catch (err) {
    logger.error('Sync history error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch sync history' });
  }
});

/* ── Sync stats ── */
router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceId = req.instanceId!;
    const [totalMappings, totalEvents, recentEvents] = await Promise.all([
      countMappings(instanceId),
      SyncEvent.countDocuments({ instanceId }),
      SyncEvent.find({ instanceId })
        .sort({ createdAt: -1 })
        .limit(100)
        .select('status action duration createdAt'),
    ]);

    const successCount = recentEvents.filter((e) => e.status === 'success').length;
    const failedCount = recentEvents.filter((e) => e.status === 'failed').length;
    const avgDuration =
      recentEvents.length > 0
        ? Math.round(recentEvents.reduce((sum, e) => sum + e.duration, 0) / recentEvents.length)
        : 0;

    res.json({
      totalMappings,
      totalEvents,
      recentSuccess: successCount,
      recentFailed: failedCount,
      avgDuration,
      syncEnabled: req.installation?.syncEnabled ?? false,
      lastSyncAt: req.installation?.lastSyncAt ?? null,
    });
  } catch (err) {
    logger.error('Sync stats error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch sync stats' });
  }
});

/* ── Preview HubSpot contacts (dev/test helper) ── */
router.get('/hubspot-preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceId = req.instanceId!;
    const result = await withRetry(instanceId, (client) =>
      client.get('/crm/v3/objects/contacts', {
        params: {
          properties: 'firstname,lastname,email,phone,company',
          limit: 20,
        },
      }),
    );
    const contacts = result.data?.results ?? [];
    res.json({ total: result.data?.total ?? contacts.length, contacts });
  } catch (err) {
    logger.error('HubSpot preview error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch HubSpot contacts' });
  }
});

/* ── Synced contacts list — shows mapped contacts from both platforms ── */
router.get('/contacts', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceId = req.instanceId!;
    logger.info('Contacts list requested', { instanceId });
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const search = (req.query.search as string || '').trim().toLowerCase();

    // Get all contact mappings for this instance
    const query: Record<string, any> = { instanceId };
    const total = await ContactMapping.countDocuments(query);
    const pages = Math.ceil(total / limit);
    const mappings = await ContactMapping.find(query)
      .sort({ lastSyncedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    logger.info('Contacts list: mappings found', { instanceId, total, mappingsPage: mappings.length });

    // Fetch HubSpot contact details for all mapped contacts in one batch
    const hubspotIds = mappings.map((m) => m.hubspotContactId).filter(Boolean);
    let hubspotContacts: Record<string, any> = {};
    if (hubspotIds.length > 0 && req.installation?.connected) {
      try {
        const hsResults = await batchReadContacts(
          instanceId,
          hubspotIds,
          ['firstname', 'lastname', 'email', 'phone', 'company'],
        );
        for (const hc of hsResults) {
          hubspotContacts[String(hc.id)] = hc.properties ?? {};
        }
      } catch (err) {
        logger.warn('Failed to batch-read HubSpot contacts for list', {
          error: (err as Error).message,
        });
      }
    }

    // Build the response
    let contacts = mappings.map((m) => {
      const hs = hubspotContacts[m.hubspotContactId] || {};
      return {
        wixContactId: m.wixContactId,
        hubspotContactId: m.hubspotContactId,
        firstName: hs.firstname || '',
        lastName: hs.lastname || '',
        email: hs.email || '',
        phone: hs.phone || '',
        company: hs.company || '',
        lastSyncedAt: m.lastSyncedAt,
        lastSyncSource: m.lastSyncSource,
      };
    });

    // Client-side search filter (on the current page of results)
    if (search) {
      contacts = contacts.filter((c) =>
        [c.firstName, c.lastName, c.email, c.company]
          .join(' ')
          .toLowerCase()
          .includes(search),
      );
    }

    res.json({ contacts, total, page, pages });
  } catch (err) {
    logger.error('Contacts list error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

export default router;
