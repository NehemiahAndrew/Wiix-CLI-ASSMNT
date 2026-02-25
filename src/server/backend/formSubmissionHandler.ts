// =============================================================================
// Module 11-B: Wix Form Submission Event Handler
// =============================================================================
// Handles `wixForms_onFormSubmit` events fired by the Wix platform.
//
// Responsibilities:
//   1. Flatten the raw submission into a plain key-value `Record<string, string>`.
//   2. Extract the page URL, referrer, and UTM parameters.
//   3. Build a `WixFormSubmission` object enriched with attribution data.
//   4. Persist the raw submission to the `FormSubmission` collection for
//      auditing & retry purposes.
//   5. Delegate to the Module 3 form handler (`handleFormSubmission`) which
//      upserts the contact in HubSpot.
//
// As with the CRM event hooks in events.ts, the heavy work runs in a
// `.then()` chain so the event handler returns quickly.
// =============================================================================

import Installation from '../models/Installation';
import FormSubmission from '../models/FormSubmission';
import { handleFormSubmission } from '../services/formHandler';
import { parseUtmParams, UtmParams } from '../utils/utmParser';
import { sanitizeMessage } from '../utils/sanitizeError';
import logger from '../utils/logger';
import { WixFormSubmission, Attribution } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types — Wix form submit event shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of the event object that Wix sends to `wixForms_onFormSubmit`.
 * The exact structure varies across Wix Forms v1 / v2 and legacy Form Builder,
 * so every field is optional and the handler probes multiple locations.
 */
interface WixFormSubmitEvent {
  /** Wix instance identifier (site-level) */
  metadata?: { instanceId?: string };
  /** Fallback instanceId at top level */
  instanceId?: string;

  /** Unique submission identifier */
  submissionId?: string;

  /** Form identifiers */
  formId?: string;
  formName?: string;

  /** Contact that submitted (may be absent for anonymous forms) */
  contactId?: string;

  /** Field values — may appear under multiple keys */
  submissions?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  values?: Record<string, unknown>;

  /** Extended / hidden fields (UTM, page URL, referrer, etc.) */
  extendedFields?: Record<string, string>;

  /** Page where the form was submitted from */
  pageUrl?: string;
  page_url?: string;

  /** HTTP referrer */
  referrer?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten raw form field values into a simple string-to-string map.
 * Wix may nest the values in different locations; this function probes
 * `submissions`, `fields`, and `values` in priority order.
 */
function flattenFields(event: WixFormSubmitEvent): Record<string, string> {
  const raw = event.submissions ?? event.fields ?? event.values ?? {};
  const result: Record<string, string> = {};

  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined) continue;
    result[key] = typeof val === 'string' ? val : JSON.stringify(val);
  }

  return result;
}

/**
 * Extract attribution data (UTM parameters, page URL, referrer) from
 * the event and / or the flattened field map.
 */
function extractAttribution(
  event: WixFormSubmitEvent,
  fields: Record<string, string>,
): Attribution {
  // Page URL — check multiple locations
  const pageUrl =
    event.pageUrl ??
    event.page_url ??
    event.extendedFields?.page_url ??
    event.extendedFields?.pageUrl ??
    fields.page_url ??
    fields.pageUrl ??
    fields.landing_page ??
    fields.landingPage ??
    '';

  // Referrer
  const referrer =
    event.referrer ??
    event.extendedFields?.referrer ??
    fields.referrer ??
    '';

  // UTM params — parse from the page URL
  const urlUtm: UtmParams = parseUtmParams(pageUrl);

  // Also check for explicit UTM fields in extended or regular fields
  const ext = event.extendedFields ?? {};
  const directUtm: UtmParams = {
    ...(ext.utm_source ? { utm_source: ext.utm_source } : {}),
    ...(ext.utm_medium ? { utm_medium: ext.utm_medium } : {}),
    ...(ext.utm_campaign ? { utm_campaign: ext.utm_campaign } : {}),
    ...(ext.utm_term ? { utm_term: ext.utm_term } : {}),
    ...(ext.utm_content ? { utm_content: ext.utm_content } : {}),
    // Fall back to regular fields
    ...(fields.utm_source ? { utm_source: fields.utm_source } : {}),
    ...(fields.utm_medium ? { utm_medium: fields.utm_medium } : {}),
    ...(fields.utm_campaign ? { utm_campaign: fields.utm_campaign } : {}),
    ...(fields.utm_term ? { utm_term: fields.utm_term } : {}),
    ...(fields.utm_content ? { utm_content: fields.utm_content } : {}),
  };

  // Merge — explicit fields win over URL-parsed
  const merged: UtmParams = { ...urlUtm, ...directUtm };

  return {
    utmSource: merged.utm_source ?? '',
    utmMedium: merged.utm_medium ?? '',
    utmCampaign: merged.utm_campaign ?? '',
    utmTerm: merged.utm_term ?? '',
    utmContent: merged.utm_content ?? '',
    referrer,
    landingPage: pageUrl,
  };
}

