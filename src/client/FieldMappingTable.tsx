// =============================================================================
// FieldMappingTable — WDS-powered field mapping CRUD with bulk save
// =============================================================================
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box,
  Button,
  Card,
  Dropdown,
  EmptyState,
  Heading,
  IconButton,
  Loader,
  Notification,
  Table,
  TableActionCell,
  TableToolbar,
  Text,
  Tooltip,
  SectionHelper,
} from '@wix/design-system';
import {
  Add,
  Delete,
  LockLocked,
  Refresh,
} from '@wix/wix-ui-icons-common';
import {
  getFieldMappings,
  createFieldMapping,
  deleteFieldMapping,
  resetFieldMappings,
  getHubspotProperties,
  getWixFields,
  FieldMappingDto,
} from './api';

/* ── Constants ── */
const DIRECTIONS = [
  { id: 'bidirectional', value: '↔ Bidirectional' },
  { id: 'wix_to_hubspot', value: '→ Wix to HubSpot' },
  { id: 'hubspot_to_wix', value: '← HubSpot to Wix' },
];

const TRANSFORMS = [
  { id: 'none', value: 'None' },
  { id: 'lowercase', value: 'Lowercase' },
  { id: 'uppercase', value: 'Uppercase' },
  { id: 'trim', value: 'Trim' },
  { id: 'phone_e164', value: 'Phone (E.164)' },
];

/* ── Local row type (tracks edits before save) ── */
interface MappingRow extends FieldMappingDto {
  _dirty?: boolean;
  _isNew?: boolean;
}

interface Props {
  connected: boolean;
}

