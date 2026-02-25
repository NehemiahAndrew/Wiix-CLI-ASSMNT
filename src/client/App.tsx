// =============================================================================
// App — WDS Dashboard shell with polished Page, Tabs & connection awareness
// =============================================================================
import React, { useState, useEffect } from 'react';
import '@wix/design-system/styles.global.css';
import {
  Box,
  Page,
  Tabs,
  Tooltip,
  Badge,
  Heading,
  Text,
} from '@wix/design-system';
import { StatusCompleteFilled } from '@wix/wix-ui-icons-common';
import ConnectionPanel from './ConnectionPanel';
import FieldMappingTable from './FieldMappingTable';
import SyncDashboard from './SyncDashboard';
import ContactList from './ContactList';
import FormCapture from './FormCapture';
import { getConnectionStatus } from './api';

/* ── Tab IDs ── */
const TAB_CONNECTION = 1;
const TAB_FIELDS = 2;
const TAB_SYNC = 3;
const TAB_CONTACTS = 4;
const TAB_FORMS = 5;

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState(TAB_CONNECTION);
  const [connected, setConnected] = useState(false);

  /* Check initial connection status */
  useEffect(() => {
    getConnectionStatus()
      .then((s) => {
        setConnected(s.connected);
        // Auto-navigate to Sync tab if already connected
        if (s.connected) setActiveTab(TAB_SYNC);
      })
      .catch(() => {});
  }, []);

  /* When connection changes, auto-navigate */
  const handleConnectionChange = (c: boolean) => {
    setConnected(c);
    if (c && activeTab === TAB_CONNECTION) setActiveTab(TAB_SYNC);
    if (!c) setActiveTab(TAB_CONNECTION);
  };

  /* Tab definitions */
  const tabItems = [
    { id: TAB_CONNECTION, title: 'Connection' },
    { id: TAB_FIELDS, title: 'Field Mapping' },
    { id: TAB_SYNC, title: 'Sync Status' },
    { id: TAB_CONTACTS, title: 'Contacts' },
    { id: TAB_FORMS, title: 'Forms' },
  ];

  /* Prevent switching to disabled tabs */
  const handleTabClick = (tab: { id: string | number }) => {
    const id = typeof tab.id === 'string' ? Number(tab.id) : tab.id;
    if (!connected && id !== TAB_CONNECTION) return;
    setActiveTab(id);
  };

  return (
    <Page>
      <Page.Header
        title={
          <Box gap="12px" verticalAlign="middle">
            <Heading size="medium">Wix ↔ HubSpot Integration</Heading>
            {connected && (
              <Badge
                size="small"
                skin="success"
                prefixIcon={<StatusCompleteFilled />}
              >
                Connected
              </Badge>
            )}
          </Box>
        }
        subtitle={
          <Text size="small" secondary>
            Bi-directional contact sync, field mapping & form capture
          </Text>
        }
      />

      <Page.Content>
        <Box direction="vertical" gap="24px">
          {/* Tabs — disabled items show tooltip */}
          <Box>
            <Tabs
              activeId={activeTab}
              onClick={handleTabClick}
              items={tabItems.map((tab) => {
                if (!connected && tab.id !== TAB_CONNECTION) {
                  return {
                    ...tab,
                    title: (
                      <Tooltip content="Connect HubSpot first" placement="top">
                        <Text
                          size="small"
                          secondary
                          skin="disabled"
                          style={{ cursor: 'not-allowed', opacity: 0.5 }}
                        >
                          {tab.title}
                        </Text>
                      </Tooltip>
                    ),
                  };
                }
                return tab;
              })}
            />
          </Box>

          {/* Tab content */}
          {activeTab === TAB_CONNECTION && (
            <ConnectionPanel
              connected={connected}
              onConnectionChange={handleConnectionChange}
            />
          )}
          {activeTab === TAB_FIELDS && <FieldMappingTable connected={connected} />}
          {activeTab === TAB_SYNC && <SyncDashboard connected={connected} />}
          {activeTab === TAB_CONTACTS && <ContactList connected={connected} />}
          {activeTab === TAB_FORMS && <FormCapture connected={connected} />}
        </Box>
      </Page.Content>
    </Page>
  );
}
