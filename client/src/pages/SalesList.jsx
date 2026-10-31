import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Plus, Search, Download, Upload, Trash2, MoreHorizontal, Printer, Tag, Copy, Pencil, ArrowRight, X, Clock } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import useSalesData from '../sales/useSalesData';
import {
  PLATFORMS, SALE_STATUSES, INV_STATUSES, ITEM_TYPES, SEARCH_FIELDS, fmt, fmtInt, pct, auDate, str, num, daysInStock,
  formatBatteryHealth, platformClass, matches, sortItems, exportSales, exportInventory, parseCSV, rowsToRecords,
  printItem, printLabels, allDuplicateSerials,
} from '../sales/calc';

// "All Sales" (kind 'sale') and "Inventory on Hand" (kind 'inventory').
const PAGE = 200;
const SPEC_COLS = [['serial', 'Serial', 'mono'], ['ram', 'RAM'], ['cpu', 'CPU'], ['processor', 'Processor'], ['capacity', 'Capacity'],
  ['colour', 'Colour'], ['display', 'Display'], ['extra', 'Extra']];
// Fields offered in Bulk Edit (inventory also has labour and ads; a sale's come from the weekly split).
const BULK_FIELDS = [
  ['itemtype', 'Item type', ITEM_TYPES], ['make', 'Make'], ['model', 'Model'], ['ram', 'RAM'], ['cpu', 'CPU'], ['processor', 'Processor'],
  ['capacity', 'Capacity'], ['colour', 'Colour'], ['display', 'Display'], ['extra', 'Extra'], ['batteryhealth', 'Battery health'],
  ['warranty', 'Warranty', ['No', 'Yes']], ['location', 'Location'], ['origin', 'Stock origin'], ['platform', 'Platform', PLATFORMS],
  ['listed', 'Listed price ($)', 'number'], ['sellprice', 'Sell price ($)', 'number'], ['extendedwarranty', 'Extended warranty ($)', 'number'],
  ['cost', 'Cost ($)', 'number'], ['postage', 'Postage ($)', 'number'], ['fees', 'Fees ($)', 'number'], ['packhandle', 'Pack/handle ($)', 'number'],
  ['labour', 'Labour ($)', 'number', 'inventory'], ['adscost', 'Google Ads ($)', 'number', 'inventory'],
  ['selldate', 'Sell date', 'date'], ['customer', 'Customer'], ['comments', 'Comments'],
];

