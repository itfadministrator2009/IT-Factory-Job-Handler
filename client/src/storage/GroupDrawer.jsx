import { useEffect, useMemo, useState } from 'react';
import { Edit3, Printer } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import NotesPanel from './NotesPanel';
import { GROUP_FIELDS, dmy, money, itemStatus, isInStorage, naturalCompare, palletRateFor } from './common';

// The old app's group drawer (double-click a client, job #, PO, centre or
// location cell): every item sharing that value, how each is billed, notes on
// the group, and "Bulk edit these items".
export default function GroupDrawer({ field, value, items, onClose, onOpenItem, onBulkEdit }) {
  const label = GROUP_FIELDS.find(([k]) => k === field)?.[1] || field;
  const [pallets, setPallets] = useState([]);
  const [onlyInStorage, setOnlyInStorage] = useState(false);
  useEffect(() => { api.get('/storage/pallets').then((r) => setPallets(r.data.pallets)).catch(() => {}); }, []);

  const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const all = useMemo(() => items.filter((i) => norm(i[field]) === norm(value))
    .sort((a, b) => naturalCompare(a.client, b.client) || naturalCompare(a.location, b.location) || naturalCompare(a.item, b.item)), [items, field, value]);
  const rows = onlyInStorage ? all.filter(isInStorage) : all;
  const inStorage = all.filter(isInStorage);
  const qty = inStorage.reduce((t, i) => t + (Number(i.quantity) || 0), 0);

  const billedAs = (i) => {
    const p = palletRateFor(pallets, i);
    if (p) return `Pallet rate (${money(p.priceWeek)}/wk)`;
    return Number(i.priceWeek) > 0 ? `Per item (${money(i.priceWeek)}/wk)` : 'Per item ($0 — no rate)';
  };

  return (
    <Drawer title={`${label}: ${value}`} subtitle={`${all.length} item(s) on record · ${inStorage.length} in storage${qty ? ` · total quantity ${qty}` : ''}`} onClose={onClose} width={1100}>
      <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" className="btn btn-accent btn-sm" disabled={!all.length} onClick={() => onBulkEdit(all)}><Edit3 size={14} /> Bulk edit these items</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginLeft: 'auto' }}>
          <input type="checkbox" checked={onlyInStorage} onChange={(e) => setOnlyInStorage(e.target.checked)} /> Only items in storage
        </label>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="ticket-table">
          <thead><tr><th>Client</th><th>Job #</th><th>Item</th><th>Make / model</th><th>Serial</th><th>Location</th><th>Billed as</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => onOpenItem(i)} title="Open this item">
                <td>{i.client}</td><td>{i.jobNumber}</td><td>{i.item}</td>
                <td>{[i.make, i.model].filter(Boolean).join(' ')}</td>
                <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{i.serial}</td>
                <td>{[i.storageCentre, i.location].filter(Boolean).join(' · ')}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{billedAs(i)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.startDate)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.endDate)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{itemStatus(i)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)', padding: 20 }}>No items.</td></tr>}
          </tbody>
        </table>
      </div>
      <NotesPanel keys={[`${field}:${String(value).trim()}`]} addKey={`${field}:${String(value).trim()}`} title={`Notes on this ${label.toLowerCase()} (shown on all its items)`} />
    </Drawer>
  );
}
