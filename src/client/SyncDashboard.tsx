// =============================================================================
// SyncStatusPanel — WDS-powered sync monitoring & control dashboard
// =============================================================================
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Badge,
  Button,
  Card,
  EmptyState,
  Heading,
  Loader,
  Notification,
  Table,
  Text,
  ToggleSwitch,
  Tooltip,
  StatisticsWidget,
} from '@wix/design-system';
import {
  Refresh,
  Pause,
  Play,
  StatusAlertFilled,
  StatusCompleteFilled,
} from '@wix/wix-ui-icons-common';
import { getSyncStats, getSyncHistory, triggerFullSync, toggleSync } from './api';

/* ── Auto-refresh interval (ms) ── */
const REFRESH_INTERVAL = 30_000;

/* ── Types ── */
interface SyncEvent {
  _id: string;
  source: string;
  action: string;
  status: string;
  wixContactId: string;
  hubspotContactId: string;
  duration: number;
  error: string;
  createdAt: string;
}

interface Stats {
  totalMappings: number;
  totalEvents: number;
  recentSuccess: number;
  recentFailed: number;
  avgDuration: number;
  syncEnabled: boolean;
  lastSyncAt: string | null;
}

interface Props {
  connected: boolean;
}

/* ── Component ── */
export default function SyncDashboard({ connected }: Props): React.ReactElement {
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<SyncEvent[]>([]);
  const [recentErrors, setRecentErrors] = useState<SyncEvent[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [syncResult, setSyncResult] = useState('');
  const [syncResultTheme, setSyncResultTheme] = useState<'success' | 'error'>('success');
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Fetch data ── */
  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([getSyncStats(), getSyncHistory(page)]);
      setStats(s);
      setHistory(h.events);
      setPages(h.pages);
      // Extract 5 most recent errors from history
      setRecentErrors(h.events.filter((e) => e.status === 'failed').slice(0, 5));
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [page]);

  /* Initial load & auto-refresh every 30 s */
  useEffect(() => {
    if (!connected) return;
    setLoading(true);
    load();
    refreshTimer.current = setInterval(load, REFRESH_INTERVAL);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, [connected, load]);

  /* ── Full sync ── */
  const handleFullSync = async () => {
    setSyncing(true);
    setSyncResult('');
    try {
      const r = await triggerFullSync();
      setSyncResult(`Synced: ${r.synced} · Skipped: ${r.skipped} · Errors: ${r.errors}`);
      setSyncResultTheme(r.errors > 0 ? 'error' : 'success');
      await load();
    } catch (err) {
      setSyncResult(`Error: ${(err as Error).message}`);
      setSyncResultTheme('error');
    } finally {
      setSyncing(false);
    }
  };

  /* ── Pause / Resume toggle ── */
  const handleToggle = async () => {
    setToggling(true);
    try {
      const r = await toggleSync();
      setStats((prev) => (prev ? { ...prev, syncEnabled: r.syncEnabled } : prev));
    } catch {
      // swallow
    } finally {
      setToggling(false);
    }
  };

  /* ── Retry a single failed event (triggers full sync as proxy) ── */
  const handleRetry = async () => {
    await handleFullSync();
  };

  /* ── Not connected state ── */
  if (!connected) {
    return (
      <Card>
        <Card.Content>
          <EmptyState
            title="Sync Dashboard Unavailable"
            subtitle="Connect your HubSpot account first to manage sync."
            theme="section"
          />
        </Card.Content>
      </Card>
    );
  }

  /* ── Loading state ── */
  if (loading && !stats) {
    return (
      <Box align="center" verticalAlign="middle" height="300px">
        <Loader size="medium" text="Loading sync data…" />
      </Box>
    );
  }

  /* ── History table columns ── */
  const historyColumns = [
    {
      title: 'Time',
      width: '18%',
      render: (row: SyncEvent) => (
        <Text size="small">{new Date(row.createdAt).toLocaleString()}</Text>
      ),
    },
    {
      title: 'Source',
      width: '14%',
      render: (row: SyncEvent) => (
        <Badge size="small" skin={row.source.includes('wix') ? 'general' : 'standard'}>
          {row.source}
        </Badge>
      ),
    },
    {
      title: 'Action',
      width: '14%',
      render: (row: SyncEvent) => <Text size="small">{row.action}</Text>,
    },
    {
      title: 'Status',
      width: '12%',
      render: (row: SyncEvent) => (
        <Badge
          size="small"
          skin={row.status === 'failed' ? 'danger' : row.status === 'success' ? 'success' : 'warning'}
        >
          {row.status}
        </Badge>
      ),
    },
    {
      title: 'Duration',
      width: '10%',
      render: (row: SyncEvent) => <Text size="small">{row.duration}ms</Text>,
    },
    {
      title: 'Error',
      width: '32%',
      render: (row: SyncEvent) =>
        row.error ? (
          <Text size="small" skin="error">
            {row.error}
          </Text>
        ) : (
          <Text size="small" secondary>
            —
          </Text>
        ),
    },
  ];

  /* ── Error table columns ── */
  const errorColumns = [
    {
      title: 'Time',
      width: '25%',
      render: (row: SyncEvent) => (
        <Text size="small">{new Date(row.createdAt).toLocaleString()}</Text>
      ),
    },
    {
      title: 'Error',
      width: '55%',
      render: (row: SyncEvent) => (
        <Text size="small" skin="error">
          {row.error || 'Unknown error'}
        </Text>
      ),
    },
    {
      title: '',
      width: '20%',
      render: () => (
        <Button size="tiny" priority="secondary" onClick={handleRetry}>
          Retry
        </Button>
      ),
    },
  ];

  /* Format the "last sync" display */
  const lastSyncDisplay = stats?.lastSyncAt
    ? new Date(stats.lastSyncAt).toLocaleString()
    : 'Never';

  return (
    <Box direction="vertical" gap="18px">
      {/* Sync result notification */}
      {syncResult && (
        <Notification
          theme={syncResultTheme}
          show
          autoHideTimeout={5000}
          onClose={() => setSyncResult('')}
        >
          <Notification.TextLabel>{syncResult}</Notification.TextLabel>
          <Notification.CloseButton />
        </Notification>
      )}

      {/* Controls bar */}
      <Card>
        <Card.Header
          title="Sync Controls"
          subtitle={`Last sync: ${lastSyncDisplay}`}
          suffix={
            <Box gap="12px" verticalAlign="middle">
              <Box gap="8px" verticalAlign="middle">
                <Text size="small" secondary>
                  {stats?.syncEnabled ? 'Syncing' : 'Paused'}
                </Text>
                <ToggleSwitch
                  size="medium"
                  checked={stats?.syncEnabled ?? false}
                  disabled={toggling}
                  onChange={handleToggle}
                />
              </Box>
              <Button
                size="small"
                prefixIcon={syncing ? undefined : <Refresh />}
                onClick={handleFullSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing…' : 'Run Full Sync'}
              </Button>
            </Box>
          }
        />
      </Card>

      {/* Statistics */}
      {stats && (
        <Card>
          <Card.Content>
            <StatisticsWidget
              items={[
                {
                  value: String(stats.totalMappings),
                  description: 'Mapped Contacts',
                },
                {
                  value: String(stats.recentSuccess),
                  description: 'Recent Successful',
                },
                {
                  value: String(stats.recentFailed),
                  description: 'Recent Failed',
                },
                {
                  value:
                    stats.recentSuccess + stats.recentFailed > 0
                      ? `${Math.round(
                          (stats.recentSuccess /
                            (stats.recentSuccess + stats.recentFailed)) *
                            100,
                        )}%`
                      : '—',
                  description: 'Success Rate',
                },
                {
                  value: `${stats.avgDuration}ms`,
                  description: 'Avg Duration',
                },
              ]}
            />
          </Card.Content>
        </Card>
      )}

      {/* Recent Errors */}
      {recentErrors.length > 0 && (
        <Card>
          <Card.Header
            title="Recent Errors"
            subtitle="5 most recent sync failures"
            suffix={
              <Badge size="small" skin="danger" prefixIcon={<StatusAlertFilled />}>
                {recentErrors.length}
              </Badge>
            }
          />
          <Card.Divider />
          <Card.Content>
            <Table data={recentErrors} columns={errorColumns}>
              <Table.Content />
            </Table>
          </Card.Content>
        </Card>
      )}

      {/* Full Sync History */}
      <Card>
        <Card.Header title="Sync History" subtitle={`Page ${page} of ${pages}`} />
        <Card.Divider />
        <Card.Content>
          {history.length === 0 ? (
            <EmptyState
              title="No sync events yet"
              subtitle="Events will appear here once contacts start syncing."
            />
          ) : (
            <Table data={history} columns={historyColumns}>
              <Table.Content />
            </Table>
          )}

          {pages > 1 && (
            <Box marginTop="12px" gap="8px" align="center">
              <Button
                size="tiny"
                priority="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Prev
              </Button>
              <Text size="small">
                Page {page} of {pages}
              </Text>
              <Button
                size="tiny"
                priority="secondary"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </Button>
            </Box>
          )}
        </Card.Content>
      </Card>

      {/* Auto-refresh indicator */}
      <Box align="right">
        <Text size="tiny" secondary>
          Auto-refreshes every 30 seconds
        </Text>
      </Box>
    </Box>
  );
}
