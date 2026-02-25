// =============================================================================
// Connection Routes — delegates to Module 1 (tokenManager + hubspotOAuth)
// =============================================================================
import { Router, Request, Response } from 'express';
import authMiddleware from '../utils/authMiddleware';
import { getConnectionStatus } from '../services/tokenManager';
import { disconnect } from '../services/hubspotOAuth';
import logger from '../utils/logger';

const router = Router();
router.use(authMiddleware);

/* ── Connection status (NEVER exposes tokens) ── */
router.get('/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceId = req.instanceId!;
    const status = await getConnectionStatus(instanceId);
    res.json(status);
  } catch (err) {
    logger.error('Connection status error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to check status' });
  }
});

/* ── Disconnect HubSpot ── */
router.post('/disconnect', async (req: Request, res: Response): Promise<void> => {
  try {
    const instanceId = req.instanceId!;
    await disconnect(instanceId);
    res.json({ ok: true, connected: false });
  } catch (err) {
    logger.error('Disconnect error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

export default router;
