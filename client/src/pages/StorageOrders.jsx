import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, FileText, Truck, Printer, Search } from 'lucide-react';
import api from '../api';
import { openPdf } from '../utils/pdf';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import { dmy } from '../storage/common';

// The old app's statuses. "Pending" only shows for orders created before the move.
const STATUSES = ['In Progress', 'Delivered', 'Cancelled'];

function submittedAt(o) {
  if (!o.createdAt) return '';
  const d = new Date(`${o.createdAt.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? o.createdAt : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
}
// Old "Order details" print: every field of the order on one page.
const orderRows = (o) => [
  ['Order number', o.orderNumber], ['Submitted', submittedAt(o)], ['Client', o.client], ['Devices', o.devices],
  ['Delivery address', o.deliveryAddress], ['Site contact name', o.siteContactName], ['Site contact phone number', o.siteContactPhone],
  ['Date to be delivered', dmy(o.dateToBeDelivered)], ['Configuration information', o.configInformation], ['Additional notes', o.notes],
  ['Requestor', o.requestor], ['Status', o.status], ['Tracking number', o.trackingNumber],
];

// The devices box holds serials separated by commas or new lines.
const deviceList = (o) => String(o.devices || '').split(/[,;\n]+/).map((d) => d.trim()).filter(Boolean);

const STATUS_STYLE = {
  Delivered: { background: '#E1F0E6', color: '#2F7A44', borderColor: '#BFDFC9' },
  'In Progress': { background: '#DDEEFB', color: '#2C6FA8', borderColor: '#BBD9F2' },
  Pending: { background: '#FBF1DC', color: '#946200', borderColor: '#EED9A6' },
  Cancelled: { background: '#F3F1EE', color: '#7A746C', borderColor: '#E2DED8' },
};

// One tidy line per cell, like the old app: long text is cut off with "…" and the
// full text shows on hover (and in the order details).
function Cell({ children, width, mono }) {
  const text = children == null ? '' : String(children);
  return (
    <td title={text.length > 20 ? text : undefined}
      style={{ maxWidth: width, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: mono ? 'var(--font-mono, monospace)' : undefined }}>
      {text}
    </td>
  );
}

export default function StorageOrders() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [orders, setOrders] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [details, setDetails] = useState(null); // order shown in the details panel
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    const off = () => { document.body.classList.remove('printing-order'); setPrinting(null); };
    window.addEventListener('afterprint', off);
    return () => { window.removeEventListener('afterprint', off); document.body.classList.remove('printing-order'); };
  }, []);
  useEffect(() => {
    if (!printing) return;
    document.body.classList.add('printing-order');
    window.print();
  }, [printing]);
  const [showForm, setShowForm] = useState(false);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Delivered-status tracking-email modal — mirrors the original Apps Script app's
  // "email the customer their order is on its way" step.
  const [deliverModal, setDeliverModal] = useState(null); // { order }
  const [toEmail, setToEmail] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [message, setMessage] = useState('');
  const [deliverBusy, setDeliverBusy] = useState(false);
  const [deliverError, setDeliverError] = useState('');

  function load() { api.get('/storage/orders').then((res) => setOrders(res.data.orders)); }

  // "Send to dispatch", as in the old app: marks the order Delivered, closes out
  // the matching serials on the manifest, then opens a pre-filled dispatch entry.
  const navigate = useNavigate();
  async function sendToDispatch(o) {
    if (!confirm(`Send order ${o.orderNumber} to dispatch?\n\nThis marks it Delivered (no tracking email) and sets today as the storage end date for its devices on the manifest.`)) return;
    try {
      const { data } = await api.post(`/storage/orders/${o.id}/dispatch`, {});
      navigate('/storage/receiving', {
        state: {
          dispatchPrefill: data.dispatchPrefill,
          matchSummary: { matched: data.matched, unmatched: data.unmatched, deviceCount: data.deviceCount, endDate: data.endDate },
        },
      });
    } catch (err) {
      alert(err.response?.data?.error || 'Could not send to dispatch');
    }
  }
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (orders || []).filter((o) => {
      if (statusFilter && o.status !== statusFilter) return false;
      if (!q) return true;
      return [o.orderNumber, o.client, o.devices, o.deliveryAddress, o.siteContactName, o.siteContactPhone, o.configInformation, o.notes, o.requestor, o.trackingNumber]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [orders, query, statusFilter]);

  function openAdd() { setFormValues({}); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/storage/orders', { ...formValues, requestor: user?.name });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(order, newStatus) {
    if (newStatus === '__delete') {
      if (!confirm(`Delete order ${order.orderNumber}? This cannot be undone.`)) return;
      try { await api.delete(`/storage/orders/${order.id}`); } catch (err) { alert(err.response?.data?.error || 'Could not delete the order'); }
      load();
      return;
    }
    if (newStatus === 'Delivered') {
      setDeliverModal(order);
      setToEmail('');
      setTrackingNumber('');
      setMessage('');
      setDeliverError('');
      return;
    }
    try { await api.patch(`/storage/orders/${order.id}`, { status: newStatus }); } catch (err) { alert(err.response?.data?.error || 'Could not update the status'); }
    load();
  }

  async function submitDeliver(skipEmail) {
    setDeliverBusy(true);
    setDeliverError('');
    try {
      await api.post(`/storage/orders/${deliverModal.id}/deliver`, {
        skipEmail,
        toEmail: skipEmail ? undefined : toEmail,
        trackingNumber: skipEmail ? undefined : trackingNumber,
        message: skipEmail ? undefined : message,
      });
      setDeliverModal(null);
      load();
    } catch (err) {
      setDeliverError(err.response?.data?.error || 'Could not send the tracking email');
    } finally {
      setDeliverBusy(false);
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Client Orders</h1>
          <div className="subtitle">{orders ? `${orders.length} order${orders.length === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> New order</button>
        </div>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order #, client, serial, address, contact…" style={{ width: '100%', paddingLeft: 30 }} />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Any status</option>
          {['Pending', ...STATUSES].map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Click an order number or its devices for the full details.</span>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {!orders ? (
          <div className="empty-state">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="empty-state"><h3>{orders.length ? 'No orders match' : 'No orders yet'}</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table orders-table">
              <thead>
                <tr>
                  <th>Order #</th><th>Submitted</th><th>Client</th><th>Devices</th><th>Delivery address</th>
                  <th>Site contact</th><th>Phone</th><th>Delivery date</th><th>Config info</th>
                  <th>Notes</th><th>Requestor</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const devices = deviceList(o);
                  return (
                    <tr key={o.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="link-button" onClick={() => setDetails(o)} title="Show the full order">{o.orderNumber}</button>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{submittedAt(o)}</td>
                      <Cell width={170}>{o.client}</Cell>
                      {devices.length === 1 ? <Cell width={170} mono>{devices[0]}</Cell> : (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {devices.length > 1
                            ? <button type="button" className="link-button" onClick={() => setDetails(o)}>{devices.length} devices</button>
                            : <span style={{ color: 'var(--muted)' }}>—</span>}
                        </td>
                      )}
                      <Cell width={220}>{o.deliveryAddress}</Cell>
                      <Cell width={150}>{o.siteContactName}</Cell>
                      <td style={{ whiteSpace: 'nowrap' }}>{o.siteContactPhone}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{dmy(o.dateToBeDelivered)}</td>
                      <Cell width={180}>{o.configInformation}</Cell>
                      <Cell width={220}>{o.notes}</Cell>
                      <Cell width={160}>{o.requestor}</Cell>
                      <td>
                        <select value={o.status} onChange={(e) => handleStatusChange(o, e.target.value)} className="status-select"
                          style={{ ...(STATUS_STYLE[o.status] || {}), border: '1px solid', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontWeight: 600 }}>
                          {(o.status === 'Pending' ? ['Pending', ...STATUSES] : STATUSES).map((st) => <option key={st} value={st}>{st}</option>)}
                          {isAdmin && <option value="__delete">Delete…</option>}
                        </select>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Order PDF / delivery docket"
                          onClick={() => openPdf(api, `/storage/orders/${o.id}/pdf`).catch((err) => alert(err.message))}>
                          <FileText size={13} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Print order details" onClick={() => setPrinting(o)}>
                          <Printer size={13} />
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Send to dispatch" onClick={() => sendToDispatch(o)}>
                          <Truck size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {details && (() => {
        const devices = deviceList(details);
        return (
          <div className="modal-overlay" onClick={() => setDetails(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 860, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
              <div className="modal-header">
                <div>
                  <h3>Order {details.orderNumber}</h3>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, fontWeight: 400 }}>{details.client} · submitted {submittedAt(details)} · {details.status}</div>
                </div>
                <button type="button" onClick={() => setDetails(null)} aria-label="Close"><X size={18} /></button>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                <table className="detail-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                  <tbody>
                    {orderRows(details).filter(([l]) => !['Order number', 'Devices', 'Client', 'Submitted', 'Status'].includes(l)).map(([l, v]) => (
                      <tr key={l} style={{ borderBottom: '1px solid var(--line)' }}>
                        <th style={{ textAlign: 'left', padding: '7px 12px 7px 0', width: 200, color: 'var(--muted)', fontWeight: 600, verticalAlign: 'top' }}>{l}</th>
                        <td style={{ padding: '7px 0', whiteSpace: 'pre-wrap' }}>{v || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Devices ({devices.length})</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 }}>
                  {devices.map((d, i) => (
                    <span key={`${d}-${i}`} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, background: 'var(--panel, #f6f4f1)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px' }}>{d}</span>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(devices.join('\n'))}>Copy serials</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openPdf(api, `/storage/orders/${details.id}/pdf`).catch((err) => alert(err.message))}><FileText size={13} /> Order PDF</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const o = details; setDetails(null); setPrinting(o); }}><Printer size={13} /> Print</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const o = details; setDetails(null); sendToDispatch(o); }}><Truck size={13} /> Send to dispatch</button>
              </div>
            </div>
          </div>
        );
      })()}

      {printing && (
        <div className="order-print">
          <h2 style={{ marginBottom: 12 }}>Order {printing.orderNumber}</h2>
          <table><tbody>{orderRows(printing).map(([l, v]) => <tr key={l}><th>{l}</th><td style={{ whiteSpace: 'pre-wrap' }}>{v || ''}</td></tr>)}</tbody></table>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => !saving && setShowForm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3>New order</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSave}>
              <div className="form-grid">
                {[
                  ['client', 'Client'], ['devices', 'Devices'], ['deliveryAddress', 'Delivery Address'],
                  ['siteContactName', 'Site Contact Name'], ['siteContactPhone', 'Site Contact Phone Number'],
                  ['dateToBeDelivered', 'Date to be Delivered'], ['configInformation', 'Config Information'], ['notes', 'Notes'],
                ].map(([key, label]) => (
                  <div className="field" key={key}>
                    <label>{label}</label>
                    <input
                      type={key === 'dateToBeDelivered' ? 'date' : 'text'}
                      value={formValues[key] ?? ''}
                      onChange={(e) => setFormValues((p) => ({ ...p, [key]: e.target.value }))}
                      required={key === 'client'}
                    />
                  </div>
                ))}
              </div>
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Create order'}</button>
            </form>
          </div>
        </div>
      )}

      {deliverModal && (
        <div className="modal-overlay" onClick={() => !deliverBusy && setDeliverModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>Order {deliverModal.orderNumber} — on its way?</h3>
              {!deliverBusy && <button type="button" onClick={() => setDeliverModal(null)}><X size={18} /></button>}
            </div>
            {deliverError && <div className="error-banner">{deliverError}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              Optionally email the customer that their order is on its way (with a tracking number if you have one). Enter the recipient's address manually below, or Skip to mark it Delivered without emailing.
            </p>
            <div className="form-grid">
              <div className="field"><label>Customer email address</label><input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} placeholder="customer@example.com" /></div>
              <div className="field"><label>Tracking number (optional)</label><input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} /></div>
              <div className="field span-2"><label>Message (optional)</label><textarea value={message} onChange={(e) => setMessage(e.target.value)} /></div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => submitDeliver(true)} disabled={deliverBusy} style={{ flex: 1 }}>Skip</button>
              <button type="button" className="btn btn-accent" onClick={() => submitDeliver(false)} disabled={deliverBusy || !toEmail} style={{ flex: 1 }}>
                {deliverBusy ? 'Sending…' : 'Send & mark Delivered'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
