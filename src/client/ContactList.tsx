// =============================================================================
// ContactList — Shows synced contacts from Wix ↔ HubSpot in a WDS table
// =============================================================================
import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Badge,
  Button,
  Card,
  EmptyState,
  Heading,
  Input,
  Loader,
  Table,
  Text,
  Tooltip,
  StatisticsWidget,
} from '@wix/design-system';
import {
  Refresh,
  Search,
  ExternalLink,
  StatusCompleteFilled,
} from '@wix/wix-ui-icons-common';
import { getSyncedContacts, type SyncedContact } from './api';

/* ── Props ── */
interface Props {
  connected: boolean;
}

/* ── Component ── */
export default function ContactList({ connected }: Props): React.ReactElement {
  const [contacts, setContacts] = useState<SyncedContact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  /* ── Fetch contacts ── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getSyncedContacts(page, search);
      setContacts(res.contacts);
      setTotal(res.total);
      setPages(res.pages);
    } catch (err) {
      console.error('[ContactList] Failed to load contacts:', err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    if (!connected) return;
    load();
  }, [connected, load]);

  /* ── Search handler ── */
  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  /* ── Not connected ── */
  if (!connected) {
    return (
      <Card>
        <Card.Content>
          <EmptyState
            title="Contacts Unavailable"
            subtitle="Connect your HubSpot account first to view synced contacts."
            theme="section"
          />
        </Card.Content>
      </Card>
    );
  }

  /* ── Loading ── */
  if (loading && contacts.length === 0) {
    return (
      <Box align="center" verticalAlign="middle" height="300px">
        <Loader size="medium" text="Loading contacts…" />
      </Box>
    );
  }

  /* ── Table columns ── */
  const columns = [
    {
      title: 'Name',
      width: '22%',
      render: (row: SyncedContact) => (
        <Text size="small" weight="bold">
          {[row.firstName, row.lastName].filter(Boolean).join(' ') || '—'}
        </Text>
      ),
    },
    {
      title: 'Email',
      width: '24%',
      render: (row: SyncedContact) => (
        <Text size="small">{row.email || '—'}</Text>
      ),
    },
    {
      title: 'Phone',
      width: '14%',
      render: (row: SyncedContact) => (
        <Text size="small">{row.phone || '—'}</Text>
      ),
    },
    {
      title: 'Company',
      width: '14%',
      render: (row: SyncedContact) => (
        <Text size="small">{row.company || '—'}</Text>
      ),
    },
    {
      title: 'Last Synced',
      width: '14%',
      render: (row: SyncedContact) => (
        <Text size="small">
          {row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : '—'}
        </Text>
      ),
    },
    {
      title: 'Source',
      width: '12%',
      render: (row: SyncedContact) => (
        <Badge
          size="small"
          skin={
            row.lastSyncSource === 'wix' ? 'general' :
            row.lastSyncSource === 'hubspot' ? 'standard' : 'neutral'
          }
        >
          {row.lastSyncSource}
        </Badge>
      ),
    },
  ];

  return (
    <Box direction="vertical" gap="18px">
      {/* Header stats */}
      <Card>
        <Card.Content>
          <Box verticalAlign="middle" gap="18px">
            <Box direction="vertical" gap="3px">
              <Heading size="small">Synced Contacts</Heading>
              <Text size="small" secondary>
                {total} contact{total !== 1 ? 's' : ''} mapped between Wix &amp; HubSpot
              </Text>
            </Box>
            <Box marginLeft="auto" gap="12px" verticalAlign="middle">
              {/* Search */}
              <Input
                size="small"
                placeholder="Search by name, email, company…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                prefix={<Input.Affix><Search /></Input.Affix>}
                clearButton
                onClear={() => { setSearchInput(''); setSearch(''); setPage(1); }}
              />
              <Button
                size="small"
                skin="inverted"
                prefixIcon={<Refresh />}
                onClick={load}
              >
                Refresh
              </Button>
            </Box>
          </Box>
        </Card.Content>
      </Card>

      {/* Contact table */}
      <Card>
        <Card.Content>
          {contacts.length === 0 && !loading ? (
            <EmptyState
              title={search ? 'No matches' : 'No synced contacts yet'}
              subtitle={
                search
                  ? 'Try a different search term.'
                  : 'Run a Full Sync from the Sync Status tab to import your contacts.'
              }
              theme="section"
            />
          ) : (
            <>
              <Table data={contacts} columns={columns}>
                <Table.Content />
              </Table>

              {/* Pagination */}
              {pages > 1 && (
                <Box marginTop="12px" align="center" gap="12px" verticalAlign="middle">
                  <Button
                    size="tiny"
                    skin="inverted"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Text size="small" secondary>
                    Page {page} of {pages}
                  </Text>
                  <Button
                    size="tiny"
                    skin="inverted"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  >
                    Next
                  </Button>
                </Box>
              )}
            </>
          )}

          {loading && contacts.length > 0 && (
            <Box align="center" marginTop="12px">
              <Loader size="small" />
            </Box>
          )}
        </Card.Content>
      </Card>
    </Box>
  );
}
