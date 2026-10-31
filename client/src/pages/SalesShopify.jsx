import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import useSalesData from '../sales/useSalesData';
import { fmt, fmtInt, auDate, num, periodRange, toISODate } from '../sales/calc';

const PERIODS = [['all', 'All'], ['week', 'Last week'], ['month', 'Last month'], ['quarter', 'Last quarter'], ['custom', 'Custom']];
const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
};

// Shopify Orders — new order lines found by the 15-minute sync, waiting to be
// added to All Sales (with the cost filled in) or dismissed.
export default function SalesShopify() {
  const navigate = useNavigate();
  const { isAdmin } = useSalesData({ sales: false });
  const [orders, setOrders] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState('all');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [coverage, setCoverage] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/sales/shopify/pending');
      setOrders(r.data.orders); setStatus(r.data.status); setError('');
    } catch (err) { setError(err.response?.data?.error || 'Could not load Shopify orders'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const range = useMemo(() => periodRange(period, custom), [period, custom]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (orders || []).filter((o) => {
      const d = String(o.orderDate || '').slice(0, 10);
      if (range && (!d || d < range.startISO || d > range.endISO)) return false;
      if (!ql) return true;
      return [o.orderNumber, o.customer, o.productTitle, o.sku].join(' ').toLowerCase().includes(ql);
    });
  }, [orders, q, range]);
  const total = shown.reduce((a, o) => a + num(o.price) * (Number(o.quantity) || 1), 0);

  const addToSales = (o) => navigate('/sales/add', {
    state: {
      shopifyPendingId: o.id,
      prefill: {
        sku: o.sku || '', model: o.productTitle || '', sellprice: o.price || '', listed: o.price || '', customer: o.customer || '',
        orderno: o.orderNumber || '', selldate: String(o.orderDate || '').slice(0, 10) || toISODate(new Date()), platform: 'Shopify',
      },
    },
  });
  const dismiss = async (o) => {
    if (!window.confirm(`Dismiss order ${o.orderNumber} — ${o.productTitle}? It won't come back.`)) return;
    try {
      await api.delete(`/sales/shopify/pending/${encodeURIComponent(o.id)}`);
      setOrders((l) => l.filter((x) => x.id !== o.id));
    } catch (err) { setError(err.response?.data?.error || 'Could not dismiss'); }
  };
  const syncNow = async () => {
    setBusy(true); setMsg(''); setError('');
    try {
      const r = await api.post('/sales/shopify/sync');
      if (r.data.ok) setMsg(`Checked Shopify — ${r.data.staged || 0} new order line${r.data.staged === 1 ? '' : 's'}.`);
      else setError(r.data.reason === 'busy' ? 'A sync is already running — try again in a minute.' : (r.data.error || 'Sync failed'));
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Sync failed'); }
    setBusy(false);
  };

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Shopify Orders</h1>
          <div className="subtitle">
            {status && !status.configured ? 'Shopify is not connected yet — the Shopify settings need adding in Render.'
              : status ? <>Checks for new orders every 15 minutes · last check {ago(status.lastSyncAt)}{status.ok === false ? <span className="danger-text"> · last check failed: {status.error}</span> : ''}</> : ' '}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCoverage(true)} disabled={status && !status.configured}><ShieldCheck size={14} /> Check coverage</button>
          {isAdmin && <button type="button" className="btn btn-primary btn-sm" onClick={syncNow} disabled={busy || (status && !status.configured)}><RefreshCw size={14} className={busy ? 'spin' : ''} /> Sync now</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}
      <div className="stat-grid">
        <div className="stat-card accent-blue"><div className="num">{fmtInt(shown.length)}</div><div className="label">Order lines waiting</div></div>
        <div className="stat-card accent-green"><div className="num">{fmt(total)}</div><div className="label">Value waiting</div></div>
        <div className="stat-card accent-neutral"><div className="num">{fmtInt(new Set(shown.map((o) => o.orderNumber)).size)}</div><div className="label">Orders</div></div>
      </div>
      <div className="filters">
        <div className="search-input" style={{ flex: '1 1 240px' }}><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order #, customer, product, SKU…" /></div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {period === 'custom' && <>
          <input className="date-mini" placeholder="From dd/mm/yyyy" value={custom.start} onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))} />
          <input className="date-mini" placeholder="To dd/mm/yyyy" value={custom.end} onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))} />
        </>}
      </div>
      {!orders ? <div className="panel panel-pad">Loading…</div> : (
        <div className="panel sales-table-wrap">
          <table className="ticket-table">
            <thead><tr><th>Order #</th><th>Date</th><th>Customer</th><th>Product</th><th>SKU</th><th className="num">Qty</th><th className="num">Price</th><th /></tr></thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id}>
                  <td className="mono nowrap">{o.orderNumber}</td><td className="nowrap">{auDate(String(o.orderDate || '').slice(0, 10))}</td>
                  <td>{o.customer}</td><td>{o.productTitle}</td><td className="mono">{o.sku}</td>
                  <td className="num">{o.quantity}</td><td className="num">{fmt(num(o.price))}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <button type="button" className="btn btn-accent btn-sm" onClick={() => addToSales(o)}>Add to Sales</button>{' '}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => dismiss(o)} title="Dismiss"><X size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <div className="empty-state" style={{ padding: 30 }}>{orders.length ? 'No orders match these filters.' : 'All caught up — no Shopify orders waiting.'}</div>}
        </div>
      )}
      {coverage && <CoverageModal onClose={() => setCoverage(false)} />}
    </Layout>
  );
}

