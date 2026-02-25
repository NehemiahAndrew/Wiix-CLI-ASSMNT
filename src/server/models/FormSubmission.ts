// =============================================================================
// FormSubmission Model — Captured Wix form submissions + UTM attribution
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';
import { Attribution } from '../types';

export interface IFormSubmission extends Document {
  instanceId: string;
  wixFormId: string;
  wixFormName: string;
  submissionId: string;
  contactEmail: string;
  contactName: string;
  fields: Record<string, string>;
  attribution: Attribution;
  hubspotContactId: string;
  hubspotFormGuid: string;
  syncedToHubspot: boolean;
  syncError: string;
  createdAt: Date;
  updatedAt: Date;
}

const formSubmissionSchema = new Schema<IFormSubmission>(
  {
    instanceId: { type: String, required: true, index: true },
    wixFormId: { type: String, default: '' },
    wixFormName: { type: String, default: '' },
    submissionId: { type: String, required: true, unique: true },
    contactEmail: { type: String, default: '' },
    contactName: { type: String, default: '' },
    fields: { type: Schema.Types.Mixed, default: {} },
    attribution: {
      utmSource: { type: String, default: '' },
      utmMedium: { type: String, default: '' },
      utmCampaign: { type: String, default: '' },
      utmTerm: { type: String, default: '' },
      utmContent: { type: String, default: '' },
      referrer: { type: String, default: '' },
      landingPage: { type: String, default: '' },
    },
    hubspotContactId: { type: String, default: '' },
    hubspotFormGuid: { type: String, default: '' },
    syncedToHubspot: { type: Boolean, default: false },
    syncError: { type: String, default: '' },
  },
  { timestamps: true },
);

formSubmissionSchema.index({ instanceId: 1, createdAt: -1 });

const FormSubmission: Model<IFormSubmission> = mongoose.model<IFormSubmission>(
  'FormSubmission',
  formSubmissionSchema,
);
export default FormSubmission;
