// =============================================================================
// Module 3-B: Form Submission Handler
// =============================================================================
// Receives a Wix form submission and forwards it to HubSpot via the
// Module 2 contacts wrapper.
//
// Flow:
//   1. Extract the submitter's email (checking many common field names).
//      If no email → log a warning and stop.
//   2. Build HubSpot contact properties: name, phone, UTM params,
//      page URL, referrer, form ID (conversion event), timestamp.
//   3. Call `createOrUpdateByEmail` from Module 2-B (hubspotContacts).
//   4. On failure → persist the error to a `sync_errors` MongoDB collection
//      so it can be retried later, never silently lost.
//
// Also exports `parseUtmParams` from the UTM helper for convenience.
// =============================================================================
import crypto from 'crypto';
import { IInstallation } from '../models/Installation';
import { createOrUpdateByEmail } from './hubspotContacts';
import { writeSyncTag } from './hubspotContacts';
import SyncError from '../models/SyncError';
import logger from '../utils/logger';
import { parseUtmParams, UtmParams } from '../utils/utmParser';
import { WixFormSubmission } from '../types';

// Re-export for convenience
export { parseUtmParams } from '../utils/utmParser';

// ─────────────────────────────────────────────────────────────────────────────
// Email extraction — checks many common field-name variations
// ─────────────────────────────────────────────────────────────────────────────

/** All the field name variations we check, in priority order */
const EMAIL_FIELD_NAMES = [
  'email',
  'Email',
  'EMAIL',
  'e-mail',
  'E-mail',
  'E-Mail',
  'emailAddress',
  'email_address',
  'EmailAddress',
  'email-address',
  'contactEmail',
  'contact_email',
  'work_email',
  'workEmail',
  'personal_email',
  'personalEmail',
];

/**
 * Extracts the submitter's email from form fields.
 * Tries many common field-name variations and returns the first non-empty match.
 */
