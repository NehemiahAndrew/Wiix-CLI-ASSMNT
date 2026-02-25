// =============================================================================
// ContactMapping Model — Links a Wix contact ID ↔ HubSpot contact ID
// =============================================================================
// Collection name: HubSpotContactMapping
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IContactMapping extends Document {
  instanceId: string;
  wixContactId: string;
  hubspotContactId: string;
  lastSyncedAt: Date;
  /** Which side triggered the last sync */
  lastSyncSource: 'wix' | 'hubspot' | 'manual';
  /** UUID of the sync operation that created or last updated this link */
  syncOperationId: string;
  /** SHA-256 of the last-synced property set — used for idempotency */
  propertyHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const contactMappingSchema = new Schema<IContactMapping>(
  {
    instanceId: { type: String, required: true, index: true },
    wixContactId: { type: String, required: true },
    hubspotContactId: { type: String, required: true },
    lastSyncedAt: { type: Date, default: Date.now },
    lastSyncSource: {
      type: String,
      enum: ['wix', 'hubspot', 'manual'],
      default: 'manual',
    },
    syncOperationId: { type: String, default: '' },
    propertyHash: { type: String, default: '' },
  },
  { timestamps: true, collection: 'HubSpotContactMapping' },
);

// Compound unique: one mapping per instanceId + either side
contactMappingSchema.index({ instanceId: 1, wixContactId: 1 }, { unique: true });
contactMappingSchema.index({ instanceId: 1, hubspotContactId: 1 }, { unique: true });

const ContactMapping: Model<IContactMapping> = mongoose.model<IContactMapping>(
  'ContactMapping',
  contactMappingSchema,
);
export default ContactMapping;
