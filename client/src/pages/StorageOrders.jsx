import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, X, Boxes, Package, Users, FileText, Truck, Printer } from 'lucide-react';
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
  return Number.isNaN(d.getTime()) ? o.createdAt : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
// Old "Order details" print: every field of the order on one page.
const orderRows = (o) => [
  ['Order number', o.orderNumber], ['Submitted', submittedAt(o)], ['Client', o.client], ['Devices', o.devices],
  ['Delivery address', o.deliveryAddress], ['Site contact name', o.siteContactName], ['Site contact phone number', o.siteContactPhone],
  ['Date to be delivered', dmy(o.dateToBeDelivered)], ['Configuration information', o.configInformation], ['Additional notes', o.notes],
  ['Requestor', o.requestor], ['Status', o.status], ['Tracking number', o.trackingNumber],
];

export default function StorageOrders() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [orders, setOrders] = useState(null);
  const [printing, setPrinting] = useState(null);

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
          <Link to="/storage" className="btn btn-ghost btn-sm"><Boxes size={14} /> Manifest</Link>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> New order</button>
        </div>
      </div>

      {/* Horizontal scrollbar above the table, mirroring the Manifest tab's top scrollbar */}
      <div className="panel" style={{ padding: 0 }}>
        {!orders ? (
          <div className="empty-state">Loading…</div>
        ) : orders.length === 0 ? (
          <div className="empty-state"><h3>No orders yet</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Order #</th><th>Client</th><th>Devices</th><th>Delivery Address</th>
                  <th>Site Contact</th><th>Phone</th><th>Date Required</th><th>Config Info</th>
                  <th>Notes</th><th>Requestor</th><th>Status</th><th>Tracking #</th><th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.orderNumber}</td>
                    <td>{o.client}</td>
                    <td>{o.devices}</td>
                    <td>{o.deliveryAddress}</td>
                    <td>{o.siteContactName}</td>
                    <td>{o.siteContactPhone}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(o.dateToBeDelivered)}</td>
                    <td>{o.configInformation}</td>
                    <td>{o.notes}</td>
                    <td>{o.requestor}</td>
                    <td>
                      <select value={o.status} onChange={(e) => handleStatusChange(o, e.target.value)}>
                        {(o.status === 'Pending' ? ['Pending', ...STATUSES] : STATUSES).map((s) => <option key={s} value={s}>{s}</option>)}
                        {isAdmin && <option value="__delete">Delete…</option>}
                      </select>
                    </td>
                    <td>{o.trackingNumber || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Order PDF / delivery docket"
                        onClick={() => openPdf(api, `/storage/orders/${o.id}/pdf`).catch((err) => alert(err.message))}>
                        <FileText size={13} />
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Print order details" onClick={() => setPrinting(o)}>
                        <Printer size={13} />
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Send to dispatch"
                        onClick={() => sendToDispatch(o)}>
                        <Truck size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