/**
 * Derive a display-friendly contact name from the flattened fields.
 */
function deriveContactName(fields: Record<string, string>): string {
  const first =
    fields.firstName ??
    fields.first_name ??
    fields['First Name'] ??
    fields.firstname ??
    '';
  const last =
    fields.lastName ??
    fields.last_name ??
    fields['Last Name'] ??
    fields.lastname ??
    '';
  return [first, last].filter(Boolean).join(' ').trim();
}

/**
 * Extract email from common field-name variations.
 */
function extractEmail(fields: Record<string, string>): string {
  const candidates = [
    'email', 'Email', 'EMAIL', 'e-mail', 'E-mail', 'E-Mail',
    'emailAddress', 'email_address', 'EmailAddress',
    'contactEmail', 'contact_email',
  ];

  for (const key of candidates) {
    const val = fields[key];
    if (val && val.trim().length > 0) return val.trim().toLowerCase();
  }

  // Fallback: any key containing "email"
  for (const [key, val] of Object.entries(fields)) {
    if (key.toLowerCase().includes('email') && val && val.trim().length > 0) {
      return val.trim().toLowerCase();
    }
  }

  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Wix Forms Event Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggered by the Wix platform when a visitor submits a form.
 *
 * The handler:
 *   1. Flattens the submission fields into a `Record<string, string>`.
 *   2. Extracts attribution (page URL, referrer, UTM params).
 *   3. Persists the raw submission to MongoDB (as a `FormSubmission` doc).
 *   4. Calls the Module 3 `handleFormSubmission` to upsert in HubSpot.
 *   5. Updates the MongoDB record with the resulting HubSpot contact ID.
 *
 * All async work uses `.then()` chains (no `await`) to ensure the event
 * handler returns immediately, matching Wix's event-hook execution model.
 *
 * @param event — The raw `wixForms_onFormSubmit` event payload
 */
export function wixForms_onFormSubmit(event: WixFormSubmitEvent): void {
  const instanceId =
    event.metadata?.instanceId ?? event.instanceId ?? '';
  const submissionId = event.submissionId ?? '';

  if (!instanceId) {
    logger.warn('wixForms_onFormSubmit: missing instanceId — ignoring', {
      submissionId,
    });
    return;
  }

  if (!submissionId) {
    logger.warn('wixForms_onFormSubmit: missing submissionId — ignoring', {
      instanceId,
    });
    return;
  }

  // ── 1. Flatten fields & extract attribution ────────────────────────
  const fields = flattenFields(event);
  const attribution = extractAttribution(event, fields);
  const contactEmail = extractEmail(fields);
  const contactName = deriveContactName(fields);

  logger.info('wixForms_onFormSubmit: processing submission', {
    instanceId,
    submissionId,
    formId: event.formId ?? 'unknown',
    formName: event.formName ?? '',
    hasEmail: !!contactEmail,
    fieldCount: Object.keys(fields).length,
  });

  // ── 2. Build the WixFormSubmission for Module 3 ────────────────────
  const submission: WixFormSubmission = {
    formId: event.formId,
    formName: event.formName,
    submissionId,
    contactId: event.contactId,
    submissions: fields,
    extendedFields: {
      ...(event.extendedFields ?? {}),
      // Ensure page URL & referrer are present in extendedFields
      // for the Module 3 handler to pick up
      landing_page: attribution.landingPage,
      referrer: attribution.referrer,
      ...(attribution.utmSource ? { utm_source: attribution.utmSource } : {}),
      ...(attribution.utmMedium ? { utm_medium: attribution.utmMedium } : {}),
      ...(attribution.utmCampaign ? { utm_campaign: attribution.utmCampaign } : {}),
      ...(attribution.utmTerm ? { utm_term: attribution.utmTerm } : {}),
      ...(attribution.utmContent ? { utm_content: attribution.utmContent } : {}),
    },
  };

  // ── 3. Resolve installation → persist → sync ──────────────────────
  Installation.findOne({ instanceId })
    .then((installation) => {
      if (!installation) {
        logger.warn('wixForms_onFormSubmit: no installation found', {
          instanceId,
          submissionId,
        });
        return;
      }

      // ── 3a. Persist raw submission to MongoDB ─────────────────────
      FormSubmission.create({
        instanceId,
        wixFormId: event.formId ?? '',
        wixFormName: event.formName ?? '',
        submissionId,
        contactEmail,
        contactName,
        fields,
        attribution,
        hubspotContactId: '',
        hubspotFormGuid: '',
        syncedToHubspot: false,
        syncError: '',
      })
        .then((doc) => {
          logger.debug('wixForms_onFormSubmit: submission persisted', {
            instanceId,
            submissionId,
            docId: doc._id,
          });
        })
        .catch((dbErr: unknown) => {
          // Non-fatal: even if persistence fails we still try the sync
          logger.warn('wixForms_onFormSubmit: failed to persist submission', {
            instanceId,
            submissionId,
            error: sanitizeMessage((dbErr as Error).message ?? String(dbErr)),
          });
        });

      // ── 3b. Skip HubSpot sync if not connected ───────────────────
      if (!installation.connected) {
        logger.debug('wixForms_onFormSubmit: HubSpot not connected — skipping sync', {
          instanceId,
          submissionId,
        });
        return;
      }

      // ── 3c. Delegate to Module 3 form handler ────────────────────
      handleFormSubmission(installation, submission)
        .then((hubspotContactId) => {
          if (hubspotContactId) {
            logger.info('wixForms_onFormSubmit: synced to HubSpot', {
              instanceId,
              submissionId,
              hubspotContactId,
            });

            // Update the persisted record with the HubSpot contact ID
            FormSubmission.updateOne(
              { submissionId },
              {
                $set: {
                  hubspotContactId,
                  syncedToHubspot: true,
                },
              },
            ).catch((updateErr: unknown) => {
              logger.warn('wixForms_onFormSubmit: failed to update submission record', {
                instanceId,
                submissionId,
                error: sanitizeMessage((updateErr as Error).message ?? String(updateErr)),
              });
            });
          } else {
            logger.warn('wixForms_onFormSubmit: sync returned null (likely no email)', {
              instanceId,
              submissionId,
            });
          }
        })
        .catch((syncErr: unknown) => {
          const sanitized = sanitizeMessage((syncErr as Error).message ?? String(syncErr));

          logger.error('wixForms_onFormSubmit: HubSpot sync failed', {
            instanceId,
            submissionId,
            error: sanitized,
          });

          // Mark the persisted record with the error
          FormSubmission.updateOne(
            { submissionId },
            {
              $set: {
                syncError: sanitized,
                syncedToHubspot: false,
              },
            },
          ).catch((updateErr: unknown) => {
            logger.warn('wixForms_onFormSubmit: failed to record sync error', {
              instanceId,
              submissionId,
              error: sanitizeMessage((updateErr as Error).message ?? String(updateErr)),
            });
          });
        });
    })
    .catch((err: unknown) => {
      logger.error('wixForms_onFormSubmit: installation lookup failed', {
        instanceId,
        submissionId,
        error: sanitizeMessage((err as Error).message ?? String(err)),
      });
    });
}
