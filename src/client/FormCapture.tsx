// =============================================================================
// FormCapture — WDS-powered form submission viewer with retry & pagination
// =============================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  EmptyState,
  Loader,
  Table,
  Text,
  Tooltip,
  Notification,
} from '@wix/design-system';
import {
  StatusCompleteFilled,
  StatusAlertFilled,
  Refresh,
} from '@wix/wix-ui-icons-common';
import { getFormSubmissions, retryFormSubmission } from './api';

/* ── Types ── */
interface Submission {
  _id: string;
  createdAt: string;
  wixFormName?: string;
  contactName?: string;
  contactEmail?: string;
  attribution?: { utmSource?: string; utmMedium?: string; utmCampaign?: string };
  syncedToHubspot: boolean;
  syncError?: string;
}

interface Props {
  connected: boolean;
}

/* ── Component ── */
export default function FormCapture({ connected }: Props): React.ReactElement {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    msg: string;
    theme: 'success' | 'error';
  } | null>(null);

  /* ── Load submissions ── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getFormSubmissions(page);
      setSubmissions(res.submissions);
      setPages(res.pages);
      setTotal(res.total);
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  /* ── Retry a failed submission ── */
  const handleRetry = async (id: string) => {
    setRetrying(id);
    try {
      await retryFormSubmission(id);
      setNotification({ msg: 'Submission retried successfully.', theme: 'success' });
      await load();
    } catch (err) {
      setNotification({
        msg: `Retry failed: ${(err as Error).message}`,
        theme: 'error',
      });
    } finally {
      setRetrying(null);
    }
  };

  /* ── Not connected ── */
  if (!connected) {
    return (
      <Card>
        <Card.Content>
          <EmptyState
            title="Form Capture Unavailable"
            subtitle="Connect your HubSpot account first to view form submissions."
          />
        </Card.Content>
      </Card>
    );
  }

  /* ── Loading ── */
  if (loading && submissions.length === 0) {
    return (
      <Box align="center" verticalAlign="middle" height="300px">
        <Loader size="medium" text="Loading form submissions…" />
      </Box>
    );
  }

  /* ── Table columns ── */
  const columns = [
    {
      title: 'Time',
      width: '18%',
      render: (row: Submission) => (
        <Text size="small">{new Date(row.createdAt).toLocaleString()}</Text>
      ),
    },
    {
      title: 'Form',
      width: '16%',
      render: (row: Submission) => (
        <Text size="small">{row.wixFormName || '—'}</Text>
      ),
    },
    {
      title: 'Contact',
      width: '16%',
      render: (row: Submission) => (
        <Text size="small">{row.contactName || '—'}</Text>
      ),
    },
    {
      title: 'Email',
      width: '18%',
      render: (row: Submission) => (
        <Text size="small">{row.contactEmail || '—'}</Text>
      ),
    },
    {
      title: 'UTM Source',
      width: '12%',
      render: (row: Submission) => (
        <Text size="small" secondary>
          {row.attribution?.utmSource || '—'}
        </Text>
      ),
    },
    {
      title: 'Synced',
      width: '10%',
      render: (row: Submission) =>
        row.syncedToHubspot ? (
          <Badge
            size="small"
            skin="success"
            prefixIcon={<StatusCompleteFilled />}
          >
            Yes
          </Badge>
        ) : (
          <Tooltip
            content={row.syncError || 'Not synced'}
            placement="top"
          >
            <Badge
              size="small"
              skin="danger"
              prefixIcon={<StatusAlertFilled />}
            >
              No
            </Badge>
          </Tooltip>
        ),
    },
    {
      title: '',
      width: '10%',
      render: (row: Submission) =>
        !row.syncedToHubspot ? (
          <Button
            size="tiny"
            priority="secondary"
            prefixIcon={<Refresh />}
            onClick={() => handleRetry(row._id)}
            disabled={retrying === row._id}
          >
            {retrying === row._id ? '…' : 'Retry'}
          </Button>
        ) : null,
    },
  ];

  return (
    <Box direction="vertical" gap="18px">
      {/* Notification */}
      {notification && (
        <Notification
          theme={notification.theme}
          show
          autoHideTimeout={4000}
          onClose={() => setNotification(null)}
        >
          <Notification.TextLabel>{notification.msg}</Notification.TextLabel>
          <Notification.CloseButton />
        </Notification>
      )}

      {/* Main card */}
      <Card>
        <Card.Header
          title="Form Submissions"
          subtitle={`${total} submission${total !== 1 ? 's' : ''} captured`}
          suffix={
            <Button
              size="small"
              priority="secondary"
              prefixIcon={<Refresh />}
              onClick={load}
              disabled={loading}
            >
              Refresh
            </Button>
          }
        />
        <Card.Divider />
        <Card.Content>
          {submissions.length === 0 ? (
            <EmptyState
              title="No form submissions yet"
              subtitle="Submissions will appear here when visitors fill out forms on your Wix site."
            />
          ) : (
            <Table data={submissions} columns={columns}>
              <Table.Content />
            </Table>
          )}

          {/* Pagination */}
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
    </Box>
  );
}
