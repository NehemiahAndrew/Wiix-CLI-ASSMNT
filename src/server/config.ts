// =============================================================================
// Application Configuration — Centralised + Validated
// =============================================================================
import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: string;
  baseUrl: string;
  wixAppId: string;
  wixAppSecret: string;
  wixWebhookPublicKey: string;
  hubspotClientId: string;
  hubspotClientSecret: string;
  hubspotRedirectUri: string;
  hubspotScopes: string[];
  mongodbUri: string;
  jwtSecret: string;
  syncDedupeWindowMs: number;
  syncBatchSize: number;
}

const config: AppConfig = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',

  // Wix
  wixAppId: process.env.WIX_APP_ID ?? '',
  wixAppSecret: process.env.WIX_APP_SECRET ?? '',
  wixWebhookPublicKey: process.env.WIX_WEBHOOK_PUBLIC_KEY ?? '',

  // HubSpot
  hubspotClientId: process.env.HUBSPOT_CLIENT_ID ?? '',
  hubspotClientSecret: process.env.HUBSPOT_CLIENT_SECRET ?? '',
  hubspotRedirectUri:
    process.env.HUBSPOT_REDIRECT_URI ?? 'http://localhost:3000/api/hubspot/oauth/callback',

  // Least-privilege scopes for contacts + forms
  hubspotScopes: [
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.schemas.contacts.read',
    'forms',
    'oauth',
  ],

  // MongoDB
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/wix-hubspot-integration',

  // JWT (used for session tokens & token encryption key derivation)
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',

  // Sync engine
  syncDedupeWindowMs: parseInt(process.env.SYNC_DEDUPE_WINDOW_MS ?? '30000', 10),
  syncBatchSize: parseInt(process.env.SYNC_BATCH_SIZE ?? '50', 10),
};

// Validate critical vars at startup
const REQUIRED: Array<keyof AppConfig> = [
  'wixAppId',
  'wixAppSecret',
  'hubspotClientId',
  'hubspotClientSecret',
];

for (const key of REQUIRED) {
  if (!config[key]) {
    const level = config.nodeEnv === 'production' ? 'error' : 'warn';
    console[level](`⚠️  Missing config: ${key}`);
  }
}

export default config;
