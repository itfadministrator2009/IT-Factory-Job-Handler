import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, Trash2, Pencil, X, Users, Package, ClipboardList } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

const FIELDS = [
  ['client', 'Client', 'text'],
  ['jobNumber', 'Job Number', 'text'],
  ['referenceNumber', 'Reference Number', 'text'],
  ['storageCentre', 'ITF Storage Centre', 'text'],
  ['location', 'Location', 'text'],
  ['quantity', 'Quantity', 'text'],
  ['condition', 'Condition', 'text'],
  ['item', 'Item', 'text'],
  ['make', 'Make', 'text'],
  ['model', 'Model', 'text'],
  ['serial', 'Serial', 'text'],
  ['priceWeek', 'Storage Price Per Week (ex GST)', 'number'],
  ['startDate', 'Storage Start Date', 'date'],
  ['endDate', 'Storage End Date', 'date'],
  ['assetTag', 'Asset Tag', 'text'],
  ['poNumber', 'PO Number', 'text'],
  ['orderNumber', 'Order Number', 'text'],
];

const SUMMARY_KEYS = ['client', 'item', 'make', 'model', 'serial', 'location', 'quantity', 'priceWeek', 'startDate', 'endDate'];

export default function StorageManifest() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';

  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function loadItems() {
    api.get('/storage/items').then((res) => setItems(res.data.items));
  }
  useEffect(() => { loadItems(); }, []);

  const filtered = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => Object.values(it).some((v) => v && String(v).toLowerCase().includes(q)));
  }, [items, query]);

  function openAdd() { setEditing(null); setFormValues({}); setError(''); setShowForm(true); }
  function openEdit(it) { setEditing(it); setFormValues({ ...it }); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = { ...formValues };
    if (editing) payload.lastEditedBy = user?.name; else payload.addedBy = user?.name;
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
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  async function handleBulkDelete() {
    if (!confirm(`Delete ${selected.size} selected item(s)?`)) return;
    await api.post('/storage/items/bulk-delete', { ids: Array.from(selected) });
    setSelected(new Set());
    loadItems();
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Manifest</h1>
          <div className="subtitle">{items ? `${items.length} item${items.length === 1 ? '' : 's'} on file` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> Add item</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 240, alignItems: 'center' }}>
          <Search size={14} style={{ marginLeft: 4 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search client, item, serial, location…" style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }} />
        </div>
      </div>

      {isAdmin && selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <button type="button" onClick={handleBulkDelete} style={{ color: 'var(--danger)' }}><Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Delete</button>
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        {!items ? (
          <div className="empty-state">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state"><h3>No items found</h3></div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                {isAdmin && <th style={{ width: 32 }}></th>}
                {SUMMARY_KEYS.map((k) => <th key={k}>{FIELDS.find((f) => f[0] === k)?.[1] || k}</th>)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id} className="clickable" onClick={() => openEdit(it)}>
                  {isAdmin && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleSelect(it.id)} />
                    </td>
                  )}
                  {SUMMARY_KEYS.map((k) => <td key={k}>{it[k] ?? ''}</td>)}
                  <td onClick={(e) => e.stopPropagation()}>
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
        )}
      </div>

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
                {FIELDS.map(([key, label, type]) => (
                  <div className="field" key={key}>
                    <label>{label}</label>
                    <input
                      type={type}
                      value={formValues[key] ?? ''}
                      onChange={(e) => setFormValues((p) => ({ ...p, [key]: e.target.value }))}
                      step={type === 'number' ? '0.01' : undefined}
                    />
                  </div>
                ))}
              </div>
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
