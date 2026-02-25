// =============================================================================
// OAuthState Model — Persists CSRF nonces for HubSpot OAuth flow
// =============================================================================
// Stored in MongoDB so the nonce survives server restarts (e.g. Render deploys).
// TTL index auto-deletes entries after 10 minutes.
// =============================================================================
import mongoose, { Schema, Document } from 'mongoose';

export interface IOAuthState extends Document {
  key: string;
  value: string;
  createdAt: Date;
}

const OAuthStateSchema = new Schema<IOAuthState>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 600 }, // TTL: 10 min
  },
  { timestamps: false },
);

export default mongoose.model<IOAuthState>('OAuthState', OAuthStateSchema);
