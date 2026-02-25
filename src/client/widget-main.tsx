// =============================================================================
// Widget entry point — mounts HubSpotFormWidget into #widget-root
// =============================================================================
import React from 'react';
import { createRoot } from 'react-dom/client';
import HubSpotFormWidget from './HubSpotFormWidget';

const container = document.getElementById('widget-root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <HubSpotFormWidget />
    </React.StrictMode>,
  );
}
