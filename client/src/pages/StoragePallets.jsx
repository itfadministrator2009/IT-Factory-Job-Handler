import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, X } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

const FIELDS = [
  ['client', 'Client', 'text'],
  ['storageCentre', 'ITF Storage Centre', 'text'],
  ['location', 'Location', 'text'],
  ['priceWeek', 'Weekly Rate (ex GST)', 'number'],
  ['startDate', 'Storage Start Date', 'date'],
  ['endDate', 'Storage End Date', 'date'],
  ['notes', 'Notes', 'text'],
];

export default function StoragePallets() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [pallets, setPallets] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function load() { api.get('/storage/pallets').then((res) => setPallets(res.data.pallets)); }
  useEffect(() => { load(); }, []);

  function openAdd() { setEditing(null); setFormValues({}); setError(''); setShowForm(true); }
  function openEdit(p) { setEditing(p); setFormValues({ ...p }); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = { ...formValues };
    if (editing) payload.lastEditedBy = user?.name; else payload.addedBy = user?.name;
    try {
      if (editing) await api.patch(`/storage/pallets/${editing.id}`, payload);
      else await api.post('/storage/pallets', payload);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this pallet?')) return;
    await api.delete(`/storage/pallets/${id}`);
    load();
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Pallets</h1>
          <div className="subtitle">{pallets ? `${pallets.length} pallet${pallets.length === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> Add pallet</button>
        </div>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {!pallets ? (
          <div className="empty-state">Loading…</div>
        ) : pallets.length === 0 ? (
          <div className="empty-state"><h3>No pallets yet</h3></div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>{FIELDS.map(([k, label]) => <th key={k}>{label}</th>)}<th></th></tr>
            </thead>
            <tbody>
              {pallets.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => openEdit(p)}>
                  {FIELDS.map(([k]) => <td key={k}>{p[k] ?? ''}</td>)}
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={() => openEdit(p)}><Pencil size={13} /></button>
                      {isAdmin && (
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={(e) => handleDelete(p.id, e)}><Trash2 size={13} /></button>
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
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Edit pallet' : 'Add pallet'}</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSave}>
              <div className="form-grid">
                {FIELDS.map(([key, label, type]) => (
                  <div className="field" key={key}>
                    <label>{label}</label>
                    <input type={type} value={formValues[key] ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, [key]: e.target.value }))} step={type === 'number' ? '0.01' : undefined} />
                  </div>
                ))}
              </div>
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Save'}</button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
