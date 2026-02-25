// =============================================================================
// SyncDedupeLog Model — Tracks sync-operation UUIDs for loop prevention
// =============================================================================
// Every time we write a contact to Wix or HubSpot we generate a UUID
// ("sync ID") and persist it here.  When an incoming webhook arrives we
// check if its sync ID matches one in this log.  A match means the
// webhook was caused by our own write — so we skip it.
//
// Records expire after 5 minutes (TTL index).  A cleanup scheduler also
// sweeps expired entries every 10 minutes.
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';

export interface ISyncDedupeLog extends Document {
  /** UUID of the sync operation */
  syncId: string;

  /** Wix site instance that owns this sync */
  instanceId: string;

  /** Which side we wrote to: 'wix' or 'hubspot' */
  side: 'wix' | 'hubspot';

  /** The contact ID on the written side */
  contactId: string;

  /** When this entry should be considered expired */
  expiresAt: Date;

  createdAt: Date;
}

const syncDedupeLogSchema = new Schema<ISyncDedupeLog>(
  {
    syncId: { type: String, required: true, index: true, unique: true },
    instanceId: { type: String, required: true },
    side: { type: String, enum: ['wix', 'hubspot'], required: true },
    contactId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'SyncDedupeLog' },
);

// TTL index — MongoDB automatically deletes documents once `expiresAt` passes
syncDedupeLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for fast lookups during cleanup
syncDedupeLogSchema.index({ instanceId: 1, side: 1 });

const SyncDedupeLog: Model<ISyncDedupeLog> = mongoose.model<ISyncDedupeLog>(
  'SyncDedupeLog',
  syncDedupeLogSchema,
);

export default SyncDedupeLog;
