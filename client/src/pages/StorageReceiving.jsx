import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, X, Boxes, Package, Users, ClipboardList, BarChart3 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function StorageReceiving() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [entries, setEntries] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function load() { api.get('/storage/receiving-dispatch').then((res) => setEntries(res.data.entries)); }
  useEffect(() => { load(); }, []);

  function openAdd() { setFormValues({}); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/storage/receiving-dispatch', formValues);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this entry?')) return;
    await api.delete(`/storage/receiving-dispatch/${id}`);
    load();
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Receiving / Dispatch</h1>
          <div className="subtitle">{entries ? `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/storage" className="btn btn-ghost btn-sm"><Boxes size={14} /> Manifest</Link>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <Link to="/storage/reports" className="btn btn-ghost btn-sm"><BarChart3 size={14} /> Reports</Link>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> New entry</button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
        Stock type fields accept the old app's shorthand, e.g. <code>Boxes: 5 @ 10; Pallets: 2 @ 25</code> — each <code>Type: Qty @ Rate</code> pair is summed into the client's receiving/dispatch fee on the Reports page.
      </p>

      <div className="panel" style={{ padding: 0 }}>
        {!entries ? (
          <div className="empty-state">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty-state"><h3>No entries yet</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Client</th><th>Date Received</th><th>Date Dispatched</th><th>Rate</th>
                  <th>Receiving</th><th>Dispatch</th><th>Saved By</th><th>Saved On</th><th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.client}</td>
                    <td>{e.dateReceived}</td>
                    <td>{e.dateDispatched}</td>
                    <td>{e.rate}</td>
                    <td>{e.receiving}</td>
                    <td>{e.dispatch}</td>
                    <td style={{ color: 'var(--muted)' }}>{e.savedBy}</td>
                    <td style={{ color: 'var(--muted)' }}>{e.savedOn}</td>
                    <td>
                      {isAdmin && (
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(e.id)}><Trash2 size={13} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => !saving && setShowForm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <h3>New Receiving / Dispatch entry</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSave}>
              <div className="form-grid">
                <div className="field"><label>Client</label><input value={formValues.client ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, client: e.target.value }))} required /></div>
                <div className="field"><label>Rate</label><input type="number" step="0.01" value={formValues.rate ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, rate: e.target.value }))} /></div>
                <div className="field"><label>Date Received</label><input type="date" value={formValues.dateReceived ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, dateReceived: e.target.value }))} /></div>
                <div className="field"><label>Date Dispatched</label><input type="date" value={formValues.dateDispatched ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, dateDispatched: e.target.value }))} /></div>
                <div className="field span-2"><label>Receiving (e.g. Boxes: 5 @ 10; Pallets: 2 @ 25)</label><input value={formValues.receiving ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, receiving: e.target.value }))} /></div>
                <div className="field span-2"><label>Dispatch (same format)</label><input value={formValues.dispatch ?? ''} onChange={(e) => setFormValues((p) => ({ ...p, dispatch: e.target.value }))} /></div>
              </div>
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Save'}</button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
