// =============================================================================
// ConnectHubSpot — Polished WDS connection panel (Byteline / EYEMAGINE style)
// =============================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Card,
  Heading,
  Text,
  Badge,
  Loader,
  MessageModalLayout,
  Modal,
  Box,
  Cell,
  Layout,
  Divider,
  SectionHelper,
  TextButton,
} from '@wix/design-system';
import {
  StatusCompleteFilled,
  StatusAlertFilled,
  LockLocked,
  Refresh,
  Delete,
  ExternalLink,
} from '@wix/wix-ui-icons-common';
import { getConnectionStatus, disconnectHubspot, getApiBase } from './api';

/* ── Props ── */
interface Props {
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
}

/* ── Onboarding steps (disconnected view) ── */
const STEPS = [
  {
    num: 1,
    title: 'Connect your HubSpot account',
    desc: 'Securely authorize via OAuth 2.0 — no API keys to manage.',
  },
  {
    num: 2,
    title: 'Configure field mappings',
    desc: 'Choose which Wix fields sync to which HubSpot properties.',
  },
  {
    num: 3,
    title: 'Enable sync & go',
    desc: 'Contacts sync bi-directionally in real time via webhooks.',
  },
];

/* ── Feature card data ── */
const FEATURES = [
  {
    title: 'Bi-directional Sync',
    desc: 'Contacts created or updated on either platform sync automatically in real time.',
    tag: 'Real-time',
  },
  {
    title: 'Custom Field Mapping',
    desc: 'Map any Wix field to any HubSpot property with optional transforms.',
    tag: 'Flexible',
  },
  {
    title: 'Form Capture',
    desc: 'Wix form submissions are forwarded to HubSpot with full UTM attribution.',
    tag: 'Attribution',
  },
  {
    title: 'Loop Prevention',
    desc: '3-layer deduplication guard prevents infinite sync loops between platforms.',
    tag: 'Reliable',
  },
];

/* ── HubSpot brand circle ── */
const HubSpotLogo = ({ size = 48 }: { size?: number }) => (
  <Box
    width={`${size}px`}
    height={`${size}px`}
    borderRadius="50%"
    align="center"
    verticalAlign="middle"
    flexShrink={0}
  >
    <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none">
      <path
        d="M17.05 8.37V6.07a2.07 2.07 0 0 0 1.2-1.87v-.06A2.07 2.07 0 0 0 16.18 2.07h-.06a2.07 2.07 0 0 0-2.07 2.07v.06c0 .82.49 1.53 1.2 1.87v2.3a5.84 5.84 0 0 0-2.89 1.38L6.47 5.4a2.3 2.3 0 0 0 .07-.55 2.32 2.32 0 1 0-2.32 2.32c.45 0 .86-.14 1.21-.37l5.78 4.24a5.82 5.82 0 0 0-.04 8.54l-1.78 1.78a1.65 1.65 0 0 0-.48-.08 1.68 1.68 0 1 0 1.68 1.68 1.65 1.65 0 0 0-.08-.48l1.74-1.74a5.83 5.83 0 1 0 5.76-12.37Zm-.93 8.99a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z"
        fill="#ff7a59"
      />
    </svg>
  </Box>
);

