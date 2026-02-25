// =============================================================================
// Form Capture Service — Wix Form → HubSpot with UTM attribution
// =============================================================================
// Processes Wix form submissions, maps fields, attaches UTM parameters,
// then forwards to HubSpot as both a contact upsert AND a form submission.
// =============================================================================
import { IInstallation } from '../models/Installation';
import FormSubmission, { IFormSubmission } from '../models/FormSubmission';
import * as hubspot from './hubspotService';
import { syncWixToHubspot } from './syncEngine';
import logger from '../utils/logger';
import { Attribution, WixFormSubmission } from '../types';

/** Extract UTM and referrer attribution from submission metadata */
function extractAttribution(submission: WixFormSubmission): Attribution {
  const ext = submission.extendedFields ?? {};
  return {
    utmSource: ext.utm_source ?? '',
    utmMedium: ext.utm_medium ?? '',
    utmCampaign: ext.utm_campaign ?? '',
    utmTerm: ext.utm_term ?? '',
    utmContent: ext.utm_content ?? '',
    referrer: ext.referrer ?? '',
    landingPage: ext.landing_page ?? '',
  };
}

/** Flatten submission fields into a simple key-value map */
function flattenFields(submission: WixFormSubmission): Record<string, string> {
  const flat: Record<string, string> = {};
  if (submission.submissions) {
    for (const [key, val] of Object.entries(submission.submissions)) {
      flat[key] = typeof val === 'string' ? val : JSON.stringify(val);
    }
  }
  return flat;
}

/** Guess contact name from fields */
function extractContactName(fields: Record<string, string>): string {
  const first = fields.firstName || fields.first_name || fields['First Name'] || '';
  const last = fields.lastName || fields.last_name || fields['Last Name'] || '';
  return `${first} ${last}`.trim();
}

/** Guess contact email from fields */
function extractContactEmail(fields: Record<string, string>): string {
  return (
    fields.email ||
    fields.Email ||
    fields.emailAddress ||
    fields.email_address ||
    ''
  );
}

/* ════════════════════════════════════════════════════════════════════════════
 * Process a single Wix form submission
 * ════════════════════════════════════════════════════════════════════════════ */
export async function processFormSubmission(
  installation: IInstallation,
  submission: WixFormSubmission,
): Promise<IFormSubmission> {
  const instanceId = installation.instanceId;
  const fields = flattenFields(submission);
  const email = extractContactEmail(fields);
  const name = extractContactName(fields);
  const attribution = extractAttribution(submission);

  // Persist locally first
  let record = await FormSubmission.findOne({
    submissionId: submission.submissionId,
  });

  if (!record) {
    record = await FormSubmission.create({
      instanceId,
      wixFormId: submission.formId ?? '',
      wixFormName: submission.formName ?? '',
      submissionId: submission.submissionId,
      contactEmail: email,
      contactName: name,
      fields,
      attribution,
    });
  }

  // Attempt HubSpot sync
  try {
    // 1. Upsert as a contact
    if (email) {
      const contactData = {
        info: {
          name: { first: fields.firstName || fields.first_name || '', last: fields.lastName || fields.last_name || '' },
          emails: [{ email }],
          phones: fields.phone ? [{ phone: fields.phone }] : [],
          company: fields.company || '',
          jobTitle: fields.jobTitle || fields.job_title || '',
        },
      };

      const result = await syncWixToHubspot(
        installation,
        submission.contactId ?? `form-${submission.submissionId}`,
        contactData,
        'wix_webhook',
      );

      record.hubspotContactId = result.hubspotContactId;
    }

    // 2. Also submit HubSpot form (if a mapping exists)
    if (record.hubspotFormGuid) {
      const formFields = Object.entries(fields).map(([k, v]) => ({
        name: k,
        value: v,
      }));

      // Inject UTM as hidden fields
      if (attribution.utmSource)
        formFields.push({ name: 'utm_source', value: attribution.utmSource });
      if (attribution.utmMedium)
        formFields.push({ name: 'utm_medium', value: attribution.utmMedium });
      if (attribution.utmCampaign)
        formFields.push({ name: 'utm_campaign', value: attribution.utmCampaign });
      if (attribution.utmTerm)
        formFields.push({ name: 'utm_term', value: attribution.utmTerm });
      if (attribution.utmContent)
        formFields.push({ name: 'utm_content', value: attribution.utmContent });

      await hubspot.submitForm(installation, record.hubspotFormGuid, formFields, {
        pageUri: attribution.landingPage,
      });
    }

    record.syncedToHubspot = true;
    record.syncError = '';
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Form sync to HubSpot failed', {
      instanceId,
      submissionId: submission.submissionId,
      error: msg,
    });
    record.syncedToHubspot = false;
    record.syncError = msg;
  }

  await record.save();
  return record;
}

/**
 * Retrieve form submissions for the dashboard.
 */
export async function getFormSubmissions(
  instanceId: string,
  page = 1,
  limit = 20,
): Promise<{ submissions: IFormSubmission[]; total: number; page: number; pages: number }> {
  const total = await FormSubmission.countDocuments({ instanceId });
  const pages = Math.ceil(total / limit);
  const submissions = await FormSubmission.find({ instanceId })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  return { submissions, total, page, pages };
}
