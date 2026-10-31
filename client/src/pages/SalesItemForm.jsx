import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Printer, Tag, Copy, Trash2, ArrowRight, Save } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import useSalesData from '../sales/useSalesData';
import {
  ITEM_TYPES, PLATFORMS, SALE_STATUSES, INV_STATUSES, LABOUR_COST_BY_TYPE, DEFAULT_PACK_HANDLE, DEFAULT_ADS_COST,
  fmt, pct, str, toISODate, weekStartISO, findDuplicateSerial, printItem, printLabels, addNote,
} from '../sales/calc';

// Add / edit a sale (kind 'sale') or an inventory item (kind 'inventory') — the
// old app's "Add a Sale" and "Add Inventory Item" forms.
const SPEC_FIELDS = [['serial', 'Serial number', 'mono'], ['ram', 'RAM', 'e.g. 16GB'], ['cpu', 'CPU', 'e.g. I7 11TH GEN'],
  ['processor', 'Processor', 'e.g. i7-1165G7 @ 2.80GHz'], ['capacity', 'Capacity', 'e.g. 256GB SSD'], ['colour', 'Colour'],
  ['display', 'Display'], ['extra', 'Extra'], ['batteryhealth', 'Battery Health']];
const COPY_ON_DUPLICATE = ['sku', 'itemtype', 'make', 'model', 'platform', 'listed', 'cost', 'ram', 'cpu', 'processor', 'capacity',
  'colour', 'display', 'extra', 'batteryhealth', 'warranty', 'location', 'origin', 'packhandle', 'labour', 'adscost'];

function blank(kind) {
  return kind === 'inventory'
    ? { itemtype: 'Laptop', platform: 'eBay', warranty: 'No', status: 'Not Tested', labour: String(LABOUR_COST_BY_TYPE.Laptop), packhandle: String(DEFAULT_PACK_HANDLE), adscost: String(DEFAULT_ADS_COST) }
    : { itemtype: 'Laptop', platform: 'eBay', warranty: 'No', status: 'Sold', packhandle: String(DEFAULT_PACK_HANDLE) };
}

