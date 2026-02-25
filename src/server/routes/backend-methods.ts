// =============================================================================
// Backend Methods Router — Express adapter for webMethod-wrapped functions
// =============================================================================
// Exposes every webMethod from `backendMethods.ts` as an HTTP endpoint.
// The auth middleware resolves the caller's instanceId, and this router
// enforces that only Admin-level callers (site owners) can invoke methods.
//
// Route structure:
//   POST /api/backend/:method  — invoke a named backend method
//   GET  /api/backend/:method  — for idempotent reads (mapped to same logic)
//
// The router also provides named convenience routes so the existing client
// `api.ts` endpoints continue to work without changes.
// =============================================================================
import { Router, Request, Response } from 'express';
import authMiddleware from '../utils/authMiddleware';
import { Permissions, WebMethodContext } from '../backend/webMethod';
import { toSafeError } from '../utils/sanitizeError';
import logger from '../utils/logger';

// ── Import all backend methods ──
import {
  getOAuthUrl,
  handleOAuthCallback,
  checkConnectionStatus,
  disconnectHubSpot,
  loadFieldMappings,
  saveFieldMappings,
  getAvailableWixFields,
  getAvailableHubSpotProperties,
  getSyncStatusSummary,
  triggerManualSync,
} from '../backend/backendMethods';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Middleware — All routes require auth (resolved by authMiddleware)
// ─────────────────────────────────────────────────────────────────────────────
router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper — build context + enforce Admin permission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the caller context from the Express request.
 * In a self-hosted Wix app, any request that passes authMiddleware
 * is coming from the dashboard (site owner) → Admin.
 */
function resolveContext(req: Request): WebMethodContext {
  return {
    instanceId: req.instanceId!,
    role: Permissions.Admin, // Dashboard calls are always Admin
  };
}

/**
 * Generic handler: verifies Admin permission, extracts args, calls the
 * webMethod, and returns the result or a sanitized error.
 */
async function callMethod(
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  method: { __permission: Permissions; (...args: any[]): any },
  args: unknown[],
): Promise<void> {
  const ctx = resolveContext(req);

  // Permission gate — this matches webMethod.__permission
  if (method.__permission === Permissions.Admin && ctx.role !== Permissions.Admin) {
    res.status(403).json({ error: 'Forbidden: site owner access required' });
    return;
  }

  try {
    const result = await method(...args);
    res.json(result);
  } catch (err) {
    // Error is already sanitized by the webMethod's internal try/catch,
    // but we double-sanitize here just in case of wrapper-level errors.
    const safe = toSafeError(err);
    logger.error('Backend method error', {
      method: method.name || 'unknown',
      error: safe.message,
    });
    res.status(500).json({ error: safe.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named routes — mapped to the backend methods
// ─────────────────────────────────────────────────────────────────────────────

/* ── 1. Get OAuth URL ── */
router.get('/oauth/url', async (req: Request, res: Response) => {
  await callMethod(req, res, getOAuthUrl, [req.instanceId!]);
});

/* ── 2. Handle OAuth Callback ── */
router.post('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state } = req.body;
  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state' });
    return;
  }
  await callMethod(req, res, handleOAuthCallback, [code, state]);
});

/* ── 3. Check Connection Status ── */
router.get('/connection/status', async (req: Request, res: Response) => {
  await callMethod(req, res, checkConnectionStatus, [req.instanceId!]);
});

/* ── 4. Disconnect HubSpot ── */
router.post('/connection/disconnect', async (req: Request, res: Response) => {
  await callMethod(req, res, disconnectHubSpot, [req.instanceId!]);
});

/* ── 5. Load Field Mappings ── */
router.get('/field-mappings', async (req: Request, res: Response) => {
  await callMethod(req, res, loadFieldMappings, [req.instanceId!]);
});

/* ── 6. Save Field Mappings ── */
router.post('/field-mappings', async (req: Request, res: Response) => {
  const { rules } = req.body;
  await callMethod(req, res, saveFieldMappings, [req.instanceId!, rules]);
});

/* ── 7. Get Available Wix Fields ── */
router.get('/wix-fields', async (req: Request, res: Response) => {
  await callMethod(req, res, getAvailableWixFields, []);
});

/* ── 8. Get Available HubSpot Properties ── */
router.get('/hubspot-properties', async (req: Request, res: Response) => {
  await callMethod(req, res, getAvailableHubSpotProperties, [req.instanceId!]);
});

/* ── 9. Get Sync Status Summary ── */
router.get('/sync/status', async (req: Request, res: Response) => {
  await callMethod(req, res, getSyncStatusSummary, [req.instanceId!]);
});

/* ── 10. Trigger Manual Sync ── */
router.post('/sync/trigger', async (req: Request, res: Response) => {
  await callMethod(req, res, triggerManualSync, [req.instanceId!]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Generic method dispatcher (optional — for future extensibility)
// ─────────────────────────────────────────────────────────────────────────────

/** Map of method names to their implementations */
const METHOD_REGISTRY: Record<string, { __permission: Permissions; (...args: any[]): any }> = {
  getOAuthUrl,
  handleOAuthCallback,
  checkConnectionStatus,
  disconnectHubSpot,
  loadFieldMappings,
  saveFieldMappings,
  getAvailableWixFields,
  getAvailableHubSpotProperties,
  getSyncStatusSummary,
  triggerManualSync,
};

/**
 * Generic endpoint — call any backend method by name.
 * POST /api/backend/invoke/:methodName
 * Body: { args: [...] }
 */
router.post('/invoke/:methodName', async (req: Request, res: Response) => {
  const { methodName } = req.params;
  const method = METHOD_REGISTRY[methodName];

  if (!method) {
    res.status(404).json({ error: `Unknown method: ${methodName}` });
    return;
  }

  const args: unknown[] = req.body.args ?? [];
  // Prepend instanceId for methods that need it
  const needsInstance = [
    'getOAuthUrl',
    'checkConnectionStatus',
    'disconnectHubSpot',
    'loadFieldMappings',
    'saveFieldMappings',
    'getAvailableHubSpotProperties',
    'getSyncStatusSummary',
    'triggerManualSync',
  ];
  if (needsInstance.includes(methodName)) {
    args.unshift(req.instanceId!);
  }

  await callMethod(req, res, method, args);
});

export default router;
