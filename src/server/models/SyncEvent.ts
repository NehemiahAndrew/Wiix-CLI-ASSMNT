// =============================================================================
// SyncEvent Model — Immutable audit log of every sync operation
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';
import { SyncSource, SyncAction } from '../types';

export interface ISyncEvent extends Document {
  instanceId: string;
  source: SyncSource;
  action: SyncAction;
  wixContactId: string;
  hubspotContactId: string;
  status: 'success' | 'failed' | 'skipped';
  error: string;
  details: Record<string, unknown>;
  duration: number; // ms
  createdAt: Date;
}

const syncEventSchema = new Schema<ISyncEvent>(
  {
    instanceId: { type: String, required: true, index: true },
    source: {
      type: String,
      enum: ['wix_webhook', 'hubspot_webhook', 'manual', 'initial_sync'] satisfies SyncSource[],
      required: true,
    },
    action: {
      type: String,
      enum: ['create', 'update', 'delete', 'skip'] satisfies SyncAction[],
      required: true,
    },
    wixContactId: { type: String, default: '' },
    hubspotContactId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['success', 'failed', 'skipped'],
      default: 'success',
    },
    error: { type: String, default: '' },
    details: { type: Schema.Types.Mixed, default: {} },
    duration: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// TTL index: auto-delete after 90 days
syncEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
syncEventSchema.index({ instanceId: 1, createdAt: -1 });

const SyncEvent: Model<ISyncEvent> = mongoose.model<ISyncEvent>('SyncEvent', syncEventSchema);
export default SyncEvent;
