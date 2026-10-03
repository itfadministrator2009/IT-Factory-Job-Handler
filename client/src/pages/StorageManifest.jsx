import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus, Search, Trash2, Pencil, X, Users, Package, ClipboardList, Upload, DollarSign, AlertTriangle,
  Wand2, Download, Printer, QrCode, LogOut as MarkOut, LogIn as MarkIn, Edit3,
} from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import {
  ITEM_FIELDS, dmy, money, naturalCompare, downloadCsv, itemStatus, weeksStored, findDuplicateGroups, isInStorage,
} from '../storage/common';
import ItemRatesDrawer from '../storage/ItemRatesDrawer';
import BillingGapsDrawer from '../storage/BillingGapsDrawer';
import ModelCleanupDrawer from '../storage/ModelCleanupDrawer';
import ImportDrawer from '../storage/ImportDrawer';
import BulkEditDrawer from '../storage/BulkEditDrawer';

const PAGE = 200;
const sydneyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

function StatusPill({ item }) {
  const s = itemStatus(item);
  if (!s) return null;
  const inStorage = s === 'In storage';
  return <span className="pill" style={{ background: inStorage ? '#DDEEFB' : '#E1F0E6', color: inStorage ? '#2C6FA8' : '#2F7A44', whiteSpace: 'nowrap' }}>{s}</span>;
}