export default function SalesList({ kind }) {
  const isSale = kind === 'sale';
  const navigate = useNavigate();
  const location = useLocation();
  const { sales, inventory, calc, loading, error, reload, patch, isAdmin } = useSalesData({ sales: true, inventory: true });
  const list = isSale ? sales : inventory;
  const [q, setQ] = useState('');
  const [field, setField] = useState('all');
  const [plat, setPlat] = useState('');
  const [slowOnly, setSlowOnly] = useState(new URLSearchParams(location.search).get('slow') === '1');
  const [modelFilter, setModelFilter] = useState(location.state?.model || '');
  const [sort, setSort] = useState(isSale ? { col: 'selldate', dir: 'desc' } : { col: 'sku', dir: 'asc' });
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(isSale ? 'Sold' : 'Not Tested');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(location.state?.message || '');
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState(null); // { id, x, y }
  const [bulkEdit, setBulkEdit] = useState(false);
  const [customer, setCustomer] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => { setLimit(PAGE); }, [q, field, plat, slowOnly, modelFilter]);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const valueOf = (e, col) => {
    switch (col) {
      case 'net': return calc.net(e);
      case 'margin': return calc.margin(e);
      case 'labour': return isSale ? calc.labour(e) : num(e.labour);
      case 'adscost': return isSale ? calc.ads(e) : num(e.adscost);
      case 'days': return daysInStock(e) ?? -1;
      case 'model': return `${str(e.make)}${str(e.model)}`.toLowerCase();
      case 'sellprice': case 'postage': case 'fees': case 'cost': case 'listed': case 'packhandle': case 'extendedwarranty': return num(e[col]);
      default: return str(e[col]).toLowerCase();
    }
  };

  const filtered = useMemo(() => {
    if (!list) return [];
    const ql = q.trim().toLowerCase();
    let l = list.filter((e) => (!plat || e.platform === plat) && matches(e, ql, field, isSale ? ['origin'] : []));
    if (!isSale && slowOnly) l = l.filter((e) => (daysInStock(e) ?? 0) >= 60);
    if (modelFilter) l = l.filter((e) => `${str(e.make).trim()} ${str(e.model).trim()}`.trim().toLowerCase() === modelFilter.toLowerCase());
    return sortItems(l, sort.col, sort.dir, valueOf);
  }, [list, q, field, plat, slowOnly, modelFilter, sort, calc]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = filtered.slice(0, limit);
  const allShownSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.id));
  const sortBy = (col) => setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  const th = (col, label, isNum) => (
    <th key={col} className={`${isNum ? 'num' : ''} sortable`} onClick={() => sortBy(col)}>{label}{sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  );
  const editPath = (e) => (isSale ? `/sales/edit/${e.id}` : `/sales/inventory/edit/${e.id}`);
  const done = (m) => { setMsg(m); setErr(''); };

  async function setStatus(e, status) {
    if (isSale && status === 'Return to Inventory on Hand') {
      if (!confirm(`Move ${e.sku || e.model || 'this item'} back to Inventory on Hand? It will be removed from All Sales.`)) return;
      await moveTo([e.id], 'inventory');
      return;
    }
    try {
      const saved = (await api.patch(`/sales/items/${e.id}`, { data: { status } })).data.item;
      patch(kind, (l) => l.map((x) => (x.id === e.id ? saved : x)));
      done(`Status updated to ${status}.`);
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not update'); }
  }

  async function moveTo(ids, to) {
    setBusy('Moving…');
    try {
      const r = (await api.post('/sales/items/move', { ids, to })).data;
      setSelected(new Set());
      await reload();
      done(`Moved ${r.moved} item${r.moved === 1 ? '' : 's'} to ${to === 'sale' ? 'All Sales' : 'Inventory on Hand'}.`);
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not move'); } finally { setBusy(''); }
  }

  async function del(e) {
    if (!confirm(`Delete ${e.sku || e.model || 'this item'}? This cannot be undone.`)) return;
    try {
      await api.delete(`/sales/items/${e.id}`);
      patch(kind, (l) => l.filter((x) => x.id !== e.id));
      done('Deleted.');
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not delete'); }
  }

  function duplicate(e) {
    const keep = ['sku', 'itemtype', 'make', 'model', 'platform', 'listed', 'cost', 'ram', 'cpu', 'processor', 'capacity', 'colour', 'display', 'extra', 'batteryhealth', 'warranty', 'location', 'origin', 'packhandle', 'labour', 'adscost'];
    const prefill = {};
    keep.forEach((k) => { if (e[k]) prefill[k] = e[k]; });
    navigate(isSale ? '/sales/add' : '/sales/inventory/add', { state: { prefill, message: 'Duplicated — review the details and save as a new item.' } });
  }

  async function applyBulk() {
    const items = filteredSelected();
    if (!items.length) return;
    if (bulkAction === 'Bulk Edit…') { setBulkEdit(true); return; }
    if (bulkAction === 'Print Labels') {
      if (confirm(`Print ${items.length} label${items.length === 1 ? '' : 's'}? Make sure your DYMO printer is selected and has enough labels loaded.`)) printLabels(items);
      return;
    }
    if (bulkAction === 'Add to All Sales') {
      const ready = items.filter((it) => str(it.sellprice).trim());
      if (!ready.length) { setErr('None of the selected items have a Sell price yet — add one first.'); return; }
      const skipped = items.length - ready.length;
      if (!confirm(`Move ${ready.length} item${ready.length === 1 ? '' : 's'} to All Sales? They'll be removed from Inventory on Hand.${skipped ? ` (${skipped} skipped — no Sell price)` : ''}`)) return;
      await moveTo(ready.map((x) => x.id), 'sale');
      return;
    }
    if (!confirm(`Set status to "${bulkAction}" for ${items.length} item${items.length === 1 ? '' : 's'}?`)) return;
    await bulkUpdate(items.map((x) => x.id), { status: bulkAction });
  }
  const filteredSelected = () => (list || []).filter((e) => selected.has(e.id));

  async function bulkUpdate(ids, fields) {
    setBusy('Updating…');
    try {
      const r = (await api.post('/sales/items/bulk-update', { ids, fields })).data;
      setSelected(new Set());
      await reload();
      done(`Updated ${r.updated} item${r.updated === 1 ? '' : 's'}.`);
      return true;
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not update'); return false; } finally { setBusy(''); }
  }

  async function importCSV(evt) {
    const file = evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const rows = parseCSV(await file.text());
    if (rows.length < 2) { setErr('No data found in that file.'); return; }
    const recs = rowsToRecords(rows[0], rows.slice(1));
    if (!recs) { setErr('Column headings not recognised (use the same headings as Export CSV).'); return; }
    recs.forEach((r) => { delete r.id; if (!r.itemtype) r.itemtype = 'Other'; if (!r.platform) r.platform = 'Other'; });
    const dupes = allDuplicateSerials([...(sales || []), ...recs.map((r, i) => ({ ...r, id: `new${i}` }))], inventory || [])
      .filter((g) => g.records.some((x) => String(x.id).startsWith('new')));
    if (dupes.length && !confirm(`${dupes.length} serial number(s) in this file already exist or appear twice (e.g. ${dupes.slice(0, 5).map((d) => d.serial).join(', ')}). Import anyway?`)) return;
    setBusy('Importing…');
    try {
      const r = (await api.post('/sales/import', { kind, records: recs })).data;
      await reload();
      done(`Imported ${r.added} ${isSale ? 'sale' : 'item'}${r.added === 1 ? '' : 's'}.`);
    } catch (ex) { setErr(ex.response?.data?.error || 'Import failed'); } finally { setBusy(''); }
  }

  async function clearAll() {
    if (!list?.length) return;
    if (!confirm(`Delete ALL ${list.length} ${isSale ? 'sales' : 'inventory items'}? This cannot be undone.`)) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    try {
      await api.delete('/sales/items', { params: { kind, confirm: 'yes' } });
      await reload();
      done('All cleared.');
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not clear'); }
  }

  const menuItem = menu && (list || []).find((x) => x.id === menu.id);
  const totalsLine = useMemo(() => {
    if (!isSale) {
      const cost = filtered.reduce((s, e) => s + num(e.cost), 0);
      return `${fmtInt(filtered.length)} item${filtered.length === 1 ? '' : 's'} · ${fmt(cost)} total cost`;
    }
    const t = calc.totals(filtered);
    return `${fmtInt(t.count)} sale${t.count === 1 ? '' : 's'} · revenue ${fmt(t.revenue)} · net ${fmt(t.net)}`;
  }, [filtered, calc, isSale]);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>{isSale ? 'All Sales' : 'Inventory on Hand'}</h1>
          <div className="subtitle">{list ? totalsLine : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (isSale ? exportSales(filtered, calc, 'sales-export.csv') : exportInventory(filtered, 'inventory-export.csv'))}><Download size={14} /> Export CSV</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}><Upload size={14} /> Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={importCSV} />
          {isAdmin && <button type="button" className="btn btn-ghost btn-sm danger-text" onClick={clearAll}><Trash2 size={14} /> Clear all</button>}
          <Link to={isSale ? '/sales/add' : '/sales/inventory/add'} className="btn btn-accent"><Plus size={16} /> {isSale ? 'Add a sale' : 'Add item'}</Link>
        </div>
      </div>
      {(error || err) && <div className="error-banner">{error || err}</div>}
      {msg && <div className="success-banner" style={{ marginBottom: 12 }}><span>{msg}</span><button type="button" onClick={() => setMsg('')}><X size={15} /></button></div>}

      <div className="filters">
        <div className="search-input" style={{ flex: '1 1 240px' }}>
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search SKU, model, customer, serial…" />
        </div>
        <select value={field} onChange={(e) => setField(e.target.value)} aria-label="Search in">
          {SEARCH_FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={plat} onChange={(e) => setPlat(e.target.value)} aria-label="Platform">
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
        </select>
        {!isSale && (
          <label className="filter-toggle"><input type="checkbox" checked={slowOnly} onChange={(e) => setSlowOnly(e.target.checked)} /> <Clock size={13} /> 60+ days in stock</label>
        )}
        {modelFilter && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setModelFilter('')}>Model: {modelFilter} <X size={13} /></button>}
        {(q || plat || slowOnly || field !== 'all') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setField('all'); setPlat(''); setSlowOnly(false); }}>Clear filter</button>}
      </div>

      {selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
            {(isSale ? ['Sold', 'Pending', 'Refunded'] : INV_STATUSES).map((s) => <option key={s}>{s}</option>)}
            {!isSale && <option>Add to All Sales</option>}
            <option>Bulk Edit…</option>
            <option>Print Labels</option>
          </select>
          <button type="button" onClick={applyBulk} disabled={!!busy}>{busy || 'Apply to selected'}</button>
          <button type="button" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {loading ? <div className="panel panel-pad">Loading…</div> : (
        <div className="panel sales-table-wrap">
          <table className="ticket-table sales-table">
            <thead>
              <tr>
                <th className="c"><input type="checkbox" aria-label="Select all shown" checked={allShownSelected}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); filtered.forEach((x) => (e.target.checked ? n.add(x.id) : n.delete(x.id))); return n; })} /></th>
                {th('sku', 'SKU')}
                {!isSale && th('days', 'Days', true)}
                {th('itemtype', 'Item')}{th('make', 'Make')}{th('model', 'Model')}
                {SPEC_COLS.map(([k, l]) => th(k, l))}
                {th('batteryhealth', 'Battery')}{th('platform', 'Platform')}{th('orderno', 'Order#')}{th('customer', 'Customer')}
                {th('selldate', 'Sell date')}{th('listed', 'Listed', true)}{th('sellprice', 'Sell', true)}{th('extendedwarranty', 'Ext. warr.', true)}
                {th('cost', 'Cost', true)}{th('postage', 'Postage', true)}{th('fees', 'Fees', true)}{th('packhandle', 'Pack', true)}
                {th('labour', 'Labour', true)}{th('adscost', 'Ads', true)}
                {th('warranty', 'Warranty')}{th('location', 'Location')}{th('origin', 'Origin')}{th('addedby', 'Added by')}{th('lasteditedby', 'Last edited')}
                {isSale && <>{th('net', 'Net', true)}{th('margin', 'Margin', true)}</>}
                {th('status', 'Status')}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const n = isSale ? calc.net(e) : 0;
                const days = daysInStock(e);
                const statuses = isSale ? SALE_STATUSES : INV_STATUSES;
                const st = e.status || statuses[0];
                return (
                  <tr key={e.id} className={selected.has(e.id) ? 'mu-picked' : ''}>
                    <td className="c"><input type="checkbox" aria-label={`Select ${e.sku || e.model}`} checked={selected.has(e.id)}
                      onChange={(ev) => setSelected((s) => { const x = new Set(s); if (ev.target.checked) x.add(e.id); else x.delete(e.id); return x; })} /></td>
                    <td className="mono"><Link to={editPath(e)}>{e.sku || '—'}</Link></td>
                    {!isSale && <td className={`num ${days != null && days >= 60 ? 'neg' : ''}`} title={days >= 60 ? 'Sitting unsold for 60+ days' : ''}>{days != null ? `${days}` : '—'}</td>}
                    <td>{e.itemtype}</td><td>{e.make}</td><td className="cell-nowrap" title={e.model}>{e.model}</td>
                    {SPEC_COLS.map(([k, , m]) => <td key={k} className={`${m ? 'mono' : ''} cell-nowrap`} title={e[k]}>{e[k]}</td>)}
                    <td>{formatBatteryHealth(e.batteryhealth)}</td>
                    <td><span className={`plat-badge ${platformClass(e.platform)}`}>{e.platform}</span></td>
                    <td className="mono">{e.orderno}</td>
                    <td className="cell-nowrap">{e.customer ? <button type="button" className="linklike" title="See this customer's purchases" onClick={() => setCustomer(e.customer)}>{e.customer}</button> : ''}</td>
                    <td className="nowrap">{e.selldate ? auDate(e.selldate) : '—'}</td>
                    <td className="num">{fmt(e.listed)}</td><td className="num">{fmt(e.sellprice)}</td><td className="num">{fmt(e.extendedwarranty)}</td>
                    <td className="num">{fmt(e.cost)}</td><td className="num">{fmt(e.postage)}</td><td className="num">{fmt(e.fees)}</td><td className="num">{fmt(e.packhandle)}</td>
                    <td className="num">{fmt(isSale ? calc.labour(e) : e.labour)}</td><td className="num">{fmt(isSale ? calc.ads(e) : e.adscost)}</td>
                    <td>{e.warranty || 'No'}</td><td className="cell-nowrap" title={e.location}>{e.location}</td><td className="cell-nowrap" title={e.origin}>{e.origin}</td>
                    <td className="cell-nowrap">{e.addedby}</td><td className="cell-nowrap">{e.lasteditedby}</td>
                    {isSale && <><td className={`num ${n < 0 ? 'neg' : 'pos'}`}>{fmt(n)}</td><td className={`num ${n < 0 ? 'neg' : 'pos'}`}>{pct(calc.margin(e))}</td></>}
                    <td>
                      <select className={`status-pill s-${st.toLowerCase().replace(/ /g, '-')}`} value={statuses.includes(st) ? st : statuses[0]} onChange={(ev) => setStatus(e, ev.target.value)} aria-label="Status">
                        {statuses.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td><button type="button" className="row-menu-btn" aria-label="More actions" onClick={(ev) => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); setMenu({ id: e.id, x: r.right, y: r.bottom }); }}><MoreHorizontal size={16} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filtered.length && <div className="empty-state" style={{ padding: 30 }}>{list?.length ? 'Nothing matches these filters.' : `No ${isSale ? 'sales' : 'inventory'} yet.`}</div>}
          {filtered.length > limit && (
            <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="muted">Showing {fmtInt(limit)} of {fmtInt(filtered.length)}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + PAGE * 2)}>Show more</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit(filtered.length)}>Show all</button>
            </div>
          )}
        </div>
      )}

      {menuItem && (
        <div className="row-menu" style={{ top: Math.min(menu.y + 4, window.innerHeight - 260), right: window.innerWidth - menu.x }} onClick={(e) => e.stopPropagation()}>
          {!isSale && <button type="button" className="hl" onClick={() => { setMenu(null); if (!str(menuItem.sellprice).trim()) { navigate(editPath(menuItem)); setErr('Add a Sell price before moving this to All Sales.'); return; } if (confirm(`Move ${menuItem.sku || menuItem.model} to All Sales?`)) moveTo([menuItem.id], 'sale'); }}><ArrowRight size={14} /> Add to All Sales</button>}
          <button type="button" onClick={() => { setMenu(null); printItem(menuItem, isSale, calc); }}><Printer size={14} /> Print</button>
          <button type="button" onClick={() => { setMenu(null); printLabels([menuItem]); }}><Tag size={14} /> Label</button>
          <button type="button" onClick={() => { setMenu(null); duplicate(menuItem); }}><Copy size={14} /> Duplicate</button>
          <button type="button" onClick={() => { setMenu(null); navigate(editPath(menuItem)); }}><Pencil size={14} /> Edit</button>
          <button type="button" className="danger" onClick={() => { setMenu(null); del(menuItem); }}><Trash2 size={14} /> Delete</button>
        </div>
      )}

      {bulkEdit && <BulkEditModal kind={kind} count={selected.size} onClose={() => setBulkEdit(false)}
        onApply={async (fields) => { const ok = await bulkUpdate([...selected], fields); if (ok) setBulkEdit(false); }} />}
      {customer && <CustomerHistory name={customer} sales={sales || []} onClose={() => setCustomer(null)} />}
    </Layout>
  );
}

