import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, KeyRound, Search, FileText, X, Plus, Download, Printer } from 'lucide-react';
import portalApi, { clearPortalSession, getPortalClient } from '../portal/portalApi';
import { openPdf } from '../utils/pdf';
import { countByText } from '../storage/common';

const TABS = [
  { id: 'stock', label: 'Stock on hand' },
  { id: 'orders', label: 'Orders' },
  { id: 'new', label: 'New order' },
  { id: 'movements', label: 'Receiving / dispatch' },
];

function dmy(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
}

function StatusPill({ status }) {
  const colours = {
    Pending: ['#fbf1dc', 'var(--amber, #b7791f)'],
    'In Progress': ['#e6edf9', 'var(--blue, #2b5cad)'],
    Delivered: ['#e6f2e8', 'var(--green, #2f7a44)'],
    Cancelled: ['#eee', '#777'],
  };
  const [bg, fg] = colours[status] || ['#eee', '#555'];
  return <span className="pill" style={{ background: bg, color: fg }}>{status}</span>;
}

function downloadCsv(filename, rows) {
  const cell = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// "Natural" order so "Pallet 2" sorts before "Pallet 10", like the old portal.
const naturalCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });

function ItemStatus({ status }) {
  if (!status) return null;
  const inStorage = status === 'In storage';
  return (
    <span style={{ background: inStorage ? '#DDEEFB' : '#E1F0E6', color: inStorage ? '#2C6FA8' : '#2F7A44', padding: '3px 9px', borderRadius: 5, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

function StockTab() {
  const [items, setItems] = useState(null);
  const [onlyInStorage, setOnlyInStorage] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    portalApi.get('/items')
      // Number order for locations (Pallet 2 before Pallet 10), then by device.
      .then((res) => setItems([...res.data.items].sort((a, b) => naturalCompare(a.storageCentre, b.storageCentre)
        || naturalCompare(a.location, b.location) || naturalCompare(a.item, b.item) || naturalCompare(a.serial, b.serial))))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your stock'));
  }, []);

  // Same searchable fields as the old portal.
  const visible = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (onlyInStorage && i.status !== 'In storage') return false;
      if (!q) return true;
      return [i.item, i.make, i.model, i.serial, i.assetTag, i.poNumber, i.orderNumber, i.storageCentre, i.location, i.condition, dmy(i.startDate)]
        .join(' ').toLowerCase().includes(q);
    });
  }, [items, query, onlyInStorage]);

  // Count by item type (quantities summed), as the old portal's chips showed.
  const breakdown = useMemo(() => {
    // "MONITOR" and "Monitor" are one type.
    return countByText(visible || [], (i) => i.item, (i) => Number(i.quantity) || 1, '(no item type)');
  }, [visible]);

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 460 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search item, make, model, serial, asset tag, PO, order, location…" style={{ paddingLeft: 30, width: '100%' }} />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={onlyInStorage} onChange={(e) => setOnlyInStorage(e.target.checked)} /> Only items in storage
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!visible || visible.length === 0}
            onClick={() => downloadCsv('storage-items.csv', [
              ['Item', 'Make', 'Model', 'Serial', 'Asset Tag', 'PO Number', 'Order Number', 'Storage centre', 'Location', 'Qty', 'Condition', 'Status', 'Start', 'End'],
              ...visible.map((i) => [i.item, i.make, i.model, i.serial, i.assetTag, i.poNumber, i.orderNumber, i.storageCentre, i.location, i.quantity, i.condition, i.status, dmy(i.startDate), dmy(i.endDate)]),
            ])}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>
      {breakdown.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {breakdown.map(([k, n]) => (
            <span key={k} style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e3e1d9)', borderRadius: 999, padding: '3px 10px', fontSize: 12 }}>
              {k}: <strong>{n}</strong>
            </span>
          ))}
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      <div className="panel" style={{ padding: 0 }}>
        {!visible ? <div className="empty-state">Loading…</div> : visible.length === 0 ? (
          <div className="empty-state"><h3>No items match</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>Item</th><th>Make</th><th>Model</th><th>Serial</th><th>Asset Tag</th><th>PO #</th><th>Order #</th><th>Storage centre</th><th>Location</th><th>Qty</th><th>Condition</th><th>Status</th><th>Start</th><th>End</th></tr></thead>
              <tbody>
                {visible.map((i) => (
                  <tr key={i.id}>
                    <td>{i.item}</td>
                    <td>{i.make}</td>
                    <td>{i.model}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{i.serial}</td>
                    <td>{i.assetTag}</td>
                    <td>{i.poNumber}</td>
                    <td>{i.orderNumber}</td>
                    <td>{i.storageCentre}</td>
                    <td>{i.location}</td>
                    <td>{i.quantity}</td>
                    <td>{i.condition}</td>
                    <td><ItemStatus status={i.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.startDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.endDate) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
function OrdersTab({ refreshKey }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    portalApi.get('/orders').then((res) => setOrders(res.data.orders))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your orders'));
  }, [refreshKey]);

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div className="panel" style={{ padding: 0 }}>
        {!orders ? <div className="empty-state">Loading…</div> : orders.length === 0 ? (
          <div className="empty-state"><h3>No orders yet</h3><p>Use “New order” to request a delivery.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>Order</th><th>Submitted</th><th>Deliver by</th><th>Status</th><th>Tracking</th><th>Deliver to</th><th>Devices</th><th></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{o.orderNumber}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(o.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(o.dateToBeDelivered)}</td>
                    <td><StatusPill status={o.status} /></td>
                    <td>{o.trackingNumber || '—'}</td>
                    <td style={{ maxWidth: 220 }}>{o.deliveryAddress}</td>
                    <td style={{ maxWidth: 320, whiteSpace: 'pre-wrap', fontSize: 12 }}>{o.devices}</td>
                    <td>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Order PDF"
                        onClick={() => openPdf(portalApi, `/orders/${o.id}/pdf`).catch((err) => alert(err.message))}>
                        <FileText size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
const EMPTY_ORDER = { requestedBy: '', deliveryAddress: '', siteContactName: '', siteContactPhone: '', dateToBeDelivered: '', configInformation: '', notes: '' };

function deviceLabel(i) {
  return `${i.item || 'Item'} — ${[i.make, i.model].filter(Boolean).join(' ')}${i.serial ? ` (S/N ${i.serial})` : ''}`;
}

// Like the old portal: only devices currently in storage can be ordered; those
// on a location classified as a pallet are grouped by pallet with a "select
// the whole pallet" box, and everything else is listed underneath.
function NewOrderTab({ onSubmitted }) {
  const [form, setForm] = useState(EMPTY_ORDER);
  const [items, setItems] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  function loadItems() {
    portalApi.get('/items').then((res) => setItems(res.data.items.filter((i) => i.status === 'In storage'))).catch(() => setItems([]));
  }
  useEffect(() => { loadItems(); }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const deviceTypes = useMemo(() => [...new Set((items || []).map((i) => i.item).filter(Boolean))].sort(naturalCompare), [items]);

  const matches = (i) => {
    if (typeFilter && (i.item || '').toLowerCase() !== typeFilter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [i.item, i.make, i.model, i.serial].filter(Boolean).join(' ').toLowerCase().includes(q);
  };

  // Pallets in number order (Pallet 1, 2, 3 … 10, 11). A location counts as a
  // pallet if it's ticked as one on the Locations page, or its name says
  // "pallet" — so a pallet that hasn't been ticked yet still gets its own
  // heading instead of dropping into the list below. Everything is sorted the
  // same "natural" way, so 2 comes before 10.
  const { palletGroups, loose } = useMemo(() => {
    const groups = {};
    const rest = [];
    const tidy = (s) => String(s || '').trim().replace(/\s+/g, ' ');
    const byDevice = (a, b) => naturalCompare(a.item, b.item) || naturalCompare(a.make, b.make)
      || naturalCompare(a.model, b.model) || naturalCompare(a.serial, b.serial);
    (items || []).forEach((i) => {
      const loc = tidy(i.location);
      if (loc && (i.onPallet || /\bpallet\b/i.test(loc))) {
        const key = `${tidy(i.storageCentre).toLowerCase()}|||${loc.toLowerCase()}`;
        if (!groups[key]) groups[key] = { key, label: loc, centre: tidy(i.storageCentre), items: [] };
        groups[key].items.push(i);
      } else rest.push(i);
    });
    const list = Object.values(groups);
    list.forEach((g) => g.items.sort(byDevice));
    list.sort((a, b) => naturalCompare(a.label, b.label) || naturalCompare(a.centre, b.centre));
    // Same pallet number at two storage centres: say which centre each one is at.
    list.forEach((g) => {
      g.title = g.label;
      if (g.centre && list.some((h) => h !== g && h.label.toLowerCase() === g.label.toLowerCase())) g.title = `${g.label} — ${g.centre}`;
    });
    rest.sort((a, b) => naturalCompare(tidy(a.location), tidy(b.location)) || byDevice(a, b));
    return { palletGroups: list, loose: rest };
  }, [items]);

  function toggle(id) {
    setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleGroup(group, on) {
    setPicked((prev) => { const n = new Set(prev); group.items.forEach((i) => (on ? n.add(i.id) : n.delete(i.id))); return n; });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (picked.size === 0) { setError('Select at least one device before submitting.'); return; }
    setSaving(true);
    try {
      const { data } = await portalApi.post('/orders', { ...form, deviceIds: [...picked] });
      setDone(data.order);
      setForm(EMPTY_ORDER);
      setPicked(new Set());
      onSubmitted();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit the order');
      if (err.response?.status === 400) loadItems();
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="panel">
        <h3 style={{ marginBottom: 6 }}>Order {done.orderNumber} submitted</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>Thanks — the IT Factory team has your request and will be in touch. You can follow its status under Orders.</p>
        <button type="button" className="btn btn-accent" onClick={() => { setDone(null); loadItems(); }}><Plus size={16} /> Another order</button>
      </div>
    );
  }

  const deviceRow = (i) => (
    <label key={i.id} style={{ display: matches(i) ? 'flex' : 'none', gap: 8, alignItems: 'center', padding: '4px 8px', fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
      <span>{deviceLabel(i)}</span>
    </label>
  );

  return (
    <form onSubmit={handleSubmit} className="panel">
      {error && <div className="error-banner">{error}</div>}
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Select devices for this order</h3>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <div className="field" style={{ margin: 0, minWidth: 200 }}>
          <label>Filter by device type</label>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {deviceTypes.map((t) => <option key={t} value={t.toLowerCase()}>{t}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: '1 1 240px' }}>
          <label>Search</label>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by make, model, or serial…" />
        </div>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 6, padding: 6, marginBottom: 6 }}>
        {!items ? <div style={{ padding: 8, color: 'var(--muted)' }}>Loading…</div> : items.length === 0 ? (
          <div style={{ padding: 8, color: 'var(--muted)' }}>No devices currently in storage.</div>
        ) : (
          <>
            {palletGroups.map((g) => {
              const visibleItems = g.items.filter(matches);
              if (!visibleItems.length) return null;
              const n = g.items.filter((i) => picked.has(i.id)).length;
              return (
                <div key={g.key} style={{ marginBottom: 6, border: '1px solid var(--line, #eee)', borderRadius: 6 }}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', fontWeight: 600, fontSize: 13, background: 'var(--bg, #f6f5f1)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={n === g.items.length}
                      ref={(el) => { if (el) el.indeterminate = n > 0 && n < g.items.length; }}
                      onChange={(e) => toggleGroup(g, e.target.checked)} />
                    Pallet: {g.title} ({g.items.length} item{g.items.length === 1 ? '' : 's'})
                  </label>
                  {g.items.map(deviceRow)}
                </div>
              );
            })}
            {loose.some(matches) && palletGroups.length > 0 && (
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', padding: '8px 8px 2px' }}>Not on a pallet</div>
            )}
            {loose.map(deviceRow)}
          </>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>{picked.size} selected</div>

      <div className="form-grid">
        <div className="field span-2"><label>Delivery address *</label><textarea rows={2} value={form.deliveryAddress} onChange={set('deliveryAddress')} required maxLength={500} placeholder="Where should these devices be sent?" /></div>
        <div className="field"><label>Site contact name</label><input value={form.siteContactName} onChange={set('siteContactName')} maxLength={200} /></div>
        <div className="field"><label>Site contact phone</label><input type="tel" value={form.siteContactPhone} onChange={set('siteContactPhone')} maxLength={60} /></div>
        <div className="field"><label>Date to be delivered</label><input type="date" value={form.dateToBeDelivered} onChange={set('dateToBeDelivered')} /></div>
        <div className="field"><label>Requestor</label><input value={form.requestedBy} onChange={set('requestedBy')} maxLength={200} placeholder="Name of the person placing this order" /></div>
        <div className="field span-2"><label>Configuration information</label><textarea rows={2} value={form.configInformation} onChange={set('configInformation')} maxLength={4000} placeholder="Any setup, imaging, or configuration instructions" /></div>
        <div className="field span-2"><label>Additional notes</label><textarea rows={2} value={form.notes} onChange={set('notes')} maxLength={4000} placeholder="Anything else IT Factory should know" /></div>
      </div>
      <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 12 }}>{saving ? 'Submitting…' : 'Submit order'}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
function MovementsTab() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    portalApi.get('/receiving-dispatch').then((res) => setEntries(res.data.entries))
      .catch((err) => setError(err.response?.data?.error || 'Could not load receiving/dispatch history'));
  }, []);
  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div className="panel" style={{ padding: 0 }}>
        {!entries ? <div className="empty-state">Loading…</div> : entries.length === 0 ? (
          <div className="empty-state"><h3>No receiving or dispatch records yet</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>Received</th><th>Stock received</th><th>Dispatched</th><th>Stock dispatched</th><th>Notes</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(e.dateReceived)}</td>
                    <td>{e.stockReceived}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(e.dateDispatched)}</td>
                    <td>{e.stockDispatched}</td>
                    <td style={{ maxWidth: 420, whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--muted)' }}>{[e.receivingNotes, e.dispatchNotes].filter(Boolean).join('\n')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
function ChangePassword({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (next !== confirmNext) { setError('The new passwords don’t match'); return; }
    setSaving(true);
    try {
      await portalApi.post('/change-password', { currentPassword: current, newPassword: next });
      setOk(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not change your password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !saving && onClose()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3>Change password</h3>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        {ok ? (
          <p>Your password has been changed.</p>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div className="error-banner">{error}</div>}
            <div className="field"><label>Current password</label><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></div>
            <div className="field"><label>New password (8+ characters)</label><input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required /></div>
            <div className="field"><label>Confirm new password</label><input type="password" autoComplete="new-password" minLength={8} value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} required /></div>
            <button className="btn btn-accent" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Portal() {
  const navigate = useNavigate();
  const [client, setClient] = useState(getPortalClient());
  const [tab, setTab] = useState('stock');
  const [ordersKey, setOrdersKey] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    portalApi.get('/me').then((res) => setClient(res.data.client)).catch(() => {});
    portalApi.get('/summary').then((res) => setCounts(res.data)).catch(() => {});
  }, [ordersKey]);

  function signOut() {
    clearPortalSession();
    navigate('/portal/login', { replace: true });
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f6f5f1)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 24px', background: 'var(--surface, #fff)', borderBottom: '1px solid var(--line, #e3e1d9)', flexWrap: 'wrap' }}>
        <img src="/logo.png" alt="IT Factory" style={{ height: 34 }} />
        <div>
          <div style={{ fontWeight: 700 }}>Storage Centre</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{client?.name}</div>
        </div>
        {counts && (
          <div style={{ display: 'flex', gap: 20, marginLeft: 16 }}>
            <div><div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{counts.inStorageCount}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>items in storage</div></div>
            <div><div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{counts.palletCount}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>pallets</div></div>
            <div><div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>{counts.totalCount}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>items on record</div></div>
          </div>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPassword(true)}><KeyRound size={14} /> Password</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <main style={{ width: '100%', padding: '20px 24px 48px', boxSizing: 'border-box' }}>
        <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }} aria-label="Portal sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={`btn btn-sm ${tab === t.id ? 'btn-accent' : 'btn-ghost'}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'stock' && <StockTab />}
        {tab === 'orders' && <OrdersTab refreshKey={ordersKey} />}
        {tab === 'new' && <NewOrderTab onSubmitted={() => setOrdersKey((k) => k + 1)} />}
        {tab === 'movements' && <MovementsTab />}
      </main>

      {showPassword && <ChangePassword onClose={() => setShowPassword(false)} />}
    </div>
  );
}
