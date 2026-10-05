import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, X, Copy, QrCode as QrIcon } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import QrCode from '../storage/QrCode';

// Old "Get client portal link": the same link for every client — they still
// sign in with their own username and password. Copy it, or show a QR code to
// scan or paste into an email.
function PortalLink() {
  const url = `${window.location.origin}/portal/login`;
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); } catch {
      const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="panel panel-pad" style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Client portal link</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: '1 1 280px', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}><Copy size={14} /> {copied ? 'Copied!' : 'Copy'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowQr((v) => !v)}><QrIcon size={14} /> {showQr ? 'Hide QR' : 'QR code'}</button>
      </div>
      {showQr && <div style={{ marginTop: 12 }}><QrCode text={url} size={180} title="Client portal QR code" /></div>}
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
        The same link for every client — each signs in with their own portal username and password to see their stock, orders and
        receiving/dispatch history and to submit orders. Prices and fees are not shown to clients.
      </p>
    </div>
  );
}

export default function StorageClients() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [clients, setClients] = useState(null);
  const [unlisted, setUnlisted] = useState([]);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [clientName, setClientName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function load() {
    api.get('/storage/clients').then((res) => { setClients(res.data.clients); setUnlisted(res.data.unlisted || []); });
  }

  // Adds names found on items/orders/etc. to the client list (no portal login).
  async function addToList(names) {
    setAdding(true);
    const failed = [];
    for (const name of names) {
      try { await api.post('/storage/clients', { clientName: name }); } catch (err) { failed.push(`${name}: ${err.response?.data?.error || 'failed'}`); }
    }
    setAdding(false);
    if (failed.length) alert(`Some clients weren't added:\n${failed.join('\n')}`);
    load();
  }
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
          <div className="subtitle">{clients ? `${clients.length} on the client list${unlisted.length ? ` · ${unlisted.length} more found on records` : ''}` : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> Add client</button>
        </div>
      </div>

      <PortalLink />

      <div className="panel" style={{ padding: 0 }}>
        {!clients ? (
          <div className="empty-state">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="empty-state"><h3>No clients yet</h3></div>
        ) : (
          <table className="ticket-table">
            <thead><tr><th>Client</th><th style={{ textAlign: 'right' }}>In storage</th><th>Username</th><th>Portal login</th><th>Added by</th><th></th></tr></thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => openEdit(c)}>
                  <td>{c.clientName}</td>
                  <td style={{ textAlign: 'right', color: c.inStorageCount ? undefined : 'var(--muted)' }} title={`${c.itemCount} item(s) on record`}>{c.inStorageCount}</td>
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

      {unlisted.length > 0 && (
        <div className="panel" style={{ padding: 0, marginTop: 16 }}>
          <div className="panel-pad" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: 15 }}>Not on the client list yet ({unlisted.length})</h3>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>These client names are used on items, pallet rates, orders or receiving/dispatch entries but were never added to the client list. Add them to give them a portal login.</div>
            </div>
            <button type="button" className="btn btn-accent btn-sm" disabled={adding}
              onClick={() => { if (confirm(`Add all ${unlisted.length} to the client list?`)) addToList(unlisted.map((u) => u.clientName)); }}>
              <Plus size={14} /> {adding ? 'Adding…' : 'Add all'}
            </button>
          </div>
          <table className="ticket-table">
            <thead><tr><th>Client</th><th style={{ textAlign: 'right' }}>In storage</th><th>Found on</th><th></th></tr></thead>
            <tbody>
              {unlisted.map((u) => (
                <tr key={u.clientName}>
                  <td>{u.clientName}</td>
                  <td style={{ textAlign: 'right' }} title={`${u.itemCount} item(s) on record`}>{u.inStorageCount}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{u.sources.join(', ')}</td>
                  <td><button type="button" className="btn btn-ghost btn-sm" disabled={adding} onClick={() => addToList([u.clientName])}><Plus size={13} /> Add</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