function BulkEditModal({ kind, count, onClose, onApply }) {
  const [on, setOn] = useState({});
  const [vals, setVals] = useState({});
  const fields = BULK_FIELDS.filter((x) => !x[3] || x[3] === kind);
  const active = Object.keys(on).filter((k) => on[k]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 640, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Bulk edit {count} selected</h3><button type="button" onClick={onClose}><X size={18} /></button></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Tick each field to change; it's set to the same value on every selected item. Unticked fields stay as they are.</p>
        <div className="bulk-edit-grid">
          {fields.map(([k, label, type]) => (
            <div key={k} className={`bulk-edit-row ${on[k] ? 'on' : ''}`}>
              <label className="mu-check"><input type="checkbox" checked={!!on[k]} onChange={(e) => setOn((p) => ({ ...p, [k]: e.target.checked }))} /> {label}</label>
              {Array.isArray(type) ? (
                <select disabled={!on[k]} value={vals[k] ?? type[0]} onChange={(e) => setVals((p) => ({ ...p, [k]: e.target.value }))}>{type.map((o) => <option key={o}>{o}</option>)}</select>
              ) : (
                <input disabled={!on[k]} type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} step="0.01" value={vals[k] ?? ''} onChange={(e) => setVals((p) => ({ ...p, [k]: e.target.value }))} />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
          <button type="button" className="btn btn-accent" style={{ flex: 1 }} disabled={!active.length}
            onClick={() => {
              const out = {};
              active.forEach((k) => { const t = fields.find((x) => x[0] === k)[2]; out[k] = vals[k] ?? (Array.isArray(t) ? t[0] : ''); });
              if (confirm(`Change ${active.length} field${active.length === 1 ? '' : 's'} on ${count} item${count === 1 ? '' : 's'}?`)) onApply(out);
            }}>Apply changes</button>
        </div>
      </div>
    </div>
  );
}

export function CustomerHistory({ name, sales, onClose }) {
  const n = str(name).trim().toLowerCase();
  const list = sales.filter((e) => str(e.customer).trim().toLowerCase() === n).sort((a, b) => str(b.selldate).localeCompare(str(a.selldate)));
  const spent = list.reduce((s, e) => s + num(e.sellprice) + num(e.extendedwarranty), 0);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 680, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Customer history — {name}</h3><button type="button" onClick={onClose}><X size={18} /></button></div>
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 12 }}>
          <div className="stat-card accent-blue"><div className="num">{fmtInt(list.length)}</div><div className="label">Purchase{list.length === 1 ? '' : 's'}</div></div>
          <div className="stat-card accent-green"><div className="num">{fmt(spent)}</div><div className="label">Total spent</div></div>
        </div>
        <div style={{ maxHeight: '50vh', overflow: 'auto' }}>
          <table className="ticket-table"><thead><tr><th>Date</th><th>SKU</th><th>Item</th><th className="num">Price</th><th>Status</th></tr></thead>
            <tbody>{list.map((e) => (
              <tr key={e.id}><td>{e.selldate ? auDate(e.selldate) : '—'}</td><td className="mono"><Link to={`/sales/edit/${e.id}`}>{e.sku || '—'}</Link></td>
                <td>{e.make} {e.model}</td><td className="num">{fmt(e.sellprice)}</td><td>{e.status || 'Sold'}</td></tr>
            ))}</tbody></table>
        </div>
      </div>
    </div>
  );
}

