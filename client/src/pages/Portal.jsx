import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, KeyRound, Search, FileText, X, Plus } from 'lucide-react';
import portalApi, { clearPortalSession, getPortalClient } from '../portal/portalApi';
import { openPdf } from '../utils/pdf';

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

function deviceLabel(i) {
  return [i.serial || i.assetTag, [i.make, i.model].filter(Boolean).join(' ') || i.item, i.location && `(${i.location})`].filter(Boolean).join(' — ');
}

// ---------------------------------------------------------------------------
function StockTab() {
  const [items, setItems] = useState(null);
  const [includeAll, setIncludeAll] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setItems(null);
    portalApi.get('/items', { params: includeAll ? { include: 'all' } : {} })
      .then((res) => setItems(res.data.items))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your stock'));
  }, [includeAll]);

  const visible = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => [i.item, i.make, i.model, i.serial, i.assetTag, i.location, i.storageCentre, i.poNumber, i.referenceNumber, i.jobNumber]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }, [items, query]);

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search serial, model, location, PO…" style={{ paddingLeft: 30, width: '100%' }} />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} /> Include items that have left storage
        </label>
        <span style={{ fontSize: 13, color: 'var(--muted)', marginLeft: 'auto' }}>{visible ? `${visible.length} item${visible.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="panel" style={{ padding: 0 }}>
        {!visible ? <div className="empty-state">Loading…</div> : visible.length === 0 ? (
          <div className="empty-state"><h3>No items{query ? ' match your search' : ' in storage'}</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>Item</th><th>Make / model</th><th>Serial</th><th>Asset tag</th><th>Qty</th><th>Condition</th><th>Storage centre</th><th>Location</th><th>PO</th><th>In</th>{includeAll && <th>Out</th>}</tr></thead>
              <tbody>
                {visible.map((i) => (
                  <tr key={i.id}>
                    <td>{i.item}</td>
                    <td>{[i.make, i.model].filter(Boolean).join(' ')}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{i.serial}</td>
                    <td>{i.assetTag}</td>
                    <td>{i.quantity}</td>
                    <td>{i.condition}</td>
                    <td>{i.storageCentre}</td>
                    <td>{i.location}</td>
                    <td>{i.poNumber}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.startDate)}</td>
                    {includeAll && <td style={{ whiteSpace: 'nowrap' }}>{dmy(i.endDate)}</td>}
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
const EMPTY_ORDER = { requestedBy: '', deliveryAddress: '', siteContactName: '', siteContactPhone: '', dateToBeDelivered: '', devices: '', configInformation: '', notes: '' };

function NewOrderTab({ onSubmitted }) {
  const [form, setForm] = useState(EMPTY_ORDER);
  const [items, setItems] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [pickQuery, setPickQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => { portalApi.get('/items').then((res) => setItems(res.data.items)).catch(() => {}); }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const pickable = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    return items.filter((i) => !q || deviceLabel(i).toLowerCase().includes(q)).slice(0, 200);
  }, [items, pickQuery]);

  function togglePick(i) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i.id)) next.delete(i.id); else next.add(i.id);
      return next;
    });
  }

  function devicesText() {
    const fromPicker = items.filter((i) => picked.has(i.id)).map(deviceLabel);
    return [...fromPicker, form.devices.trim()].filter(Boolean).join('\n');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const devices = devicesText();
    if (!devices) { setError('Pick devices from your stock or type what you need.'); return; }
    setSaving(true);
    try {
      const { data } = await portalApi.post('/orders', { ...form, devices });
      setDone(data.order);
      setForm(EMPTY_ORDER);
      setPicked(new Set());
      onSubmitted();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit the order');
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <div className="panel">
        <h3 style={{ marginBottom: 6 }}>Order {done.orderNumber} submitted</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>Thanks — the IT Factory team has your request and will be in touch. You can follow its status under Orders.</p>
        <button type="button" className="btn btn-accent" onClick={() => setDone(null)}><Plus size={16} /> Another order</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="panel">
      {error && <div className="error-banner">{error}</div>}
      <div className="form-grid">
        <div className="field"><label>Your name</label><input value={form.requestedBy} onChange={set('requestedBy')} maxLength={200} /></div>
        <div className="field"><label>Deliver by</label><input type="date" value={form.dateToBeDelivered} onChange={set('dateToBeDelivered')} /></div>
        <div className="field span-2"><label>Delivery address *</label><input value={form.deliveryAddress} onChange={set('deliveryAddress')} required maxLength={500} /></div>
        <div className="field"><label>Site contact</label><input value={form.siteContactName} onChange={set('siteContactName')} maxLength={200} /></div>
        <div className="field"><label>Site contact phone</label><input value={form.siteContactPhone} onChange={set('siteContactPhone')} maxLength={60} /></div>
      </div>

      <h3 style={{ margin: '20px 0 8px', fontSize: 15 }}>Devices</h3>
      {items.length > 0 && (
        <>
          <div style={{ position: 'relative', maxWidth: 420, marginBottom: 8 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} placeholder="Find in your stock…" style={{ paddingLeft: 30, width: '100%' }} />
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 6, padding: 6, marginBottom: 8 }}>
            {pickable.map((i) => (
              <label key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 6px', fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => togglePick(i)} />
                <span>{deviceLabel(i)}</span>
              </label>
            ))}
            {pickable.length === 0 && <div style={{ fontSize: 13, color: 'var(--muted)', padding: 6 }}>Nothing matches.</div>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{picked.size} selected</div>
        </>
      )}
      <div className="field"><label>{items.length ? 'Anything else (one per line)' : 'Devices needed (one per line) *'}</label>
        <textarea rows={4} value={form.devices} onChange={set('devices')} placeholder="e.g. 5 x Dell OptiPlex 7010, or serial numbers" />
      </div>

      <div className="form-grid">
        <div className="field span-2"><label>Configuration / imaging requirements</label><textarea rows={2} value={form.configInformation} onChange={set('configInformation')} maxLength={4000} /></div>
        <div className="field span-2"><label>Notes</label><textarea rows={2} value={form.notes} onChange={set('notes')} maxLength={4000} /></div>
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

  useEffect(() => {
    portalApi.get('/me').then((res) => setClient(res.data.client)).catch(() => {});
  }, []);

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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPassword(true)}><KeyRound size={14} /> Password</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 16px 48px' }}>
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
