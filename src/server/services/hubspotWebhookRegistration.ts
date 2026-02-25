// =============================================================================
// Module 8-B — HubSpot Webhook Subscription Registration
// =============================================================================
// Registers our endpoint with HubSpot's Webhooks API so we receive
// contact-change events. Called once when the user first connects their
// HubSpot portal.
//
// Subscriptions created:
//   1. contact.creation       — a new contact was created
//   2. contact.propertyChange — any contact property was modified
//   3. contact.deletion       — a contact was deleted (for mapping cleanup)
//
// HubSpot Webhooks API docs:
//   https://developers.hubspot.com/docs/api/webhooks
//
// The target URL is derived from `config.baseUrl` + `/api/webhooks/hubspot`.
// =============================================================================

import axios, { AxiosError } from 'axios';
import config from '../config';
import logger from '../utils/logger';

/* ── Constants ── */
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/** The webhook subscriptions we need to create */
const REQUIRED_SUBSCRIPTIONS: SubscriptionInput[] = [
  {
    subscriptionType: 'contact.creation',
    propertyName: undefined,
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'email',
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'firstname',
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'lastname',
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'phone',
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'company',
  },
  {
    subscriptionType: 'contact.propertyChange',
    propertyName: 'jobtitle',
  },
  {
    subscriptionType: 'contact.deletion',
    propertyName: undefined,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SubscriptionInput {
  subscriptionType: string;
  propertyName: string | undefined;
}

/** Shape returned by HubSpot for an existing subscription */
interface HubSpotSubscription {
  id: string;
  subscriptionType: string;
  propertyName?: string;
  active: boolean;
  enabled: boolean;
}

export interface RegistrationResult {
  created: number;
  alreadyExisted: number;
  failed: number;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the HubSpot webhook settings URL.
 *
 * HubSpot associates webhook subscriptions with an **app**, not a portal.
 * The app ID is embedded in the developer API key or can be retrieved
 * from the HubSpot developer account. We require it as an env variable
 * (`HUBSPOT_APP_ID`).
 */
function getAppId(): string {
  const appId = process.env.HUBSPOT_APP_ID ?? '';
  if (!appId) {
    throw new Error(
      'HUBSPOT_APP_ID env variable is required for webhook registration',
    );
  }
  return appId;
}

/**
 * Build an authenticated Axios instance using the HubSpot developer
 * API key (hapikey) for webhook management endpoints.
 *
 * Note: Webhook subscription endpoints use the developer API key, NOT
 * the OAuth access token. The developer key comes from the HubSpot
 * developer account that owns the app.
 */
function buildDevClient() {
  const devApiKey = process.env.HUBSPOT_DEVELOPER_API_KEY ?? '';
  if (!devApiKey) {
    throw new Error(
      'HUBSPOT_DEVELOPER_API_KEY env variable is required for webhook registration',
    );
  }

  return axios.create({
    baseURL: HUBSPOT_API_BASE,
    timeout: 15_000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${devApiKey}`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Configure the webhook target URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets the target URL for all webhook subscriptions on this app.
 *
 * HubSpot requires this to be configured at the app level before
 * individual subscriptions can be created.
 *
 * PUT /webhooks/v3/{appId}/settings
 */
export async function configureWebhookTargetUrl(): Promise<void> {
  const appId = getAppId();
  const client = buildDevClient();
  const targetUrl = `${config.baseUrl}/api/webhooks/hubspot`;

  try {
    await client.put(`/webhooks/v3/${appId}/settings`, {
      targetUrl,
      throttling: {
        period: 'SECONDLY',
        maxConcurrentRequests: 10,
      },
    });

    logger.info('HubSpot webhook target URL configured', { targetUrl });
  } catch (err) {
    const axErr = err as AxiosError;
    const msg = axErr.response?.data
      ? JSON.stringify(axErr.response.data).slice(0, 500)
      : axErr.message;
    logger.error('Failed to configure HubSpot webhook target URL', {
      error: msg,
    });
    throw new Error(`Failed to configure webhook target URL: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. List existing subscriptions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all existing webhook subscriptions for this app.
 *
 * GET /webhooks/v3/{appId}/subscriptions
 */
async function listExistingSubscriptions(): Promise<HubSpotSubscription[]> {
  const appId = getAppId();
  const client = buildDevClient();

  try {
    const res = await client.get(`/webhooks/v3/${appId}/subscriptions`);
    return (res.data?.results ?? []) as HubSpotSubscription[];
  } catch (err) {
    const axErr = err as AxiosError;
    // 404 means no subscriptions configured yet — that's fine
    if (axErr.response?.status === 404) return [];
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Create a single subscription
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a single webhook subscription.
 *
 * POST /webhooks/v3/{appId}/subscriptions
 */
async function createSubscription(
  input: SubscriptionInput,
): Promise<void> {
  const appId = getAppId();
  const client = buildDevClient();

  const body: Record<string, unknown> = {
    eventType: input.subscriptionType,
    active: true,
  };
  if (input.propertyName) {
    body.propertyName = input.propertyName;
  }

  await client.post(`/webhooks/v3/${appId}/subscriptions`, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Register all required subscriptions (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures all required webhook subscriptions are registered with HubSpot.
 *
 * This is **idempotent** — it checks which subscriptions already exist and
 * only creates the missing ones. Safe to call multiple times.
 *
 * Steps:
 *   1. Configure the webhook target URL (PUT settings).
 *   2. List all existing subscriptions.
 *   3. For each required subscription, check if it already exists.
 *   4. Create any that are missing.
 *
 * @returns Summary of what happened (created / already existed / failed).
 */
export async function registerWebhookSubscriptions(): Promise<RegistrationResult> {
  const result: RegistrationResult = {
    created: 0,
    alreadyExisted: 0,
    failed: 0,
    errors: [],
  };

  try {
    // Step 1 — Set the target URL
    await configureWebhookTargetUrl();

    // Step 2 — Get existing subscriptions
    const existing = await listExistingSubscriptions();

    // Build a lookup set for quick membership tests
    const existingKeys = new Set(
      existing.map((sub) => subscriptionKey(sub.subscriptionType, sub.propertyName)),
    );

    // Step 3 — Create each missing subscription
    for (const sub of REQUIRED_SUBSCRIPTIONS) {
      const key = subscriptionKey(sub.subscriptionType, sub.propertyName);

      if (existingKeys.has(key)) {
        result.alreadyExisted++;
        logger.debug('Webhook subscription already exists', {
          subscriptionType: sub.subscriptionType,
          propertyName: sub.propertyName ?? '(none)',
        });
        continue;
      }

      try {
        await createSubscription(sub);
        result.created++;
        logger.info('Webhook subscription created', {
          subscriptionType: sub.subscriptionType,
          propertyName: sub.propertyName ?? '(none)',
        });
      } catch (err) {
        result.failed++;
        const msg = (err as Error).message;
        result.errors.push(
          `${sub.subscriptionType}${sub.propertyName ? `:${sub.propertyName}` : ''} — ${msg}`,
        );
        logger.error('Failed to create webhook subscription', {
          subscriptionType: sub.subscriptionType,
          propertyName: sub.propertyName ?? '(none)',
          error: msg,
        });
      }
    }
  } catch (err) {
    // Top-level failure (e.g. target URL config failed)
    const msg = (err as Error).message;
    result.failed = REQUIRED_SUBSCRIPTIONS.length;
    result.errors.push(msg);
    logger.error('Webhook registration failed at setup stage', { error: msg });
  }

  logger.info('Webhook registration complete', {
    created: result.created,
    alreadyExisted: result.alreadyExisted,
    failed: result.failed,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — build a canonical key for comparing subscriptions
// ─────────────────────────────────────────────────────────────────────────────

function subscriptionKey(
  subscriptionType: string,
  propertyName?: string,
): string {
  return propertyName
    ? `${subscriptionType}::${propertyName}`
    : subscriptionType;
}