/* ── Component ── */
export default function FieldMappingTable({ connected }: Props): React.ReactElement {
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<MappingRow[]>([]);
  const [wixFields, setWixFields] = useState<Array<{ id: string; value: string }>>([]);
  const [hsProps, setHsProps] = useState<Array<{ id: string; value: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [successMsg, setSuccessMsg] = useState('');

  /* Derived: has any row been changed? */
  const isDirty = useMemo(() => {
    if (rows.length !== savedSnapshot.length) return true;
    return rows.some((r) => r._dirty || r._isNew);
  }, [rows, savedSnapshot]);

  /* ── Load data ── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, wRes, hRes] = await Promise.all([
        getFieldMappings(),
        getWixFields(),
        connected ? getHubspotProperties() : Promise.resolve({ properties: [] }),
      ]);
      const mappings = mRes.mappings.map((m) => ({ ...m }));
      setRows(mappings);
      setSavedSnapshot(mappings.map((m) => ({ ...m })));
      setWixFields(wRes.fields.map((f) => ({ id: f.value, value: f.label })));
      setHsProps(hRes.properties.map((p) => ({ id: p.value, value: p.label })));
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [connected]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  /* ── Row mutation helpers ── */
  const updateRow = (index: number, patch: Partial<MappingRow>) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch, _dirty: true } : r)),
    );
  };

  const addRow = () => {
    const newRow: MappingRow = {
      _id: `_new_${Date.now()}`,
      wixField: '',
      hubspotField: '',
      direction: 'bidirectional',
      transform: 'none',
      isDefault: false,
      isActive: true,
      _dirty: true,
      _isNew: true,
    };
    setRows((prev) => [...prev, newRow]);
  };

  const removeRow = async (index: number) => {
    const row = rows[index];
    if (row._isNew) {
      setRows((prev) => prev.filter((_, i) => i !== index));
      return;
    }
    try {
      await deleteFieldMapping(row._id);
      await load();
    } catch {
      // swallow
    }
  };

  /* ── Validate before save ── */
  const validate = (): string[] => {
    const errs: string[] = [];
    const hsUsed = new Set<string>();

    rows.forEach((r, i) => {
      if (!r.wixField) errs.push(`Row ${i + 1}: Wix field is required.`);
      if (!r.hubspotField) errs.push(`Row ${i + 1}: HubSpot property is required.`);
      if (r.hubspotField && hsUsed.has(r.hubspotField)) {
        errs.push(`Row ${i + 1}: Duplicate HubSpot property "${r.hubspotField}".`);
      }
      if (r.hubspotField) hsUsed.add(r.hubspotField);
    });

    return errs;
  };

  /* ── Save all changes ── */
  const handleSave = async () => {
    setErrors([]);
    setSuccessMsg('');
    const validationErrors = validate();
    if (validationErrors.length) {
      setErrors(validationErrors);
      return;
    }
    setSaving(true);
    try {
      // Save new rows via create, dirty existing via individual calls handled by bulk approach:
      // We'll create new rows and update dirty existing rows
      const promises = rows.map(async (r) => {
        if (r._isNew) {
          return createFieldMapping({
            wixField: r.wixField,
            hubspotField: r.hubspotField,
            direction: r.direction,
            transform: r.transform,
          });
        }
        if (r._dirty) {
          const { updateFieldMapping } = await import('./api');
          return updateFieldMapping(r._id, {
            wixField: r.wixField,
            hubspotField: r.hubspotField,
            direction: r.direction,
            transform: r.transform,
            isActive: r.isActive,
          });
        }
        return null;
      });
      await Promise.all(promises);
      await load();
      setSuccessMsg('Field mappings saved successfully.');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  /* ── Reset to defaults ── */
  const handleReset = async () => {
    try {
      const res = await resetFieldMappings();
      const mappings = res.mappings.map((m) => ({ ...m }));
      setRows(mappings);
      setSavedSnapshot(mappings.map((m) => ({ ...m })));
      setErrors([]);
      setSuccessMsg('Mappings reset to defaults.');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch {
      // swallow
    }
  };

  /* ── Not connected state ── */
  if (!connected) {
    return (
      <Card>
        <Card.Content>
          <EmptyState
            title="Field Mapping Unavailable"
            subtitle="Connect your HubSpot account first to configure field mappings."
            theme="section"
          />
        </Card.Content>
      </Card>
    );
  }

  /* ── Loading state ── */
  if (loading) {
    return (
      <Box align="center" verticalAlign="middle" height="300px">
        <Loader size="medium" text="Loading field mappings…" />
      </Box>
    );
  }

  /* ── Table columns ── */
  const columns = [
    {
      title: '',
      width: '40px',
      render: (row: MappingRow) =>
        row.isDefault ? (
          <Tooltip content="Default mapping — cannot be deleted">
            <Box align="center">
              <LockLocked />
            </Box>
          </Tooltip>
        ) : null,
    },
    {
      title: 'Wix Field',
      width: '22%',
      render: (row: MappingRow, rowNum: number) => (
        <Dropdown
          size="small"
          placeholder="Select Wix field"
          selectedId={row.wixField}
          options={wixFields}
          onSelect={(option) => updateRow(rowNum, { wixField: option.id as string })}
          disabled={row.isDefault}
        />
      ),
    },
    {
      title: 'HubSpot Property',
      width: '22%',
      render: (row: MappingRow, rowNum: number) => (
        <Dropdown
          size="small"
          placeholder="Select property"
          selectedId={row.hubspotField}
          options={hsProps}
          onSelect={(option) => updateRow(rowNum, { hubspotField: option.id as string })}
          disabled={row.isDefault}
        />
      ),
    },
    {
      title: 'Direction',
      width: '20%',
      render: (row: MappingRow, rowNum: number) => (
        <Dropdown
          size="small"
          selectedId={row.direction}
          options={DIRECTIONS}
          onSelect={(option) => updateRow(rowNum, { direction: option.id as string })}
        />
      ),
    },
    {
      title: 'Transform',
      width: '18%',
      render: (row: MappingRow, rowNum: number) => (
        <Dropdown
          size="small"
          selectedId={row.transform}
          options={TRANSFORMS}
          onSelect={(option) => updateRow(rowNum, { transform: option.id as string })}
        />
      ),
    },
    {
      title: '',
      width: '48px',
      render: (row: MappingRow, rowNum: number) =>
        row.isDefault ? (
          <Tooltip content="Cannot delete default mapping">
            <div>
              <IconButton size="small" priority="secondary" disabled>
                <Delete />
              </IconButton>
            </div>
          </Tooltip>
        ) : (
          <IconButton
            size="small"
            priority="secondary"
            skin="destructive"
            onClick={() => removeRow(rowNum)}
          >
            <Delete />
          </IconButton>
        ),
    },
  ];

  return (
    <Box direction="vertical" gap="18px">
      {/* Success notification */}
      {successMsg && (
        <Notification
          theme="success"
          show
          autoHideTimeout={4000}
          onClose={() => setSuccessMsg('')}
        >
          <Notification.TextLabel>{successMsg}</Notification.TextLabel>
          <Notification.CloseButton />
        </Notification>
      )}

      {/* Validation errors */}
      {errors.length > 0 && (
        <SectionHelper appearance="danger" title="Validation Errors">
          {errors.map((e, i) => (
            <Text key={i} size="small" skin="error" tagName="div">
              {e}
            </Text>
          ))}
        </SectionHelper>
      )}

      {/* Info helper */}
      <SectionHelper
        appearance="standard"
        title="About Field Mappings"
      >
        <Text size="small">
          Each row maps a Wix contact field to a HubSpot property. Default
          mappings (locked rows) ensure core fields like name and email always
          sync. Add custom rows to sync additional data.
        </Text>
      </SectionHelper>

      {/* Table card */}
      <Card>
        <Card.Header
          title="Field Mappings"
          subtitle={`${rows.length} mapping${rows.length !== 1 ? 's' : ''} configured`}
          suffix={
            <Box gap="8px">
              <Button
                size="small"
                priority="secondary"
                prefixIcon={<Refresh />}
                onClick={handleReset}
              >
                Reset to Defaults
              </Button>
              <Button size="small" prefixIcon={<Add />} onClick={addRow}>
                Add Row
              </Button>
            </Box>
          }
        />
        <Card.Divider />
        <Card.Content>
          <Table data={rows} columns={columns}>
            <Table.Content />
          </Table>
        </Card.Content>
      </Card>

      {/* Save button */}
      <Box align="right">
        <Button
          skin="standard"
          priority="primary"
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save Mappings'}
        </Button>
      </Box>
    </Box>
  );
}
