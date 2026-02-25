// =============================================================================
// FieldMapping Model — Configurable mapping rules per installation
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';
import { FieldTransform, SyncDirection } from '../types';

export interface IFieldMapping extends Document {
  instanceId: string;
  wixField: string;
  hubspotField: string;
  direction: SyncDirection;
  transform: FieldTransform;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const fieldMappingSchema = new Schema<IFieldMapping>(
  {
    instanceId: { type: String, required: true, index: true },
    wixField: { type: String, required: true },
    hubspotField: { type: String, required: true },
    direction: {
      type: String,
      enum: ['bidirectional', 'wix_to_hubspot', 'hubspot_to_wix'] satisfies SyncDirection[],
      default: 'bidirectional' as SyncDirection,
    },
    transform: {
      type: String,
      enum: ['none', 'lowercase', 'uppercase', 'trim', 'phone_e164'] satisfies FieldTransform[],
      default: 'none' as FieldTransform,
    },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

fieldMappingSchema.index({ instanceId: 1, wixField: 1, hubspotField: 1 }, { unique: true });

const FieldMapping: Model<IFieldMapping> = mongoose.model<IFieldMapping>('FieldMapping', fieldMappingSchema);
export default FieldMapping;

/* ── Default mappings seeded on first install ── */
export const DEFAULT_FIELD_MAPPINGS: Array<{
  wixField: string;
  hubspotField: string;
  direction: SyncDirection;
  transform: FieldTransform;
}> = [
  { wixField: 'firstName', hubspotField: 'firstname', direction: 'bidirectional', transform: 'none' },
  { wixField: 'lastName', hubspotField: 'lastname', direction: 'bidirectional', transform: 'none' },
  { wixField: 'primaryEmail', hubspotField: 'email', direction: 'bidirectional', transform: 'lowercase' },
  { wixField: 'primaryPhone', hubspotField: 'phone', direction: 'bidirectional', transform: 'phone_e164' },
  { wixField: 'company', hubspotField: 'company', direction: 'bidirectional', transform: 'none' },
  { wixField: 'jobTitle', hubspotField: 'jobtitle', direction: 'bidirectional', transform: 'none' },
  { wixField: 'birthdate', hubspotField: 'date_of_birth', direction: 'wix_to_hubspot', transform: 'none' },
  { wixField: 'addresses', hubspotField: 'address', direction: 'wix_to_hubspot', transform: 'none' },
];
