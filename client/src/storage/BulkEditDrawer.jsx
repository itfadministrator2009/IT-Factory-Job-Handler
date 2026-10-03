import { useState } from 'react';
import api from '../api';
import Drawer from './Drawer';

// Old "Bulk edit these items": the same values written to every selected item.
// Unlike the old form, only the fields you tick are changed, so a blank field
// can't wipe data by accident.
const FIELDS = [
  ['jobNumber', 'Job number', 'text'],
  ['referenceNumber', 'Reference number', 'text'],
  ['poNumber', 'PO #', 'text'],
  ['orderNumber', 'Order #', 'text'],
  ['storageCentre', 'ITF storage centre', 'text'],
  ['location', 'Location', 'text'],
  ['priceWeek', 'Storage price per week (ex GST)', 'number'],
  ['startDate', 'Storage start date', 'date'],
  ['endDate', 'Storage end date', 'date'],
];

export default function BulkEditDrawer({ items, onClose, onDone }) {
  const first = items[0] || {};
  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map(([k]) => [k, first[k] ?? ''])));
  const [enabled, setEnabled] = useState(() => new Set());
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function apply(e) {
    e.preventDefault();
    const updates = {};
    enabled.forEach((k) => { updates[k] = values[k]; });
    if (status) { updates.status = status; delete updates.endDate; }
    const labels = [...FIELDS.filter(([k]) => k in updates).map(([, l]) => l), ...(status ? ['Status'] : [])];
    if (!labels.length) { setError('Tick at least one field to change.'); return; }
    if (!confirm(`Apply ${labels.join(', ')} to all ${items.length} selected item(s)?`)) return;
    setSaving(true); setError('');
    try {
      await api.patch('/storage/items/bulk-edit', { ids: items.map((i) => i.id), updates });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update the items');
      setSaving(false);
    }
  }

  return (
    <Drawer title={`Bulk edit ${items.length} item(s)`} subtitle="Tick the fields to change. A ticked field left blank clears that value on every selected item." onClose={onClose} busy={saving} width={620}>
      <form onSubmit={apply}>
        {error && <div className="error-banner">{error}</div>}
        {FIELDS.map(([k, label, type]) => (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '24px 200px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input type="checkbox" checked={enabled.has(k)} disabled={k === 'endDate' && !!status}
              onChange={() => setEnabled((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
            <label style={{ fontSize: 13, fontWeight: 600 }}>{label}</label>
            <input type={type} step={type === 'number' ? '0.01' : undefined} value={values[k] ?? ''} disabled={!enabled.has(k) || (k === 'endDate' && !!status)}
              onChange={(e) => setValues((p) => ({ ...p, [k]: e.target.value }))}
              style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px' }} />
          </div>
        ))}
        <div className="field" style={{ marginTop: 12 }}>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">— Leave unchanged —</option>
            <option value="in">In storage (clears end date)</option>
            <option value="out">Out of Storage (sets end date to today)</option>
          </select>
        </div>
        <button className="btn btn-accent" type="submit" disabled={saving}>{saving ? 'Applying…' : 'Apply to all selected items'}</button>
      </form>
    </Drawer>
  );
}
