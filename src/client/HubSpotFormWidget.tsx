// =============================================================================
// Module 12 — HubSpot Form Embed Widget
// =============================================================================
// Renders a HubSpot form inside a Wix site iframe.
//
// Lifecycle:
//   1. On mount, fetches portalId + formId from the app's widget config endpoint.
//   2. Dynamically loads the HubSpot Forms JS SDK from their CDN.
//   3. Calls hbspt.forms.create() to render the form into #hs-form-container.
//   4. On form submission, captures pageUrl / referrer / UTM params and POSTs
//      the observability log to our backend. The actual data goes to HubSpot
//      directly via the SDK — we only log metadata on our side.
// =============================================================================
import React, { useEffect, useState, useRef } from 'react';

/* ── HubSpot Forms SDK type shims ── */
declare global {
  interface Window {
    hbspt?: {
      forms: {
        create: (opts: {
          portalId: string;
          formId: string;
          target: string;
          onFormSubmitted?: () => void;
          onFormReady?: () => void;
        }) => void;
      };
    };
  }
}

/* ── UTM parser (client-side, duplicated because widget runs in its own bundle) ── */
function parseUtmParams(url: string): Record<string, string> {
  const utm: Record<string, string> = {};
  try {
    const params = new URL(url).searchParams;
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
      const val = params.get(key);
      if (val) utm[key] = val;
    }
  } catch {
    /* not a valid URL — skip */
  }
  return utm;
}

/* ── State machine ── */
type WidgetState = 'loading' | 'ready' | 'error';

/* ── Inline styles (widget runs standalone — no global.css) ── */
const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 200,
    fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
    padding: 16,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #e2e8f0',
    borderTop: '3px solid #3b82f6',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  error: {
    color: '#b91c1c',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '16px 24px',
    textAlign: 'center' as const,
    maxWidth: 420,
  },
};

const LOAD_TIMEOUT_MS = 10_000;
const HS_FORMS_SDK_URL = 'https://js.hsforms.net/forms/v2.js';

export default function HubSpotFormWidget(): React.ReactElement {
  const [state, setState] = useState<WidgetState>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // 1. Fetch widget config (portalId + formId)
        const configRes = await fetch('/api/widget/config' + window.location.search);
        if (!configRes.ok) throw new Error('Failed to load widget configuration');
        const { portalId, formId } = await configRes.json();

        if (!portalId || !formId) {
          setState('error');
          setErrorMsg('No HubSpot form has been selected yet. Open the widget settings in the editor to choose a form.');
          return;
        }
        if (cancelled) return;

        // 2. Load HubSpot Forms SDK
        await loadHubSpotSdk();
        if (cancelled) return;

        // 3. Render the form
        if (!window.hbspt) throw new Error('HubSpot Forms SDK not available');

        window.hbspt.forms.create({
          portalId,
          formId,
          target: '#hs-form-container',
          onFormReady: () => {
            if (!cancelled) setState('ready');
          },
          onFormSubmitted: () => {
            // 4. Log the submission on our side (fire-and-forget)
            const pageUrl = window.location.href;
            const referrer = document.referrer;
            const utmParams = parseUtmParams(pageUrl);

            fetch('/api/widget/form-log', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                portalId,
                formId,
                pageUrl,
                referrer,
                utmParams,
              }),
            }).catch(() => {
              /* best-effort — don't block the user */
            });
          },
        });
      } catch (err) {
        if (!cancelled) {
          setState('error');
          setErrorMsg((err as Error).message || 'Something went wrong loading the form.');
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── SDK loader with 10-second timeout ── */
  function loadHubSpotSdk(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Already loaded?
      if (window.hbspt) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = HS_FORMS_SDK_URL;
      script.async = true;

      // 10-second timeout
      timeoutRef.current = setTimeout(() => {
        reject(new Error('HubSpot form failed to load — please try refreshing the page.'));
      }, LOAD_TIMEOUT_MS);

      script.onload = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        resolve();
      };

      script.onerror = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        reject(new Error('HubSpot form failed to load — please try refreshing the page.'));
      };

      document.head.appendChild(script);
    });
  }

  return (
    <>
      {/* Keyframes for the spinner */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {state === 'loading' && (
        <div style={styles.wrapper}>
          <div style={styles.spinner} role="status" aria-label="Loading form" />
        </div>
      )}

      {state === 'error' && (
        <div style={styles.wrapper}>
          <div style={styles.error}>
            <p style={{ margin: 0 }}>{errorMsg}</p>
          </div>
        </div>
      )}

      {/* The HubSpot SDK renders the form into this div */}
      <div
        id="hs-form-container"
        ref={containerRef}
        style={{ display: state === 'ready' ? 'block' : 'none' }}
      />
    </>
  );
}
