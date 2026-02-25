// =============================================================================
// ContactHashCache Model — Stores SHA-256 hashes for idempotency checking
// =============================================================================
// Before writing mapped fields to a contact on either side, we compute a
// SHA-256 hash of the normalised field values.  If the hash matches the
// stored value in this collection, the write is skipped because nothing
// has actually changed.  This is the second layer of loop prevention.
//
// Keyed by (instanceId, contactId, side) — one hash per contact per side.
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IContactHashCache extends Document {
  /** Wix site instance */
  instanceId: string;

  /** Contact ID on whichever side we last hashed */
  contactId: string;

  /** Which side this hash applies to: 'wix' or 'hubspot' */
  side: 'wix' | 'hubspot';

  /** SHA-256 hex of the normalised mapped field values */
  hash: string;

  updatedAt: Date;
  createdAt: Date;
}

const contactHashCacheSchema = new Schema<IContactHashCache>(
  {
    instanceId: { type: String, required: true },
    contactId: { type: String, required: true },
    side: { type: String, enum: ['wix', 'hubspot'], required: true },
    hash: { type: String, required: true },
  },
  { timestamps: true, collection: 'ContactHashCache' },
);

// Unique compound index — one hash per contact per side per instance
contactHashCacheSchema.index(
  { instanceId: 1, contactId: 1, side: 1 },
  { unique: true },
);

// TTL index — auto-expire stale entries after 30 days of no update
contactHashCacheSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

const ContactHashCache: Model<IContactHashCache> = mongoose.model<IContactHashCache>(
  'ContactHashCache',
  contactHashCacheSchema,
);

export default ContactHashCache;