/* ── Component ── */
export default function ConnectionPanel({
  connected,
  onConnectionChange,
}: Props): React.ReactElement {
  const [portalId, setPortalId] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  /* Fetch connection status on mount */
  const fetchStatus = useCallback(() => {
    getConnectionStatus()
      .then((s) => {
        onConnectionChange(s.connected);
        setPortalId(s.hubspotPortalId ?? '');
        setSyncEnabled(s.syncEnabled ?? false);
        setLastSyncAt(s.lastSyncAt ?? null);
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false));
  }, [onConnectionChange]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  /* Listen for OAuth popup completion via postMessage */
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'HUBSPOT_CONNECTED') {
        onConnectionChange(true);
        fetchStatus();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onConnectionChange, fetchStatus]);

  /* Open the OAuth popup */
  const handleConnect = () => {
    const instance =
      new URLSearchParams(window.location.search).get('instance') || '';
    // Use the full backend URL so OAuth works even when served from the
    // Wix dashboard iframe or Wix CLI dev server (different origin).
    const base = getApiBase().replace(/\/api$/, '');
    window.open(
      `${base}/api/hubspot/auth?instance=${instance}`,
      'hubspot-oauth',
      'width=600,height=700',
    );
  };

  /* Disconnect (called after modal confirmation) */
  const handleDisconnect = async () => {
    setDisconnecting(true);
    setShowDisconnectModal(false);
    try {
      await disconnectHubspot();
      onConnectionChange(false);
      setPortalId('');
    } catch {
      // swallow
    } finally {
      setDisconnecting(false);
    }
  };

  /* ── Loading state ── */
  if (initialLoading) {
    return (
      <Box align="center" verticalAlign="middle" height="300px">
        <Loader size="medium" text="Checking connection…" />
      </Box>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
   * CONNECTED VIEW
   * ════════════════════════════════════════════════════════════════════ */
  if (connected) {
    return (
      <Box direction="vertical" gap="24px">
        {/* Disconnect modal */}
        <Modal
          isOpen={showDisconnectModal}
          onRequestClose={() => setShowDisconnectModal(false)}
          shouldCloseOnOverlayClick
        >
          <MessageModalLayout
            primaryButtonText="Disconnect"
            primaryButtonOnClick={handleDisconnect}
            secondaryButtonText="Cancel"
            secondaryButtonOnClick={() => setShowDisconnectModal(false)}
            onCloseButtonClick={() => setShowDisconnectModal(false)}
            title="Disconnect HubSpot?"
            theme="destructive"
          >
            <Text>
              This will pause all syncing and remove the connection to your
              HubSpot portal. Your data in both platforms will remain intact.
              You can reconnect at any time.
            </Text>
          </MessageModalLayout>
        </Modal>

        {/* Connected status card */}
        <Card>
          <Card.Header
            title={
              <Box gap="12px" verticalAlign="middle">
                <HubSpotLogo size={36} />
                <Box direction="vertical">
                  <Text weight="bold" size="medium">
                    HubSpot Connected
                  </Text>
                  <Text size="tiny" secondary>
                    Portal ID: {portalId}
                  </Text>
                </Box>
              </Box>
            }
            suffix={
              <Badge
                skin="success"
                size="medium"
                prefixIcon={<StatusCompleteFilled />}
              >
                Active
              </Badge>
            }
          />
          <Card.Divider />
          <Card.Content>
            <Box direction="vertical" gap="18px">
              {/* Connection details */}
              <Layout>
                <Cell span={4}>
                  <Box direction="vertical" gap="4px">
                    <Text size="tiny" secondary weight="bold">
                      STATUS
                    </Text>
                    <Box gap="6px" verticalAlign="middle">
                      <Box
                        width="8px"
                        height="8px"
                        borderRadius="50%"
                        backgroundColor={syncEnabled ? '#00a47a' : '#fdb10c'}
                      />
                      <Text size="small">
                        {syncEnabled ? 'Syncing' : 'Paused'}
                      </Text>
                    </Box>
                  </Box>
                </Cell>
                <Cell span={4}>
                  <Box direction="vertical" gap="4px">
                    <Text size="tiny" secondary weight="bold">
                      LAST SYNCED
                    </Text>
                    <Text size="small">
                      {lastSyncAt
                        ? new Date(lastSyncAt).toLocaleString()
                        : 'Never'}
                    </Text>
                  </Box>
                </Cell>
                <Cell span={4}>
                  <Box direction="vertical" gap="4px">
                    <Text size="tiny" secondary weight="bold">
                      HUBSPOT PORTAL
                    </Text>
                    <TextButton
                      size="small"
                      suffixIcon={<ExternalLink />}
                      as="a"
                      href={`https://app.hubspot.com/contacts/${portalId}`}
                      target="_blank"
                    >
                      Open in HubSpot
                    </TextButton>
                  </Box>
                </Cell>
              </Layout>

              <Divider />

              {/* Actions */}
              <Box gap="12px">
                <Button
                  size="small"
                  priority="secondary"
                  prefixIcon={<Refresh />}
                  onClick={fetchStatus}
                >
                  Refresh Status
                </Button>
                <Button
                  size="small"
                  skin="destructive"
                  priority="secondary"
                  prefixIcon={<Delete />}
                  onClick={() => setShowDisconnectModal(true)}
                  disabled={disconnecting}
                >
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </Box>
            </Box>
          </Card.Content>
        </Card>

        {/* What's syncing — feature grid */}
        <Card>
          <Card.Header
            title="What's Being Synced"
            subtitle="Data flows automatically between your Wix site and HubSpot"
          />
          <Card.Divider />
          <Card.Content>
            <Layout>
              {FEATURES.map((f) => (
                <Cell key={f.title} span={6}>
                  <Box gap="12px" padding="12px 0" verticalAlign="top">
                    <Box direction="vertical" gap="2px">
                      <Box gap="8px" verticalAlign="middle">
                        <Text weight="bold" size="small">
                          {f.title}
                        </Text>
                        <Badge size="tiny" skin="neutralLight">
                          {f.tag}
                        </Badge>
                      </Box>
                      <Text size="tiny" secondary>
                        {f.desc}
                      </Text>
                    </Box>
                  </Box>
                </Cell>
              ))}
            </Layout>
          </Card.Content>
        </Card>
      </Box>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════
   * DISCONNECTED / ONBOARDING VIEW
   * ════════════════════════════════════════════════════════════════════ */
  return (
    <Box direction="vertical" gap="24px">
      {/* Hero card */}
      <Card>
        <Card.Content>
          <Box direction="vertical" gap="20px" align="center" padding="24px 0">
            <HubSpotLogo size={64} />

            <Box direction="vertical" gap="6px" align="center">
              <Heading size="medium">Connect to HubSpot</Heading>
              <Text
                size="small"
                secondary
                style={{ maxWidth: 440, textAlign: 'center' as const }}
              >
                Link your HubSpot account to enable bi-directional contact sync,
                custom field mapping, and form capture — no Zapier required.
              </Text>
            </Box>

            <Button
              skin="standard"
              size="large"
              priority="primary"
              onClick={handleConnect}
            >
              Connect HubSpot Account
            </Button>

            <Box gap="4px" verticalAlign="middle">
              <LockLocked size="12px" />
              <Text size="tiny" secondary>
                Secure OAuth 2.0 — we never see your password
              </Text>
            </Box>
          </Box>
        </Card.Content>
      </Card>

      {/* How it works — numbered steps */}
      <Card>
        <Card.Header
          title="How It Works"
          subtitle="Get started in three simple steps"
        />
        <Card.Divider />
        <Card.Content>
          <Box direction="vertical" gap="0px">
            {STEPS.map((step) => (
              <Box
                key={step.num}
                gap="16px"
                padding="14px 0"
                verticalAlign="top"
              >
                <Box
                  width="32px"
                  height="32px"
                  borderRadius="50%"
                  backgroundColor="#3899ec"
                  align="center"
                  verticalAlign="middle"
                  flexShrink={0}
                >
                  <Text size="small" weight="bold" light>
                    {step.num}
                  </Text>
                </Box>
                <Box direction="vertical" gap="2px">
                  <Text weight="bold" size="small">
                    {step.title}
                  </Text>
                  <Text size="tiny" secondary>
                    {step.desc}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        </Card.Content>
      </Card>

      {/* Features overview */}
      <SectionHelper appearance="standard" title="What you get">
        <Layout>
          {FEATURES.map((f) => (
            <Cell key={f.title} span={6}>
              <Box gap="10px" padding="8px 0" verticalAlign="top">
                <Box direction="vertical" gap="2px">
                  <Box gap="8px" verticalAlign="middle">
                    <Text weight="bold" size="small">
                      {f.title}
                    </Text>
                    <Badge size="tiny" skin="neutralLight">
                      {f.tag}
                    </Badge>
                  </Box>
                  <Text size="tiny" secondary>
                    {f.desc}
                  </Text>
                </Box>
              </Box>
            </Cell>
          ))}
        </Layout>
      </SectionHelper>
    </Box>
  );
}
