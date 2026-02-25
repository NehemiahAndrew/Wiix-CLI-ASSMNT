// =============================================================================
// Installation Model — Each Wix site that installs the app gets one document
// =============================================================================
import mongoose, { Document, Schema, Model } from 'mongoose';
import { encryptTokens, decryptTokens } from '../utils/tokenEncryption';

/* ── Interfaces ── */
export interface IInstallation extends Document {
  instanceId: string;
  refreshToken: string;
  hubspotAccessToken: string;
  hubspotRefreshToken: string;
  hubspotTokenIv: string;
  hubspotPortalId: string;
  hubspotTokenExpiresAt: Date | null;
  connected: boolean;
  syncEnabled: boolean;
  lastSyncAt: Date | null;
  widgetFormId: string;
  createdAt: Date;
  updatedAt: Date;
  /** Virtual getter: decrypts tokens on the fly */
  decryptedHubspotTokens: { accessToken: string; refreshToken: string };
}

/* ── Schema ── */
const installationSchema = new Schema<IInstallation>(
  {
    instanceId: { type: String, required: true, unique: true, index: true },
    refreshToken: { type: String, default: '' }, // Wix refresh token
    hubspotAccessToken: { type: String, default: '' }, // encrypted
    hubspotRefreshToken: { type: String, default: '' }, // encrypted
    hubspotTokenIv: { type: String, default: '' },       // IV for AES-GCM decrypt
    hubspotPortalId: { type: String, default: '' },
    hubspotTokenExpiresAt: { type: Date, default: null },
    connected: { type: Boolean, default: false },
    syncEnabled: { type: Boolean, default: true },
    lastSyncAt: { type: Date, default: null },
    widgetFormId: { type: String, default: '' },
  },
  { timestamps: true },
);

/* ── Pre-save hook: encrypt tokens before writing ── */
installationSchema.pre('save', function (next) {
  if (this.isModified('hubspotAccessToken') && this.hubspotAccessToken && !this.hubspotAccessToken.includes(':')) {
    const encrypted = encryptTokens(this.hubspotAccessToken, this.hubspotRefreshToken);
    this.hubspotAccessToken = encrypted.accessToken;
    this.hubspotRefreshToken = encrypted.refreshToken;
    this.hubspotTokenIv = encrypted.tokenIv;
  }
  next();
});

/* ── Methods ── */
installationSchema.methods.decryptedHubspotTokens = function (): { accessToken: string; refreshToken: string } {
  if (!this.hubspotAccessToken) return { accessToken: '', refreshToken: '' };
  return decryptTokens({
    accessToken: this.hubspotAccessToken,
    refreshToken: this.hubspotRefreshToken,
    tokenIv: this.hubspotTokenIv,
  });
};

const Installation: Model<IInstallation> = mongoose.model<IInstallation>('Installation', installationSchema);
export default Installation;
