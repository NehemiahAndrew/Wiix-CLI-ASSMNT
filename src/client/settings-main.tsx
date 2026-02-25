// =============================================================================
// Settings panel entry point — mounts HubSpotFormSettings into #settings-root
// =============================================================================
import React from 'react';
import { createRoot } from 'react-dom/client';
import HubSpotFormSettings from './HubSpotFormSettings';

const container = document.getElementById('settings-root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <HubSpotFormSettings />
    </React.StrictMode>,
  );
}
