import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import { money, naturalCompare } from './common';

// Old "Individual item rates" drawer: pick a client, search their items, and
// set one item's weekly rate (ex GST).
export default function ItemRatesDrawer({ items, userName, onClose, onSaved }) {
  const clients = useMemo(() => [...new Set(items.map((i) => i.client).filter(Boolean))].sort(naturalCompare), [items]);
  const [client, setClient] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [rate, setRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const rows = useMemo(() => {
    if (!client) return [];
    const q = query.trim().toLowerCase();
    return items.filter((i) => i.client === client)
      .filter((i) => !q || [i.jobNumber, i.item, i.serial, i.make, i.model].join(' ').toLowerCase().includes(q))
      .sort((a, b) => naturalCompare(a.jobNumber, b.jobNumber) || naturalCompare(a.item, b.item));
  }, [items, client, query]);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await api.patch(`/storage/items/${editing.id}`, { priceWeek: Number(rate) || 0, lastEditedBy: userName });
      setEditing(null);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save the rate');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer title="Individual item rates" subtitle="Set or change the weekly rate (ex GST) for a single item. Select a client, then search within their items if needed." onClose={onClose} busy={saving}>
      {editing ? (
        <form onSubmit={save} style={{ maxWidth: 360 }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
            {[editing.client, editing.item, editing.serial && `S/N ${editing.serial}`].filter(Boolean).join(' — ')}
          </p>
          {error && <div className="error-banner">{error}</div>}
          <div className="field"><label>Weekly rate (ex GST)</label>
            <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-accent" disabled={saving}>{saving ? 'Saving…' : 'Save rate'}</button>
          </div>
        </form>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div className="field" style={{ margin: 0, minWidth: 220 }}>
              <label>Client</label>
              <select value={client} onChange={(e) => setClient(e.target.value)}>
                <option value="">— Select a client —</option>
                {clients.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
              <label>Search</label>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by item, job #, serial…" disabled={!client} />
            </div>
          </div>
          {client && (rows.length === 0 ? <div className="empty-state">No items match.</div> : (
            <table className="ticket-table">
              <thead><tr><th>Job #</th><th>Item</th><th>Serial</th><th>Storage centre</th><th style={{ textAlign: 'right' }}>$/wk ex GST</th><th></th></tr></thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td>{i.jobNumber}</td><td>{i.item}</td><td>{i.serial}</td><td>{i.storageCentre}</td>
                    <td style={{ textAlign: 'right' }}>{Number(i.priceWeek) > 0 ? money(i.priceWeek) : '—'}</td>
                    <td><button type="button" className="btn btn-ghost btn-sm icon-btn" title="Edit rate" onClick={() => { setEditing(i); setRate(i.priceWeek ?? ''); setError(''); }}><Pencil size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </>
      )}
    </Drawer>
  );
}
