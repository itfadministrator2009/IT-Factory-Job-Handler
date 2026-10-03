import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, Pencil, X, Boxes, Package, ClipboardList } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function StorageClients() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [clients, setClients] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [clientName, setClientName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function load() { api.get('/storage/clients').then((res) => setClients(res.data.clients)); }
  useEffect(() => { load(); }, []);

  function openAdd() { setEditing(null); setClientName(''); setUsername(''); setPassword(''); setError(''); setShowForm(true); }
  function openEdit(c) { setEditing(c); setClientName(c.clientName); setUsername(c.username || ''); setPassword(''); setError(''); setShowForm(true); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { clientName, username: username || null };
      if (password) payload.password = password;
      if (editing) await api.patch(`/storage/clients/${editing.id}`, payload);
      else await api.post('/storage/clients', payload);
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
    if (!confirm('Delete this client?')) return;
    await api.delete(`/storage/clients/${id}`);
    load();
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Clients</h1>
          <div className="subtitle">{clients ? `${clients.length} client${clients.length === 1 ? '' : 's'}` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/storage" className="btn btn-ghost btn-sm"><Boxes size={14} /> Manifest</Link>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> Add client</button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
        Clients with a portal login sign in at <a href={`${window.location.origin}/portal/login`} target="_blank" rel="noreferrer">{window.location.origin}/portal/login</a> to
        see their stock, orders and receiving/dispatch history and to submit orders. Prices and fees are not shown to clients.
      </p>

      <div className="panel" style={{ padding: 0 }}>
        {!clients ? (
          <div className="empty-state">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="empty-state"><h3>No clients yet</h3></div>
        ) : (
          <table className="ticket-table">
            <thead><tr><th>Client</th><th>Username</th><th>Portal login</th><th>Added by</th><th></th></tr></thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => openEdit(c)}>
                  <td>{c.clientName}</td>
                  <td>{c.username || '—'}</td>
                  <td>{c.hasPortalLogin ? 'Enabled' : '—'}</td>
                  <td style={{ color: 'var(--muted)' }}>{c.addedBy || '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={() => openEdit(c)}><Pencil size={13} /></button>
                      {isAdmin && (
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={(e) => handleDelete(c.id, e)}><Trash2 size={13} /></button>
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
              <h3>{editing ? 'Edit client' : 'Add client'}</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSave}>
              <div className="form-grid">
                <div className="field"><label>Client name</label><input value={clientName} onChange={(e) => setClientName(e.target.value)} required /></div>
                <div className="field"><label>Portal username (optional)</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
                <div className="field"><label>Portal password (8+ characters){editing ? ' — leave blank to keep' : ''}</label><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              </div>
              {editing?.hasPortalLogin && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12, color: 'var(--danger)' }} disabled={saving}
                  onClick={async () => {
                    if (!confirm(`Remove portal access for ${editing.clientName}? They will be signed out straight away.`)) return;
                    setSaving(true);
                    try { await api.patch(`/storage/clients/${editing.id}`, { removePortalAccess: true }); setShowForm(false); load(); }
                    catch (err) { setError(err.response?.data?.error || 'Could not remove access'); }
                    finally { setSaving(false); }
                  }}>
                  Remove portal access
                </button>
              )}
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Save'}</button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}
