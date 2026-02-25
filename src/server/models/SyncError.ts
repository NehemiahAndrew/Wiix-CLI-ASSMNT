// =============================================================================
// SyncError Model — Failed sync operations persisted for retry
// =============================================================================
// When a form submission or contact sync fails to reach HubSpot, the error
// is recorded here instead of being silently lost. A background job or
// manual trigger can retry these later.
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';

export interface ISyncError extends Document {
  instanceId: string;
  /** What kind of operation failed: 'form_submission' | 'contact_sync' */
  type: string;
  /** The ID of the original record (submission ID, contact ID, etc.) */
  referenceId: string;
  /** The email associated with the failed operation (if available) */
  email: string;
  /** The full payload that was being sent, for retry */
  payload: Record<string, unknown>;
  /** The error message */
  error: string;
  /** How many times this has been retried */
  retryCount: number;
  /** When the last retry attempt was made */
  lastRetryAt: Date | null;
  /** Whether this error has been resolved */
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const syncErrorSchema = new Schema<ISyncError>(
  {
    instanceId: { type: String, required: true, index: true },
    type: { type: String, required: true, default: 'form_submission' },
    referenceId: { type: String, required: true },
    email: { type: String, default: '' },
    payload: { type: Schema.Types.Mixed, default: {} },
    error: { type: String, required: true },
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'sync_errors' },
);

// Index for finding unresolved errors to retry
syncErrorSchema.index({ instanceId: 1, resolved: 1, createdAt: -1 });

const SyncError: Model<ISyncError> = mongoose.model<ISyncError>(
  'SyncError',
  syncErrorSchema,
);

export default SyncError;