// Asks Shopify for every order in a period and shows which aren't in All Sales.
function CoverageModal({ onClose }) {
  const [period, setPeriod] = useState('month');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    const r = periodRange(period, custom);
    setBusy(true); setError(''); setResult(null);
    try {
      const res = await api.post('/sales/shopify/coverage', { startISO: r?.startISO || null, endISO: r?.endISO || null });
      setResult(res.data);
    } catch (err) { setError(err.response?.data?.error || 'Could not check Shopify'); }
    setBusy(false);
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 900, width: "95vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Check Shopify coverage</h3><button type="button" onClick={onClose}><X size={18} /></button></div>
        <p className="muted">Fetches the orders from Shopify for a period and checks each order number is in All Sales.</p>
        <div className="filters">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {[['week', 'Last week'], ['month', 'Last month'], ['quarter', 'Last quarter'], ['year', 'Last year'], ['fy', 'Last financial year'], ['custom', 'Custom']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {period === 'custom' && <>
            <input className="date-mini" placeholder="From dd/mm/yyyy" value={custom.start} onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))} />
            <input className="date-mini" placeholder="To dd/mm/yyyy" value={custom.end} onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))} />
          </>}
          <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check'}</button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {result && (
          <>
            <div className="stat-grid">
              <div className="stat-card accent-blue"><div className="num">{fmtInt(result.orders.length)}</div><div className="label">Shopify orders</div></div>
              <div className="stat-card accent-green"><div className="num">{fmtInt(result.matched)}</div><div className="label">In All Sales</div></div>
              <div className="stat-card accent-orange"><div className="num">{fmtInt(result.missing)}</div><div className="label">Missing</div></div>
              <div className="stat-card accent-neutral"><div className="num">{fmtInt(result.shopifySalesRowsInPeriod)}</div><div className="label">Shopify rows in All Sales</div></div>
            </div>
            <div className="sales-table-wrap" style={{ maxHeight: 360 }}>
              <table className="ticket-table">
                <thead><tr><th /><th>Order #</th><th>Date</th><th>Customer</th><th>Products</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {result.orders.map((o) => (
                    <tr key={o.orderNumber + o.orderDate}>
                      <td>{o.found ? <span className="status-pill s-sold">Found</span> : <span className="status-pill s-refunded">Missing</span>}</td>
                      <td className="mono">{o.orderNumber}</td><td className="nowrap">{auDate(o.orderDate)}</td><td>{o.customer}</td><td>{o.productTitle}</td><td className="num">{fmt(num(o.price))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
