// =============================================================================
// Module 5-C: Cleanup Scheduler
// =============================================================================
// Runs a periodic job every 10 minutes to:
//
//   1. Delete expired SyncDedupeLog records whose `expiresAt` has passed.
//      (MongoDB's TTL index handles most of this, but TTL deletions can
//       be delayed by up to 60 s on a busy replica set.  This manual
//       sweep guarantees timely cleanup.)
//
//   2. Prune the in-memory LRU cache managed by the deduplication guard.
//
// The scheduler is started once at app boot via `startCleanupScheduler()`
// and can be stopped gracefully with `stopCleanupScheduler()`.
// =============================================================================
import SyncDedupeLog from '../models/SyncDedupeLog';
import { clearMemoryCache } from './dedupeGuard';
import logger from '../utils/logger';

/** Interval handle — used to stop the scheduler on shutdown. */
let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** How often the cleanup job runs (10 minutes). */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Core cleanup function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes all SyncDedupeLog records that have expired.
 *
 * This is idempotent — calling it when no expired records exist is a
 * no-op.  Safe to invoke manually at any time (e.g. from an admin
 * endpoint).
 *
 * @returns — The number of records deleted
 */
export async function cleanupExpiredRecords(): Promise<number> {
  try {
    const result = await SyncDedupeLog.deleteMany({
      expiresAt: { $lte: new Date() },
    });
    const deleted = result.deletedCount ?? 0;

    if (deleted > 0) {
      logger.info('SyncDedupeLog cleanup completed', { deleted });
    }

    return deleted;
  } catch (err) {
    logger.error('SyncDedupeLog cleanup failed', {
      error: (err as Error).message,
    });
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the periodic cleanup scheduler.
 *
 * Call once at app boot (e.g. in `server.ts` after connecting to MongoDB).
 * The first sweep runs immediately, then repeats every 10 minutes.
 *
 * Calling this multiple times is safe — subsequent calls are ignored if
 * the scheduler is already running.
 */
export function startCleanupScheduler(): void {
  if (intervalHandle) {
    logger.debug('Cleanup scheduler already running — skipping start');
    return;
  }

  logger.info('Starting SyncDedupeLog cleanup scheduler (every 10 min)');

  // Run once immediately on startup
  cleanupExpiredRecords().catch(() => {
    /* logged inside */
  });

  intervalHandle = setInterval(async () => {
    await cleanupExpiredRecords();
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is still scheduled
  if (intervalHandle && typeof intervalHandle === 'object' && 'unref' in intervalHandle) {
    intervalHandle.unref();
  }
}

/**
 * Stops the periodic cleanup scheduler.
 *
 * Call during graceful shutdown (e.g. `process.on('SIGTERM', …)`).
 */
export function stopCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('SyncDedupeLog cleanup scheduler stopped');
  }
}

/**
 * Returns `true` if the scheduler is currently running.
 */
export function isSchedulerRunning(): boolean {
  return intervalHandle !== null;
}
