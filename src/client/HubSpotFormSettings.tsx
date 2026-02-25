// =============================================================================
// Module 12 — Editor Settings Panel for HubSpot Form Widget
// =============================================================================
// This component renders in the Wix Editor's settings sidebar when a site
// owner selects the HubSpot Form Widget.
//
// Features:
//   • Dropdown listing all HubSpot forms in the connected portal
//   • Fetches the list from HubSpot Marketing Forms API via our backend
//   • Shows a reconnect message if the `forms` OAuth scope is missing
//   • Saves the selected formId through the widget config endpoint
// =============================================================================
import React, { useEffect, useState } from 'react';

interface HubSpotForm {
  id: string;
  name: string;
}

type PanelState = 'loading' | 'ready' | 'no-permission' | 'error';

/* ── Inline styles ── */
const s: Record<string, React.CSSProperties> = {
  root: {
    fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    padding: 20,
    maxWidth: 360,
    color: '#1a1a2e',
  },
  heading: { fontSize: 16, fontWeight: 600, marginBottom: 16 },
  label: { display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6 },
  select: {
    width: '100%',
    padding: '8px 12px',
    fontSize: 14,
    border: '1px solid #c1c7cd',
    borderRadius: 6,
    background: '#fff',
    cursor: 'pointer',
  },
  msg: {
    fontSize: 13,
    lineHeight: 1.5,
    padding: '12px 16px',
    borderRadius: 8,
    marginTop: 12,
  },
  info: { background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' },
  warn: { background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' },
  error: { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' },
  success: { background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' },
  spinner: {
    width: 24,
    height: 24,
    border: '3px solid #e2e8f0',
    borderTop: '3px solid #3b82f6',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    margin: '40px auto',
  },
};

/** Read token from URL query */
function authHeaders(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('instance') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function HubSpotFormSettings(): React.ReactElement {
  const [state, setState] = useState<PanelState>('loading');
  const [forms, setForms] = useState<HubSpotForm[]>([]);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [saved, setSaved] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  /* ── Load current config + form list on mount ── */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Fetch current widget config
        const cfgRes = await fetch('/api/widget/config', { headers: authHeaders() });
        if (cfgRes.ok) {
          const cfg = await cfgRes.json();
          if (cfg.formId) setSelectedFormId(cfg.formId);
        }

        // Fetch form list
        const formsRes = await fetch('/api/widget/hubspot-forms', { headers: authHeaders() });
        if (!cancelled) {
          if (formsRes.status === 403) {
            const body = await formsRes.json().catch(() => ({}));
            if (body.error === 'forms_permission_required') {
              setState('no-permission');
              return;
            }
          }
          if (!formsRes.ok) throw new Error('Failed to load forms');

          const data = await formsRes.json();
          setForms(data.forms || []);
          setState('ready');
        }
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setErrorMsg((err as Error).message || 'Something went wrong.');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  /* ── Save selected form ── */
  async function handleSave(formId: string) {
    setSelectedFormId(formId);
    setSaved(false);

    if (!formId) return;

    try {
      const res = await fetch('/api/widget/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ formId }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setErrorMsg('Could not save the selection. Please try again.');
    }
  }

  return (
    <div style={s.root}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={s.heading}>HubSpot Form Widget</div>

      {/* Loading */}
      {state === 'loading' && <div style={s.spinner} role="status" aria-label="Loading" />}

      {/* Missing forms permission */}
      {state === 'no-permission' && (
        <div style={{ ...s.msg, ...s.warn }}>
          <strong>Forms permission required</strong>
          <p style={{ margin: '8px 0 0' }}>
            To list your HubSpot forms, the app needs the <em>forms</em> permission.
            Please disconnect and reconnect HubSpot with the additional <strong>forms</strong> scope enabled.
          </p>
        </div>
      )}

      {/* Error */}
      {state === 'error' && (
        <div style={{ ...s.msg, ...s.error }}>
          {errorMsg || 'Failed to load HubSpot forms.'}
        </div>
      )}

      {/* Ready — show dropdown */}
      {state === 'ready' && (
        <>
          <label style={s.label} htmlFor="hs-form-select">
            Choose a HubSpot form
          </label>

          {forms.length === 0 ? (
            <div style={{ ...s.msg, ...s.info }}>
              No forms found in your HubSpot portal. Create a form in HubSpot first.
            </div>
          ) : (
            <select
              id="hs-form-select"
              style={s.select}
              value={selectedFormId}
              onChange={(e) => handleSave(e.target.value)}
            >
              <option value="">— Select a form —</option>
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}

          {saved && (
            <div style={{ ...s.msg, ...s.success, marginTop: 12 }}>
              Form saved successfully.
            </div>
          )}

          {errorMsg && state === 'ready' && (
            <div style={{ ...s.msg, ...s.error, marginTop: 12 }}>{errorMsg}</div>
          )}
        </>
      )}
    </div>
  );
}