function extractEmail(fields: Record<string, string>): string {
  for (const key of EMAIL_FIELD_NAMES) {
    const val = fields[key];
    if (val && val.trim().length > 0) {
      return val.trim().toLowerCase();
    }
  }

  // Last resort: look for any key containing "email" (case-insensitive)
  for (const [key, val] of Object.entries(fields)) {
    if (key.toLowerCase().includes('email') && val && val.trim().length > 0) {
      return val.trim().toLowerCase();
    }
  }

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Field extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract first name from common field-name variations */
function extractFirstName(fields: Record<string, string>): string {
  return (
    fields.firstName ||
    fields.first_name ||
    fields['First Name'] ||
    fields.firstname ||
    fields.FirstName ||
    fields.FIRST_NAME ||
    ''
  ).trim();
}

/** Extract last name from common field-name variations */
function extractLastName(fields: Record<string, string>): string {
  return (
    fields.lastName ||
    fields.last_name ||
    fields['Last Name'] ||
    fields.lastname ||
    fields.LastName ||
    fields.LAST_NAME ||
    ''
  ).trim();
}

/** Extract phone from common field-name variations */
function extractPhone(fields: Record<string, string>): string {
  return (
    fields.phone ||
    fields.Phone ||
    fields.PHONE ||
    fields.phoneNumber ||
    fields.phone_number ||
    fields['Phone Number'] ||
    fields.telephone ||
    fields.tel ||
    fields.mobile ||
    ''
  ).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a Wix form submission and sends it to HubSpot.
 *
 * Steps:
 *   1. Flatten submission fields into a key-value map.
 *   2. Extract email — if none found, log a warning and return early.
 *   3. Build HubSpot contact properties from form fields + UTM params.
 *   4. Call `createOrUpdateByEmail` to upsert the HubSpot contact.
 *   5. Write a sync tag to prevent loop echoes.
 *
 * If any step fails, the error is written to the `sync_errors` collection
 * so it can be retried later.
 *
 * @param installation — The Wix site installation
 * @param submission   — The raw Wix form submission event data
 * @returns            — The HubSpot contact ID if successful, or `null`
 */
export async function handleFormSubmission(
  installation: IInstallation,
  submission: WixFormSubmission,
): Promise<string | null> {
  const instanceId = installation.instanceId;

  // ── 1. Flatten fields ─────────────────────────────────────────────────
  const fields: Record<string, string> = {};
  const rawFields = submission.submissions ?? submission.fields ?? {};
  for (const [key, val] of Object.entries(rawFields)) {
    fields[key] = typeof val === 'string' ? val : JSON.stringify(val);
  }

  // ── 2. Extract email — stop if missing ────────────────────────────────
  const email = extractEmail(fields);

  if (!email) {
    logger.warn('Form submission has no email — skipping HubSpot sync', {
      instanceId,
      submissionId: submission.submissionId,
      formId: submission.formId ?? 'unknown',
      availableFields: Object.keys(fields).join(', '),
    });
    return null;
  }

  // ── 3. Build HubSpot contact properties ───────────────────────────────
  const firstName = extractFirstName(fields);
  const lastName = extractLastName(fields);
  const phone = extractPhone(fields);

  // Parse UTM params from the landing page URL (if present)
  const landingPage =
    submission.extendedFields?.landing_page ??
    fields.landing_page ??
    fields.landingPage ??
    '';
  const utmParams: UtmParams = parseUtmParams(landingPage);

  // Also check for UTMs directly in the extended fields (Wix sometimes exposes them)
  const ext = submission.extendedFields ?? {};
  const utmDirect: UtmParams = {
    ...(ext.utm_source ? { utm_source: ext.utm_source } : {}),
    ...(ext.utm_medium ? { utm_medium: ext.utm_medium } : {}),
    ...(ext.utm_campaign ? { utm_campaign: ext.utm_campaign } : {}),
    ...(ext.utm_term ? { utm_term: ext.utm_term } : {}),
    ...(ext.utm_content ? { utm_content: ext.utm_content } : {}),
  };

  // Merge: direct fields take precedence over URL-parsed
  const finalUtm: UtmParams = { ...utmParams, ...utmDirect };

  const hubspotProperties: Record<string, string> = {
    email,
    ...(firstName ? { firstname: firstName } : {}),
    ...(lastName ? { lastname: lastName } : {}),
    ...(phone ? { phone } : {}),
    // UTM tracking
    ...(finalUtm.utm_source ? { utm_source: finalUtm.utm_source } : {}),
    ...(finalUtm.utm_medium ? { utm_medium: finalUtm.utm_medium } : {}),
    ...(finalUtm.utm_campaign ? { utm_campaign: finalUtm.utm_campaign } : {}),
    ...(finalUtm.utm_term ? { utm_term: finalUtm.utm_term } : {}),
    ...(finalUtm.utm_content ? { utm_content: finalUtm.utm_content } : {}),
    // Page & referrer
    ...(landingPage ? { hs_analytics_first_url: landingPage } : {}),
    ...(ext.referrer ? { hs_analytics_first_referrer: ext.referrer } : {}),
    // Conversion event = form ID
    ...(submission.formId
      ? { recent_conversion_event_name: submission.formId }
      : {}),
    // Submission timestamp (ISO-8601 → HubSpot epoch ms)
    recent_conversion_date: String(Date.now()),
    // Company & job title from form if available
    ...(fields.company || fields.Company
      ? { company: fields.company || fields.Company }
      : {}),
    ...(fields.jobTitle || fields.job_title
      ? { jobtitle: fields.jobTitle || fields.job_title }
      : {}),
  };

  // ── 4. Upsert HubSpot contact ────────────────────────────────────────
  try {
    const { contact, action } = await createOrUpdateByEmail(
      instanceId,
      email,
      hubspotProperties,
    );

    logger.info('Form submission synced to HubSpot', {
      instanceId,
      submissionId: submission.submissionId,
      hubspotContactId: contact.id,
      action,
    });

    // ── 5. Write sync tag for loop prevention ───────────────────────────
    const syncTagId = crypto.randomUUID();
    writeSyncTag(instanceId, contact.id, syncTagId).catch((err) =>
      logger.warn('Failed to write form-submission sync tag', {
        instanceId,
        hubspotContactId: contact.id,
        error: (err as Error).message,
      }),
    );

    return contact.id;
  } catch (err) {
    const errorMsg = (err as Error).message;

    logger.error('Form submission HubSpot sync failed', {
      instanceId,
      submissionId: submission.submissionId,
      email,
      error: errorMsg,
    });

    // ── Write failure to sync_errors for later retry ────────────────────
    try {
      await SyncError.create({
        instanceId,
        type: 'form_submission',
        referenceId: submission.submissionId,
        email,
        payload: {
          submission,
          hubspotProperties,
        },
        error: errorMsg,
        retryCount: 0,
      });
      logger.info('Sync error recorded for retry', {
        instanceId,
        submissionId: submission.submissionId,
      });
    } catch (dbErr) {
      // Last-resort: if even the error write fails, at least we logged it
      logger.error('Failed to write sync_error record', {
        instanceId,
        error: (dbErr as Error).message,
      });
    }

    return null;
  }
}
