import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import { isInStorage, itemStatus } from './common';

// Old "Billing gaps" drawer: items costing $0/week — no rate of their own and
// no pallet rate covering their location. Click a row to edit that item, or
// tick several and bulk edit them (e.g. give them all a weekly rate).
export default function BillingGapsDrawer({ onClose, onEdit, onBulkEdit, initialOnlyInStorage = false, onOnlyInStorageChange, initialClient = '', onClientChange }) {
  const [items, setItems] = useState(null);
  const [onlyInStorage, setOnlyInStorage] = useState(initialOnlyInStorage);
  const [client, setClient] = useState(initialClient);
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/storage/billing-gaps').then((r) => setItems(r.data.items)).catch(() => setError('Could not load billing gaps'));
  }, []);
  const shown = (items || []).filter((i) => !onlyInStorage || isInStorage(i));
  // Clients with gaps (after the in-storage tick), with how many each — for the client picker.
  const clientCounts = [...shown.reduce((m, i) => { const c = String(i.client || '').trim(); m.set(c, (m.get(c) || 0) + 1); return m; }, new Map())]
    .filter(([c]) => c !== '')
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  const rows = client ? shown.filter((i) => String(i.client || '').trim() === client) : shown;
  // Only rows still on screen count as selected (e.g. after changing the tick box).
  const chosen = rows.filter((i) => selected.has(i.id));
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  function toggle(id) {
    setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(allChosen ? new Set() : new Set(rows.map((i) => i.id)));
  }
  function setInStorage(v) {
    setOnlyInStorage(v);
    onOnlyInStorageChange?.(v);
  }
  function pickClient(v) {
    setClient(v);
    onClientChange?.(v);
  }
  function selectClient(c) {
    // Pick a client and tick all of their items, ready to bulk edit.
    pickClient(c);
    setSelected(new Set(shown.filter((i) => String(i.client || '').trim() === c).map((i) => i.id)));
  }

  return (
    <Drawer title="Billing gaps" subtitle="Items currently costing $0/wk — no rate set on the item itself, and no flat pallet rate covers its pallet either. Click an item to edit it, or tick several to bulk edit them." onClose={onClose} width={960}>
      {error && <div className="error-banner">{error}</div>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={onlyInStorage} onChange={(e) => setInStorage(e.target.checked)} /> Only items in storage
        </label>
        <select value={client} onChange={(e) => pickClient(e.target.value)} style={{ minWidth: 200 }} aria-label="Client">
          <option value="">All clients ({shown.length})</option>
          {clientCounts.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
          {client && !clientCounts.some(([c]) => c === client) && <option value={client}>{client} (0)</option>}
        </select>
        {onBulkEdit && client && rows.length > 0 && chosen.length !== rows.length && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => selectClient(client)}>Select all {rows.length} for {client}</button>
        )}
        {onBulkEdit && (
          <button type="button" className="btn btn-accent btn-sm" style={{ marginLeft: 'auto' }} disabled={chosen.length === 0} onClick={() => onBulkEdit(chosen)}>
            <Pencil size={14} /> Bulk edit {chosen.length ? `${chosen.length} selected` : 'selected'}
          </button>
        )}
      </div>
      {!items ? <div className="empty-state">Loading…</div> : rows.length === 0 ? (
        <div className="empty-state">No billing gaps found — every item has a rate, either directly or via its pallet.</div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>{rows.length} item{rows.length === 1 ? '' : 's'}{chosen.length ? ` · ${chosen.length} selected` : ''}</div>
          <table className="ticket-table">
            <thead><tr>
              {onBulkEdit && <th style={{ width: 32 }}><input type="checkbox" checked={allChosen} onChange={toggleAll} title="Select all" /></th>}
              <th>Client</th><th>Job #</th><th>Item</th><th>Serial</th><th>Storage centre</th><th>Location</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={onEdit ? 'clickable' : undefined} onClick={() => onEdit?.(i)} title={onEdit ? 'Open this item' : undefined}
                  style={selected.has(i.id) ? { background: 'var(--accent-soft, #fdf0e8)' } : undefined}>
                  {onBulkEdit && (
                    <td onClick={(e) => { e.stopPropagation(); toggle(i.id); }} style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} />
                    </td>
                  )}
                  <td>{i.client}</td><td>{i.jobNumber}</td><td>{i.item}</td><td>{i.serial}</td><td>{i.storageCentre}</td><td>{i.location}</td><td>{itemStatus(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Drawer>
  );
}
