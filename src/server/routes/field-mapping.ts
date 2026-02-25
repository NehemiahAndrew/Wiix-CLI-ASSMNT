// =============================================================================
// Field Mapping Routes — CRUD for per-installation field mapping rules
// =============================================================================
import { Router, Request, Response } from 'express';
import FieldMapping, { DEFAULT_FIELD_MAPPINGS } from '../models/FieldMapping';
import { fetchCustomProperties } from '../services/hubspotProperties';
import {
  loadMappingRules,
  saveMappingRules,
  validateRules,
  getWixFieldRegistry,
  seedDefaultMappings,
  invalidateRulesCache,
  isUndeletableDefault,
} from '../services/fieldMappingEngine';
import authMiddleware from '../utils/authMiddleware';
import logger from '../utils/logger';

const router = Router();
router.use(authMiddleware);

/* ── List mappings (uses Module 6 cached loader) ── */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const mappings = await loadMappingRules(req.instanceId!);
    res.json({ mappings });
  } catch (err) {
    logger.error('List field mappings error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch field mappings' });
  }
});

/* ── Create mapping (with Module 6 validation) ── */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { wixField, hubspotField, direction, transform } = req.body;
    if (!wixField || !hubspotField) {
      res.status(400).json({ error: 'wixField and hubspotField are required' });
      return;
    }

    // Module 6 — validate the single rule
    const errors = validateRules(
      [{ wixField, hubspotField, direction: direction || 'bidirectional', transform }],
    );
    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors });
      return;
    }

    const mapping = await FieldMapping.create({
      instanceId: req.instanceId!,
      wixField,
      hubspotField,
      direction: direction || 'bidirectional',
      transform: transform || 'none',
      isDefault: false,
      isActive: true,
    });

    // Invalidate cached rules
    invalidateRulesCache(req.instanceId!);

    res.status(201).json({ mapping });
  } catch (err) {
    if ((err as any).code === 11000) {
      res.status(409).json({ error: 'This field mapping already exists' });
      return;
    }
    logger.error('Create field mapping error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to create mapping' });
  }
});

/* ── Update mapping ── */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { direction, transform, isActive } = req.body;
    const mapping = await FieldMapping.findOneAndUpdate(
      { _id: req.params.id, instanceId: req.instanceId! },
      { direction, transform, isActive },
      { new: true },
    );
    if (!mapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }
    // Invalidate cached rules
    invalidateRulesCache(req.instanceId!);
    res.json({ mapping });
  } catch (err) {
    logger.error('Update field mapping error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to update mapping' });
  }
});

/* ── Delete mapping (blocks undeletable defaults) ── */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    // Look up first to check if it’s an undeletable default
    const existing = await FieldMapping.findOne({
      _id: req.params.id,
      instanceId: req.instanceId!,
    });
    if (!existing) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }
    if (isUndeletableDefault(existing.wixField, existing.hubspotField)) {
      res.status(403).json({
        error: 'This default mapping cannot be deleted. You can only change its direction or transform.',
      });
      return;
    }

    await existing.deleteOne();
    invalidateRulesCache(req.instanceId!);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Delete field mapping error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to delete mapping' });
  }
});

/* ── Reset to defaults ── */
router.post('/reset', async (req: Request, res: Response): Promise<void> => {
  try {
    // Remove all custom (non-default) rules
    await FieldMapping.deleteMany({ instanceId: req.instanceId!, isDefault: false });
    // Ensure the 4 undeletable defaults exist
    await seedDefaultMappings(req.instanceId!);
    invalidateRulesCache(req.instanceId!);
    const mappings = await loadMappingRules(req.instanceId!, true);
    res.json({ mappings, message: 'Reset to defaults' });
  } catch (err) {
    logger.error('Reset field mappings error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to reset mappings' });
  }
});

/* ── List available HubSpot properties (for the dropdown) ── */
router.get('/hubspot-properties', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.installation?.connected) {
      res.status(400).json({ error: 'HubSpot not connected' });
      return;
    }
    const properties = await fetchCustomProperties(req.instanceId!);
    res.json({ properties });
  } catch (err) {
    logger.error('List HubSpot properties error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to fetch HubSpot properties' });
  }
});

/* ── Available Wix contact fields (Module 6 registry) ── */
router.get('/wix-fields', (_req: Request, res: Response): void => {
  res.json({ fields: getWixFieldRegistry() });
});

/* ── Bulk save — validate & replace all custom rules at once ── */
router.post('/bulk', async (req: Request, res: Response): Promise<void> => {
  try {
    const rules: Array<{
      wixField: string;
      hubspotField: string;
      direction: string;
      transform: string;
    }> = req.body.rules;

    if (!Array.isArray(rules)) {
      res.status(400).json({ error: 'rules[] array is required' });
      return;
    }

    // Optionally validate against real HubSpot properties
    let hsPropertyNames: Set<string> | null = null;
    if (req.installation?.connected) {
      const hsProps = await fetchCustomProperties(req.instanceId!);
      hsPropertyNames = new Set(hsProps.map((p) => p.value));
    }

    const result = await saveMappingRules(
      req.instanceId!,
      rules as any,
      hsPropertyNames,
    );

    if (!result.ok) {
      res.status(400).json({ error: 'Validation failed', details: result.errors });
      return;
    }

    res.json({ mappings: result.rules });
  } catch (err) {
    logger.error('Bulk save field mappings error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to save mappings' });
  }
});

export default router;
