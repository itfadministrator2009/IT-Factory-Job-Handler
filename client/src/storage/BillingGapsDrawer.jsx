import { useEffect, useState } from 'react';
import api from '../api';
import Drawer from './Drawer';
import { isInStorage, itemStatus } from './common';

// Old "Billing gaps" drawer: items costing $0/week — no rate of their own and
// no pallet rate covering their location.
export default function BillingGapsDrawer({ onClose, onEdit }) {
  const [items, setItems] = useState(null);
  const [onlyInStorage, setOnlyInStorage] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get('/storage/billing-gaps').then((r) => setItems(r.data.items)).catch(() => setError('Could not load billing gaps'));
  }, []);
  const rows = (items || []).filter((i) => !onlyInStorage || isInStorage(i));

  return (
    <Drawer title="Billing gaps" subtitle="Items currently costing $0/wk — no rate set on the item itself, and no flat pallet rate covers its pallet either. Worth checking before an invoice run." onClose={onClose} width={900}>
      {error && <div className="error-banner">{error}</div>}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 10 }}>
        <input type="checkbox" checked={onlyInStorage} onChange={(e) => setOnlyInStorage(e.target.checked)} /> Only items in storage
      </label>
      {!items ? <div className="empty-state">Loading…</div> : rows.length === 0 ? (
        <div className="empty-state">No billing gaps found — every item has a rate, either directly or via its pallet.</div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>{rows.length} item{rows.length === 1 ? '' : 's'}</div>
          <table className="ticket-table">
            <thead><tr><th>Client</th><th>Job #</th><th>Item</th><th>Serial</th><th>Storage centre</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={onEdit ? 'clickable' : undefined} onClick={() => onEdit?.(i)} title={onEdit ? 'Open this item' : undefined}>
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