export default function StorageManifest() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  // Exact location (from a scanned pallet label), not a free-text match.
  const [locationFilter, setLocationFilter] = useState(params.get('location') || '');
  const [clientFilter, setClientFilter] = useState(params.get('client') || '');
  const [centreFilter, setCentreFilter] = useState(params.get('centre') || '');
  const [statusFilter, setStatusFilter] = useState(params.get('location') ? 'In storage' : '');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState(new Set());
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tool, setTool] = useState(null);
  // A scanned pallet label (?client=&centre=&location=) — the old QR deep link.
  const [scanned] = useState(() => (params.get('location') ? { client: params.get('client') || '', centre: params.get('centre') || '', location: params.get('location') } : null));
  const [showScanned, setShowScanned] = useState(!!scanned);

  function loadItems() {
    return api.get('/storage/items').then((res) => setItems(res.data.items));
  }
  useEffect(() => { loadItems(); }, []);
  useEffect(() => { if (scanned) setParams({}, { replace: true }); }, [scanned, setParams]);
  // Changing what's shown clears the selection, so bulk actions only ever
  // touch items you can see.
  useEffect(() => { setSelected(new Set()); setLimit(PAGE); }, [query, clientFilter, centreFilter, statusFilter, locationFilter]);

  const clients = useMemo(() => [...new Set((items || []).map((i) => i.client).filter(Boolean))].sort(naturalCompare), [items]);
  const centres = useMemo(() => [...new Set((items || []).map((i) => i.storageCentre).filter(Boolean))].sort(naturalCompare), [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (clientFilter && it.client !== clientFilter) return false;
      if (centreFilter && String(it.storageCentre || '').trim().toLowerCase() !== centreFilter.trim().toLowerCase()) return false;
      if (statusFilter && itemStatus(it) !== statusFilter) return false;
      if (locationFilter && String(it.location || '').trim().toLowerCase() !== locationFilter.trim().toLowerCase()) return false;
      if (!q) return true;
      return ITEM_FIELDS.some(([k]) => it[k] != null && String(k.endsWith('Date') ? dmy(it[k]) : it[k]).toLowerCase().includes(q));
    });
  }, [items, query, clientFilter, centreFilter, statusFilter, locationFilter]);

  const dupGroups = useMemo(() => findDuplicateGroups(items || []), [items]);
  const dupIds = useMemo(() => new Set(dupGroups.flatMap((g) => g.items.map((i) => i.id))), [dupGroups]);

  const stats = useMemo(() => {
    const inStore = filtered.filter(isInStorage);
    const byType = {};
    inStore.forEach((i) => { const k = i.item || '(no item type)'; byType[k] = (byType[k] || 0) + (Number(i.quantity) || 1); });
    return {
      inStorage: inStore.length,
      clients: new Set(inStore.map((i) => i.client).filter(Boolean)).size,
      qty: inStore.reduce((t, i) => t + (Number(i.quantity) || 0), 0),
      byType: Object.entries(byType).sort((a, b) => b[1] - a[1]),
    };
  }, [filtered]);

  function openAdd(prefill = {}) { setEditing(null); setFormValues({ startDate: sydneyToday(), ...prefill }); setError(''); setShowForm(true); }
  function openEdit(it) { setEditing(it); setFormValues({ ...it }); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = { ...formValues };
    ITEM_FIELDS.forEach(([k]) => { if (payload[k] === '') payload[k] = null; });
    if (editing) payload.lastEditedBy = user?.name; else { payload.addedBy = user?.name; payload.lastEditedBy = user?.name; }
    try {
      if (editing) await api.patch(`/storage/items/${editing.id}`, payload);
      else await api.post('/storage/items', payload);
      setShowForm(false);
      loadItems();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this item?')) return;
    await api.delete(`/storage/items/${id}`);
    loadItems();
  }

  function toggleSelect(id) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const visible = filtered.slice(0, limit);
  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));
  function toggleAllVisible() {
    setSelected((prev) => { const n = new Set(prev); visible.forEach((i) => (allVisibleSelected ? n.delete(i.id) : n.add(i.id))); return n; });
  }

  async function bulk(updates, label) {
    if (!confirm(`${label} for ${selected.size} selected item(s)?`)) return;
    try {
      await api.patch('/storage/items/bulk-edit', { ids: [...selected], updates });
      setSelected(new Set());
      loadItems();
    } catch (err) { alert(err.response?.data?.error || 'Could not update the items'); }
  }
  async function bulkSet(field, label) {
    const v = prompt(`${label} for ${selected.size} selected item(s):`);
    if (v == null) return;
    bulk({ [field]: v.trim() }, `Set ${label} to "${v.trim()}"`);
  }
  async function handleBulkDelete() {
    if (!confirm(`Delete ${selected.size} selected item(s)? This cannot be undone.`)) return;
    await api.post('/storage/items/bulk-delete', { ids: Array.from(selected) });
    setSelected(new Set());
    loadItems();
  }

  function exportCsv() {
    downloadCsv('storage-manifest-export.csv', [
      [...ITEM_FIELDS.map(([, l]) => l), 'Weeks stored', 'Status', 'Added by', 'Last edited by'],
      ...filtered.map((i) => [...ITEM_FIELDS.map(([k]) => (k.endsWith('Date') ? dmy(i[k]) : i[k])), weeksStored(i), itemStatus(i), i.addedBy, i.lastEditedBy]),
    ]);
  }

  const hasFilters = query || clientFilter || centreFilter || statusFilter || locationFilter;
  const sameLoc = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const scannedItems = scanned ? (items || []).filter((i) => sameLoc(i.location, scanned.location) && (!scanned.centre || sameLoc(i.storageCentre, scanned.centre)) && isInStorage(i) && (!scanned.client || i.client === scanned.client)).length : 0;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Manifest</h1>
          <div className="subtitle">{items ? `${items.length} item${items.length === 1 ? '' : 's'} on file` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <button className="btn btn-accent" onClick={() => openAdd()}><Plus size={16} /> Add item</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }} className="no-print">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTool('import')}><Upload size={14} /> Import stock</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTool('rates')}><DollarSign size={14} /> Item rates</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTool('gaps')}><AlertTriangle size={14} /> Billing gaps</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTool('models')}><Wand2 size={14} /> Clean up model names</button>
        <Link to="/storage/labels" className="btn btn-ghost btn-sm"><QrCode size={14} /> Pallet labels (QR)</Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!filtered.length}><Download size={14} /> Export CSV</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
      </div>

      {scanned && showScanned && (
        <div className="panel panel-pad" style={{ background: '#e6edf9', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            Scanned: <strong>{scanned.location}</strong>{scanned.centre ? ` at ${scanned.centre}` : ''}{scanned.client ? <> for <strong>{scanned.client}</strong></> : ''}. Showing what's currently on it below ({scannedItems} item{scannedItems === 1 ? '' : 's'}).
          </div>
          <button type="button" className="btn btn-accent btn-sm" onClick={() => openAdd({ client: scanned.client, storageCentre: scanned.centre, location: scanned.location })}><Plus size={14} /> Add item to this pallet</button>
          <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={() => setShowScanned(false)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {dupGroups.length > 0 && (
        <div className="error-banner" style={{ display: 'block' }}>
          <strong>{dupIds.size} possible duplicate item(s) found</strong> among items in storage — same serial, or (with no serial) the same client, job, reference and item:
          <ul style={{ margin: '6px 0 0 18px' }}>
            {dupGroups.slice(0, 8).map((g) => <li key={g.key}>{g.label} ({g.items.length} matching items)</li>)}
            {dupGroups.length > 8 && <li>+ {dupGroups.length - 8} more group(s)</li>}
          </ul>
        </div>
      )}

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <div className="stat-card"><div className="num">{stats.inStorage}</div><div className="label">Items in storage</div></div>
        <div className="stat-card"><div className="num">{stats.clients}</div><div className="label">Clients</div></div>
        <div className="stat-card"><div className="num">{stats.qty}</div><div className="label">Total quantity</div></div>
      </div>
      {clientFilter && stats.byType.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {stats.byType.map(([k, n]) => <span key={k} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', fontSize: 12 }}>{k}: <strong>{n}</strong></span>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }} className="no-print">
        <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 240, alignItems: 'center' }}>
          <Search size={14} style={{ marginLeft: 4 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search client, item, serial, location…" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }} />
        </div>
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '9px 10px' }}>
          <option value="">All clients</option>
          {clients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={centreFilter} onChange={(e) => setCentreFilter(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '9px 10px' }}>
          <option value="">All storage centres</option>
          {centres.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '9px 10px' }}>
          <option value="">Any status</option>
          <option value="In storage">In storage</option>
          <option value="Out of Storage">Out of Storage</option>
        </select>
        {locationFilter && (
          <span className="chip active" style={{ cursor: 'default' }}>
            Location: {locationFilter}
            <button type="button" onClick={() => setLocationFilter('')} aria-label="Clear location" style={{ background: 'none', border: 'none', color: 'inherit', marginLeft: 6, cursor: 'pointer', padding: 0 }}>×</button>
          </span>
        )}
        {hasFilters && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQuery(''); setClientFilter(''); setCentreFilter(''); setStatusFilter(''); setLocationFilter(''); }}>Clear filters</button>}
      </div>

      {selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <button type="button" onClick={() => bulk({ status: 'out' }, 'Mark Out of Storage (end date today)')}><MarkOut size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Mark out</button>
          <button type="button" onClick={() => bulk({ status: 'in' }, 'Mark In storage (clear end date)')}><MarkIn size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Mark in</button>
          <button type="button" onClick={() => bulkSet('poNumber', 'PO #')}>Set PO #</button>
          <button type="button" onClick={() => bulkSet('orderNumber', 'Order #')}>Set Order #</button>
          <button type="button" onClick={() => setTool('bulk')}><Edit3 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Bulk edit</button>
          {isAdmin && <button type="button" onClick={handleBulkDelete} style={{ color: 'var(--danger)' }}><Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Delete</button>}
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        {!items ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><h3>No items found</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }} className="no-print"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all shown" /></th>
                  <th>Client</th><th>Job #</th><th>Item</th><th>Make</th><th>Model</th><th>Serial</th><th>Storage centre</th><th>Location</th>
                  <th>Qty</th><th style={{ textAlign: 'right' }}>$/wk</th><th>Start</th><th>End</th><th>Status</th>
                  <th className="no-print"></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((it) => (
                  <tr key={it.id} className="clickable" onClick={() => openEdit(it)} style={dupIds.has(it.id) ? { background: '#fbe9e4' } : undefined}>
                    <td onClick={(e) => e.stopPropagation()} className="no-print">
                      <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} />
                    </td>
                    <td>{it.client}{dupIds.has(it.id) && <span className="pill" style={{ marginLeft: 6, background: '#f6d2c7', color: 'var(--danger)' }}>Duplicate</span>}</td>
                    <td>{it.jobNumber}</td><td>{it.item}</td><td>{it.make}</td><td>{it.model}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{it.serial}</td>
                    <td>{it.storageCentre}</td><td>{it.location}</td><td>{it.quantity}</td>
                    <td style={{ textAlign: 'right' }}>{Number(it.priceWeek) > 0 ? money(it.priceWeek) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.startDate)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{dmy(it.endDate)}</td>
                    <td><StatusPill item={it} /></td>
                    <td onClick={(e) => e.stopPropagation()} className="no-print">
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={() => openEdit(it)}><Pencil size={13} /></button>
                        {isAdmin && (
                          <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={(e) => handleDelete(it.id, e)}><Trash2 size={13} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {filtered.length > limit && (
        <div style={{ textAlign: 'center', margin: '12px 0' }} className="no-print">
          <span style={{ fontSize: 13, color: 'var(--muted)', marginRight: 10 }}>Showing {limit} of {filtered.length}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit((l) => l + PAGE)}>Show more</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit(filtered.length)}>Show all</button>
        </div>
      )}

      {showForm && (
        <div className="modal-overlay" onClick={() => !saving && setShowForm(false)}>
          <div className="modal-card sign-off-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, width: '95vw', height: '88vh' }}>
            <div className="modal-header">
              <h3>{editing ? 'Edit item' : 'Add item'}</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSave} className="sign-off-scroll">
              <div className="form-grid">
                {ITEM_FIELDS.map(([key, label, type]) => (
                  <div className="field" key={key}>
                    <label>{label}</label>
                    <input
                      type={type}
                      value={formValues[key] ?? ''}
                      onChange={(e) => setFormValues((p) => ({ ...p, [key]: e.target.value }))}
                      step={type === 'number' ? '0.01' : undefined}
                      list={key === 'client' ? 'manifest-clients' : key === 'storageCentre' ? 'manifest-centres' : undefined}
                    />
                  </div>
                ))}
              </div>
              <datalist id="manifest-clients">{clients.map((c) => <option key={c} value={c} />)}</datalist>
              <datalist id="manifest-centres">{centres.map((c) => <option key={c} value={c} />)}</datalist>
              {editing && (
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                  {[editing.addedBy && `Added by ${editing.addedBy}`, editing.lastEditedBy && `last edited by ${editing.lastEditedBy}`, editing.startDate && `${weeksStored(editing)} week(s) stored`].filter(Boolean).join(' · ')}
                </div>
              )}
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </form>
          </div>
        </div>
      )}

      {tool === 'rates' && <ItemRatesDrawer items={items || []} userName={user?.name} onClose={() => setTool(null)} onSaved={loadItems} />}
      {tool === 'gaps' && <BillingGapsDrawer onClose={() => setTool(null)} onEdit={(i) => { setTool(null); const full = (items || []).find((x) => x.id === i.id); if (full) openEdit(full); }} />}
      {tool === 'models' && <ModelCleanupDrawer clients={clients} onClose={() => setTool(null)} onChanged={loadItems} />}
      {tool === 'import' && <ImportDrawer items={items || []} onClose={() => setTool(null)} onImported={loadItems} />}
      {tool === 'bulk' && (
        <BulkEditDrawer items={(items || []).filter((i) => selected.has(i.id))} onClose={() => setTool(null)}
          onDone={() => { setTool(null); setSelected(new Set()); loadItems(); }} />
      )}
    </Layout>
  );
}
