import { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import QrCode from '../storage/QrCode';
import { isInStorage, naturalCompare } from '../storage/common';

// Old "Pallet labels (QR)": one card per location a client currently has
// stock on. Scanning a card opens the Manifest filtered to that pallet, with
// an "Add item to this pallet" button.
export default function StoragePalletLabels() {
  const [items, setItems] = useState(null);
  const [client, setClient] = useState('');

  useEffect(() => { api.get('/storage/items').then((r) => setItems(r.data.items)); }, []);
  useEffect(() => {
    const off = () => document.body.classList.remove('printing-pallet-labels');
    window.addEventListener('afterprint', off);
    return () => { window.removeEventListener('afterprint', off); off(); };
  }, []);

  const clients = useMemo(() => [...new Set((items || []).map((i) => i.client).filter(Boolean))].sort(naturalCompare), [items]);
  const labels = useMemo(() => {
    if (!client || !items) return [];
    const seen = new Map();
    items.filter((i) => i.client === client && i.location && isInStorage(i)).forEach((i) => {
      const key = `${i.storageCentre || ''}|||${i.location}`;
      if (!seen.has(key)) seen.set(key, { centre: i.storageCentre || '', location: i.location, count: 0 });
      seen.get(key).count += 1;
    });
    return [...seen.values()].sort((a, b) => naturalCompare(a.location, b.location) || naturalCompare(a.centre, b.centre));
  }, [items, client]);

  const urlFor = (l) => `${window.location.origin}/storage?${new URLSearchParams({ client, centre: l.centre, location: l.location })}`;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Pallet labels (QR)</h1>
          <div className="subtitle">Print one label per pallet. Scanning a label opens the Manifest showing what's on that pallet.</div>
        </div>
      </div>
      <div className="panel panel-pad label-controls" style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0, minWidth: 260 }}>
          <label>Client</label>
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">— Select a client —</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {labels.length > 0 && (
          <button type="button" className="btn btn-accent" onClick={() => { document.body.classList.add('printing-pallet-labels'); window.print(); }}>
            <Printer size={16} /> Print {labels.length} label{labels.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
      {!items ? <div className="empty-state">Loading…</div> : !client ? null : labels.length === 0 ? (
        <div className="empty-state">This client has no pallets recorded yet.</div>
      ) : (
        <div className="pallet-label-grid">
          {labels.map((l) => (
            <div className="pallet-label" key={`${l.centre}|${l.location}`}>
              <QrCode text={urlFor(l)} title={`QR code for ${l.location}`} />
              <div className="pallet-label-name">{l.location}</div>
              <div className="pallet-label-sub">{client}{l.centre ? ` — ${l.centre}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
