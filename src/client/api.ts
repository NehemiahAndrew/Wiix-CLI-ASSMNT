// =============================================================================
// API Client — Typed fetch wrapper for all server endpoints
// =============================================================================

/**
 * Resolve the API base URL.
 * - When served by our own Express server (production / self-hosted), use
 *   relative `/api`.
 * - When loaded inside the Wix dashboard iframe via `wix dev`, the page is
 *   served from Wix's CDN — calls must go to our Express backend via the
 *   ngrok tunnel URL.
 */
export function getBackendOrigin(): string {
  const env =
    typeof import.meta !== 'undefined'
      ? (import.meta as any).env?.VITE_BACKEND_URL
      : undefined;
  return (
    env || 'https://nontangentially-tristichic-suellen.ngrok-free.dev'
  );
}

export function getApiBase(): string {
  const host = window.location.hostname;
  const port = window.location.port;

  // Served directly by our Express backend (port 3000) — relative path works
  if (host === 'localhost' && port === '3000') {
    return '/api';
  }
  // Served via our ngrok tunnel or Render deploy — relative path works
  if (
    host.endsWith('.ngrok-free.dev') ||
    host.endsWith('.onrender.com')
  ) {
    return '/api';
  }
  // Everything else (Wix dashboard iframe, Wix CLI dev server, etc.) —
  // route through the ngrok tunnel to reach our Express backend.
  return `${getBackendOrigin()}/api`;
}

const BASE = getApiBase();

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Read the Wix instance token from the URL hash or query string */
function getInstanceToken(): string {
  // Wix dashboard injects ?instance=xxx or the token is in search params
  const params = new URLSearchParams(window.location.search);
  let token = params.get('instance') || '';

  // The Wix CLI dashboard SDK also provides this via the Wix Dashboard SDK
  // If we're in the Wix dashboard and window.wixDashboard has a token, use it
  if (!token && typeof (window as any).__WIX_INSTANCE__ === 'string') {
    token = (window as any).__WIX_INSTANCE__;
  }

  return token;
}

async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const token = getInstanceToken();
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API ${res.status}`);
  }

  return res.json();
}

/* ── Connection ── */
export const getConnectionStatus = () =>
  api<{
    connected: boolean;
    hubspotPortalId: string;
    syncEnabled: boolean;
    lastSyncAt: string | null;
  }>('/connection/status');

export const disconnectHubspot = () =>
  api<{ ok: boolean }>('/connection/disconnect', { method: 'POST' });

/* ── Field Mappings ── */
export interface FieldMappingDto {
  _id: string;
  wixField: string;
  hubspotField: string;
  direction: string;
  transform: string;
  isDefault: boolean;
  isActive: boolean;
}

export const getFieldMappings = () =>
  api<{ mappings: FieldMappingDto[] }>('/field-mappings');

export const createFieldMapping = (body: Partial<FieldMappingDto>) =>
  api<{ mapping: FieldMappingDto }>('/field-mappings', { method: 'POST', body });

export const updateFieldMapping = (id: string, body: Partial<FieldMappingDto>) =>
  api<{ mapping: FieldMappingDto }>(`/field-mappings/${id}`, { method: 'PUT', body });

export const deleteFieldMapping = (id: string) =>
  api<{ ok: boolean }>(`/field-mappings/${id}`, { method: 'DELETE' });

export const resetFieldMappings = () =>
  api<{ mappings: FieldMappingDto[] }>('/field-mappings/reset', { method: 'POST' });

export const saveFieldMappingsBulk = (
  mappings: Array<Partial<FieldMappingDto>>,
) =>
  api<{ mappings: FieldMappingDto[] }>('/field-mappings/bulk', {
    method: 'POST',
    body: { mappings },
  });

export const getHubspotProperties = () =>
  api<{ properties: Array<{ value: string; label: string; type: string }> }>(
    '/field-mappings/hubspot-properties',
  );

export const getWixFields = () =>
  api<{ fields: Array<{ value: string; label: string; type: string }> }>(
    '/field-mappings/wix-fields',
  );

/* ── Sync ── */
export const triggerFullSync = () =>
  api<{ synced: number; skipped: number; errors: number }>('/sync/full', {
    method: 'POST',
  });

export const toggleSync = () =>
  api<{ syncEnabled: boolean }>('/sync/toggle', { method: 'POST' });

export const getSyncHistory = (page = 1) =>
  api<{
    events: Array<{
      _id: string;
      source: string;
      action: string;
      status: string;
      wixContactId: string;
      hubspotContactId: string;
      duration: number;
      error: string;
      createdAt: string;
    }>;
    total: number;
    page: number;
    pages: number;
  }>(`/sync/history?page=${page}`);

export const getSyncStats = () =>
  api<{
    totalMappings: number;
    totalEvents: number;
    recentSuccess: number;
    recentFailed: number;
    avgDuration: number;
    syncEnabled: boolean;
    lastSyncAt: string | null;
  }>('/sync/stats');

/* ── Contacts ── */
export interface SyncedContact {
  wixContactId: string;
  hubspotContactId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  lastSyncedAt: string;
  lastSyncSource: 'wix' | 'hubspot' | 'manual';
}

export const getSyncedContacts = (page = 1, search = '') =>
  api<{
    contacts: SyncedContact[];
    total: number;
    page: number;
    pages: number;
  }>(`/sync/contacts?page=${page}&search=${encodeURIComponent(search)}`);

/* ── Forms ── */
export const getFormSubmissions = (page = 1) =>
  api<{
    submissions: Array<{
      _id: string;
      wixFormName: string;
      contactEmail: string;
      contactName: string;
      syncedToHubspot: boolean;
      syncError: string;
      attribution: Record<string, string>;
      createdAt: string;
    }>;
    total: number;
    page: number;
    pages: number;
  }>(`/forms?page=${page}`);

export const retryFormSubmission = (id: string) =>
  api<{ ok: boolean }>(`/forms/${id}/retry`, { method: 'POST' });

export const getHubspotForms = () =>
  api<{ forms: Array<{ id: string; name: string }> }>('/forms/hubspot-forms');

export const mapWixForm = (wixFormId: string, hubspotFormGuid: string) =>
  api<{ ok: boolean }>('/forms/map', {
    method: 'POST',
    body: { wixFormId, hubspotFormGuid },
  });

/* ── Widget (Module 12) ── */
export const getWidgetConfig = () =>
  api<{ portalId: string; formId: string }>('/widget/config');

export const saveWidgetConfig = (formId: string) =>
  api<{ ok: boolean; formId: string }>('/widget/config', {
    method: 'PUT',
    body: { formId },
  });

export const getWidgetHubspotForms = () =>
  api<{ forms: Array<{ id: string; name: string }> }>('/widget/hubspot-forms');

export const logWidgetFormSubmission = (data: {
  portalId: string;
  formId: string;
  pageUrl: string;
  referrer: string;
  utmParams: Record<string, string>;
}) =>
  api<{ ok: boolean }>('/widget/form-log', { method: 'POST', body: data });