export default function SalesItemForm({ kind }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { sales, inventory, calc, loading, patch } = useSalesData({ sales: true, inventory: true });
  const isSale = kind === 'sale';
  const list = isSale ? sales : inventory;
  const listPath = isSale ? '/sales/all' : '/sales/inventory';
  const existing = useMemo(() => (id && list ? list.find((x) => x.id === id) : null), [id, list]);

  const [f, setF] = useState(() => ({ ...blank(kind), ...(location.state?.prefill || {}) }));
  const [pendingId, setPendingId] = useState(location.state?.shopifyPendingId || null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(location.state?.message || '');
  const [loadedId, setLoadedId] = useState(null);

  // Opening an existing item fills the form once.
  useEffect(() => {
    if (existing && loadedId !== existing.id) {
      const vals = {};
      Object.keys(existing).forEach((k) => { vals[k] = existing[k] == null ? '' : String(existing[k]); });
      setF(vals);
      setLoadedId(existing.id);
    }
  }, [existing, loadedId]);
  // A new blank form when the address changes (e.g. after "Duplicate").
  useEffect(() => {
    if (!id) {
      setF({ ...blank(kind), ...(location.state?.prefill || {}) });
      setPendingId(location.state?.shopifyPendingId || null);
      setMsg(location.state?.message || '');
      setLoadedId(null);
    }
  }, [id, kind, location.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const setType = (e) => {
    const t = e.target.value;
    setF((p) => ({ ...p, itemtype: t, ...(!isSale && LABOUR_COST_BY_TYPE[t] !== undefined ? { labour: String(LABOUR_COST_BY_TYPE[t]) } : {}) }));
  };

  // Live profit for a sale: labour and ads are this week's share (a new sale counts as one more order).
  const live = useMemo(() => {
    if (!isSale) return null;
    const draft = { ...f, selldate: f.selldate || toISODate(new Date()) };
    // A new sale counts as one more order in its week; an edited one only if its date moved to another week.
    const extra = existing && weekStartISO(existing.selldate) && weekStartISO(existing.selldate) === weekStartISO(draft.selldate) ? 0 : 1;
    const share = calc.share(draft, extra);
    return { labour: share ? share.labour : 0, ads: share ? share.ads : 0, net: calc.net(draft, extra), margin: calc.margin(draft, extra) };
  }, [f, isSale, existing, calc]);

  if (id && !loading && list && !existing) {
    return <Layout><div className="error-banner">That item couldn't be found — it may have been moved or deleted. <Link to={listPath}>Back to the list</Link></div></Layout>;
  }

  async function save(e) {
    e?.preventDefault();
    setError(''); setMsg('');
    const data = { ...f };
    ['sku', 'make', 'model', 'serial', 'orderno', 'customer', 'location', 'origin', 'comments'].forEach((k) => { data[k] = str(data[k]).trim(); });
    if (!data.sku && !data.model) { setError('Add at least a SKU or model.'); return; }
    if (data.sku && list) {
      const dupe = list.find((x) => x.id !== id && str(x.sku).toLowerCase() === data.sku.toLowerCase());
      if (dupe && !confirm(`SKU "${data.sku}" already exists in ${isSale ? 'All Sales' : 'Inventory on Hand'} (${dupe.make || ''} ${dupe.model || ''}). Continue anyway?`)) return;
    }
    if (data.serial) {
      const d = findDuplicateSerial(data.serial, id, sales || [], inventory || []);
      if (d && !confirm(`Serial "${data.serial}" already exists on ${d.sku} (${d.model}) in ${d.sheet}. Save anyway?`)) return;
    }
    if (isSale && data.sellprice && live.net < 0 && !confirm(`This sale shows a loss of ${fmt(Math.abs(live.net))} after all costs. Save anyway?`)) return;
    // A sale's labour/ads come from the weekly split, not the form; keep any old stored values.
    if (isSale) { delete data.labour; delete data.adscost; }
    delete data.id; delete data.kind; delete data.createdAt; delete data.lastmodified; delete data.addedby;
    setSaving(true);
    try {
      let saved;
      if (id) {
        saved = (await api.patch(`/sales/items/${id}`, { data })).data.item;
        patch(kind, (l) => l.map((x) => (x.id === id ? saved : x)));
      } else {
        saved = (await api.post('/sales/items', { kind, data, shopifyPendingId: pendingId || undefined })).data.item;
        patch(kind, (l) => [saved, ...l]);
        setPendingId(null);
      }
      if (isSale && saved.status === 'Return to Inventory on Hand') {
        await api.post('/sales/items/move', { ids: [saved.id], to: 'inventory' });
        patch('sale', (l) => l.filter((x) => x.id !== saved.id));
        navigate('/sales/inventory', { state: { message: 'Moved back to Inventory on Hand.' } });
        return;
      }
      if (id) {
        setMsg(isSale ? 'Sale updated.' : 'Item updated.');
        setF((p) => ({ ...p, lasteditedby: saved.lasteditedby }));
      } else {
        setF({ ...blank(kind) });
        setMsg(`${isSale ? 'Sale' : 'Item'} saved${pendingId ? ' and taken off the Shopify list' : ''}. Add another, or go back to the list.`);
        window.scrollTo(0, 0);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete this ${isSale ? 'sale' : 'inventory item'}? This cannot be undone.`)) return;
    try {
      await api.delete(`/sales/items/${id}`);
      patch(kind, (l) => l.filter((x) => x.id !== id));
      navigate(listPath);
    } catch (err) { setError(err.response?.data?.error || 'Could not delete'); }
  }

  async function addToSales() {
    if (!str(f.sellprice).trim()) { setError('Add a Sell price before moving this to All Sales.'); return; }
    if (!confirm(`Move ${f.sku || f.model || 'this item'} to All Sales? It will be removed from Inventory on Hand.`)) return;
    await save();
    await api.post('/sales/items/move', { ids: [id], to: 'sale' });
    patch('inventory', (l) => l.filter((x) => x.id !== id));
    navigate('/sales/all', { state: { message: `${f.sku || f.model} moved to All Sales.` } });
  }

  function duplicate() {
    const prefill = {};
    COPY_ON_DUPLICATE.forEach((k) => { if (f[k]) prefill[k] = f[k]; });
    navigate(isSale ? '/sales/add' : '/sales/inventory/add', { state: { prefill, message: 'Duplicated — review the details and save as a new item. Serial, order, customer, sell date and price start blank.' } });
  }

  const input = (k, label, opts = {}) => (
    <div className="field" key={k}>
      <label htmlFor={`sf-${k}`}>{label}</label>
      <input id={`sf-${k}`} type={opts.type || 'text'} step={opts.type === 'number' ? '0.01' : undefined} value={f[k] ?? ''}
        onChange={set(k)} placeholder={opts.placeholder} className={opts.mono ? 'mono-input' : undefined} readOnly={opts.readOnly} />
    </div>
  );
  const select = (k, label, options, onChange) => (
    <div className="field">
      <label htmlFor={`sf-${k}`}>{label}</label>
      <select id={`sf-${k}`} value={f[k] ?? ''} onChange={onChange || set(k)}>
        {!options.includes(f[k]) && f[k] && <option value={f[k]}>{f[k]}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
  const title = id ? (isSale ? 'Edit sale' : 'Edit inventory item') : (isSale ? 'Add a sale' : 'Add inventory item');

  return (
    <Layout>
      <div className="page-header">
        <div>
          <Link to={listPath} className="back-link"><ArrowLeft size={14} /> {isSale ? 'All Sales' : 'Inventory on Hand'}</Link>
          <h1>{title}{id && f.sku ? ` — ${f.sku}` : ''}</h1>
          {id && (f.addedby || f.lasteditedby) && <div className="subtitle">Added by <b>{f.addedby || 'Unknown'}</b> · Last edited by <b>{f.lasteditedby || 'Unknown'}</b></div>}
          {pendingId && <div className="subtitle">From a Shopify order — fill in the rest, then save to add it to All Sales.</div>}
        </div>
        {id && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!isSale && <button type="button" className="btn btn-accent btn-sm" onClick={addToSales}><ArrowRight size={14} /> Add to All Sales</button>}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => printItem({ ...existing, ...f }, isSale, calc)}><Printer size={14} /> Print</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => printLabels([{ ...existing, ...f }])}><Tag size={14} /> Label</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={duplicate}><Copy size={14} /> Duplicate</button>
            <button type="button" className="btn btn-ghost btn-sm danger-text" onClick={remove}><Trash2 size={14} /> Delete</button>
          </div>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner" style={{ marginBottom: 14 }}><span>{msg}</span></div>}
      {loading ? <div className="panel panel-pad">Loading…</div> : (
        <form onSubmit={save} className="sales-form">
          <div className="panel panel-pad">
            <h3 className="sales-form-h">Item</h3>
            <div className="form-grid">
              {input('sku', 'SKU', { placeholder: 'e.g. 0182', mono: true })}
              {select('itemtype', 'Item type', ITEM_TYPES, setType)}
              {input('make', 'Make', { placeholder: 'e.g. Dell' })}
              {input('model', 'Model', { placeholder: 'e.g. Latitude 5420' })}
              {select('platform', 'Platform', PLATFORMS)}
              {input('selldate', isSale ? 'Sell date' : 'Sell date (if known)', { type: 'date' })}
            </div>
          </div>
          <div className="panel panel-pad">
            <h3 className="sales-form-h">Prices and costs</h3>
            <div className="form-grid">
              {input('cost', 'Product cost ($)', { type: 'number', placeholder: '0.00' })}
              {input('listed', 'Listed price ($)', { type: 'number', placeholder: '0.00' })}
              {input('sellprice', isSale ? 'Sell price ($)' : 'Sell price — planned ($)', { type: 'number', placeholder: '0.00' })}
              {input('postage', 'Postage ($)', { type: 'number', placeholder: '0.00' })}
              {input('fees', 'Platform fees ($)', { type: 'number', placeholder: '0.00' })}
              {input('extendedwarranty', 'Extended warranty ($)', { type: 'number', placeholder: '0.00' })}
              {input('packhandle', 'Pack/handle cost ($)', { type: 'number', placeholder: '0.00' })}
              {isSale ? (
                <>
                  <div className="field"><label title="Weekly labour cost split across that week's sales">Labour cost ($) — auto</label><input readOnly value={live.labour.toFixed(2)} className="readonly-input" /></div>
                  <div className="field"><label title="Weekly Google Ads cost split across that week's sales">Google Ads cost ($) — auto</label><input readOnly value={live.ads.toFixed(2)} className="readonly-input" /></div>
                </>
              ) : (
                <>
                  {input('labour', 'Labour cost ($)', { type: 'number' })}
                  {input('adscost', 'Google Ads cost ($)', { type: 'number' })}
                </>
              )}
            </div>
            {isSale && (
              <div className={`sales-calc ${live.net < 0 ? 'neg' : 'pos'}`}>
                <span>Net profit <b>{fmt(live.net)}</b></span>
                <span>Margin <b>{pct(live.margin)}</b></span>
                <span className="muted">Labour and Google Ads are this week's share of the fixed weekly costs.</span>
              </div>
            )}
          </div>
          <div className="panel panel-pad">
            <h3 className="sales-form-h">Specs</h3>
            <div className="form-grid">
              {SPEC_FIELDS.map(([k, label, ph]) => input(k, label, { mono: ph === 'mono', placeholder: ph === 'mono' ? undefined : ph }))}
            </div>
          </div>
          <div className="panel panel-pad">
            <h3 className="sales-form-h">{isSale ? 'Sale' : 'Stock'}</h3>
            <div className="form-grid">
              {input('orderno', 'Order no.')}
              {input('customer', 'Customer')}
              {select('warranty', 'Warranty', ['No', 'Yes'])}
              {select('status', 'Status', isSale ? SALE_STATUSES : INV_STATUSES)}
              {input('location', 'Location')}
              {input('origin', 'Stock origin', { placeholder: 'e.g. trade-in / supplier' })}
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="sf-note">Comments / notes</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="sf-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Type a note, then Add note (adds the date and your name)"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setF((p) => ({ ...p, comments: addNote(p.comments, note, user?.name) })); setNote(''); } }} />
                <button type="button" className="btn btn-ghost" onClick={() => { setF((p) => ({ ...p, comments: addNote(p.comments, note, user?.name) })); setNote(''); }}>Add note</button>
              </div>
              <textarea rows={4} value={f.comments ?? ''} onChange={set('comments')} style={{ marginTop: 8 }} />
            </div>
          </div>
          <div className="sales-form-actions">
            <button className="btn btn-accent" type="submit" disabled={saving}><Save size={15} /> {saving ? 'Saving…' : id ? (isSale ? 'Update sale' : 'Update item') : (isSale ? 'Save sale' : 'Save item')}</button>
            {!id && <button type="button" className="btn btn-ghost" onClick={() => { setF({ ...blank(kind) }); setPendingId(null); setMsg(''); }}>Clear form</button>}
            <Link to={listPath} className="btn btn-ghost">Cancel</Link>
          </div>
        </form>
      )}
    </Layout>
  );
}
