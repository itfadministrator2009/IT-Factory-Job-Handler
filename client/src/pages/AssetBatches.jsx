import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Layers, FileText, Download, Pencil, Trash2, X, ExternalLink } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import { downloadFile } from '../utils/pdf';

// ITF Asset Tracker — allocation batches: named groups of assets for an order or
// an allocation (ITF Australia, Wholesale…), each with a packing list PDF.
// Batches are made from the Asset Tracker: tick assets (e.g. after a bulk serial
// search) → "Add to batch…".
const batchNo = (n) => `B-${String(n || '').padStart(4, '0')}`;
const when = (s) => {
  const d = new Date(`${String(s || '').replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
};

export default function AssetBatches() {
  const { id } = useParams();
  return id ? <BatchDetail id={id} /> : <BatchList />;
}

function BatchList() {
  const navigate = useNavigate();
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { api.get('/assets/batches').then((r) => setBatches(r.data.batches)).catch(() => setError('Could not load batches')); }, []);
  const shown = (batches || []).filter((b) => !q.trim() || [b.name, b.notes, batchNo(b.number), b.createdBy].some((v) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Allocation batches</h1>
          <div className="subtitle">Groups of assets for an order or an allocation, each with a packing list. To make one, tick assets in the Asset Tracker (or run a bulk serial search) and choose “Add to batch…”.</div>
        </div>
        <Link to="/assets" className="btn btn-ghost">Go to Asset Tracker</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search batches…" style={{ width: '100%', maxWidth: 420, marginBottom: 14, border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }} />
      <div className="panel" style={{ padding: 0 }}>
        {!batches ? <div className="empty-state">Loading…</div> : shown.length === 0 ? (
          <div className="empty-state"><h3>{batches.length ? 'No batches match' : 'No batches yet'}</h3>{!batches.length && <p>Tick some assets in the Asset Tracker and choose “Add to batch…”.</p>}</div>
        ) : (
          <table className="ticket-table">
            <thead><tr><th>Batch</th><th>Name</th><th style={{ textAlign: 'right' }}>Assets</th><th>Created</th><th>By</th></tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => navigate(`/assets/batches/${b.id}`)}>
                  <td style={{ whiteSpace: 'nowrap' }}><Link to={`/assets/batches/${b.id}`}>{batchNo(b.number)}</Link></td>
                  <td><Link to={`/assets/batches/${b.id}`} style={{ color: 'inherit', fontWeight: 600 }}>{b.name}</Link>{b.notes && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{b.notes}</div>}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{b.count}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--muted)' }}>{when(b.createdAt)}</td>
                  <td>{b.createdBy || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

function BatchDetail({ id }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [editing, setEditing] = useState(null); // { name, notes }

  const load = () => api.get(`/assets/batches/${id}`).then((r) => { setData(r.data); setSelected(new Set()); }).catch((err) => setError(err.response?.data?.error || 'Could not load the batch'));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Layout><Link to="/assets/batches" className="back-link">&larr; All batches</Link><div className="error-banner">{error}</div></Layout>;
  if (!data) return <Layout><div className="empty-state">Loading…</div></Layout>;
  const { batch, items } = data;
  const fileName = `${batchNo(batch.number)} ${batch.name}`.replace(/[^A-Za-z0-9._ -]+/g, '_');
  const live = items.filter((i) => !i.deleted);
  const allTicked = items.length > 0 && items.every((i) => selected.has(i.assetId));
  const toggle = (aid) => setSelected((p) => { const n = new Set(p); if (n.has(aid)) n.delete(aid); else n.add(aid); return n; });

  async function exportCsv() {
    const res = await api.post('/assets/export', { ids: live.map((i) => i.assetId) }, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `${fileName}.csv`; document.body.appendChild(a); a.click(); a.remove();
  }
  async function removeTicked() {
    if (!confirm(`Take ${selected.size} asset(s) out of this batch? The assets themselves are not changed.`)) return;
    await api.post(`/assets/batches/${id}/remove`, { assetIds: Array.from(selected) });
    load();
  }
  async function saveEdit() {
    try { await api.patch(`/assets/batches/${id}`, editing); setEditing(null); load(); } catch (err) { alert(err.response?.data?.error || 'Could not save'); }
  }
  async function deleteBatch() {
    if (!confirm(`Delete batch ${batchNo(batch.number)} “${batch.name}”? Only the grouping is removed — the assets stay as they are.`)) return;
    await api.delete(`/assets/batches/${id}`);
    navigate('/assets/batches');
  }

  return (
    <Layout>
      <Link to="/assets/batches" className="back-link">&larr; All batches</Link>
      <div className="page-header">
        <div>
          <h1><Layers size={20} style={{ verticalAlign: -3, marginRight: 8 }} />{batchNo(batch.number)} · {batch.name}</h1>
          <div className="subtitle">{batch.count} asset{batch.count === 1 ? '' : 's'} · created {when(batch.createdAt)}{batch.createdBy ? ` by ${batch.createdBy}` : ''}{batch.notes ? ` · ${batch.notes}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-accent" onClick={() => downloadFile(api, `/assets/batches/${id}/pdf?download=1`, `${fileName} packing list.pdf`).catch(() => alert('Could not make the packing list'))}><FileText size={15} /> Packing list PDF</button>
          <button type="button" className="btn btn-ghost" onClick={exportCsv} disabled={!live.length}><Download size={15} /> Export CSV</button>
          <Link to={`/assets?batch=${id}`} className="btn btn-ghost"><ExternalLink size={15} /> Open in Asset Tracker</Link>
          {isAdmin && <button type="button" className="btn btn-ghost" onClick={() => setEditing({ name: batch.name, notes: batch.notes })}><Pencil size={15} /> Rename</button>}
          {isAdmin && <button type="button" className="btn btn-ghost" style={{ color: 'var(--danger)' }} onClick={deleteBatch}><Trash2 size={15} /> Delete batch</button>}
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: -6, marginBottom: 12 }}>
        To change these assets together (e.g. set Asset Sent To, Status and Buyer), use <strong>Open in Asset Tracker</strong> — it shows just this batch with the bulk tools.
      </p>

      {isAdmin && selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <button type="button" onClick={removeTicked} style={{ color: 'var(--danger)' }}><X size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Remove from batch</button>
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        {items.length === 0 ? <div className="empty-state"><h3>This batch is empty</h3></div> : (
          <table className="ticket-table">
            <thead><tr>
              {isAdmin && <th style={{ width: 32 }}><input type="checkbox" checked={allTicked} onChange={() => setSelected(allTicked ? new Set() : new Set(items.map((i) => i.assetId)))} /></th>}
              <th>#</th><th>Asset tag</th><th>Class</th><th>Make / model</th><th>Serial</th><th>Customer</th><th>Status</th><th>Sent to</th>
            </tr></thead>
            <tbody>
              {items.map((it, i) => {
                const f = it.fields;
                return (
                  <tr key={it.itemId} style={it.deleted ? { opacity: 0.55 } : undefined}>
                    {isAdmin && <td><input type="checkbox" checked={selected.has(it.assetId)} onChange={() => toggle(it.assetId)} /></td>}
                    <td style={{ color: 'var(--muted)' }}>{i + 1}</td>
                    <td>{f.asset_tag}</td>
                    <td>{f.category}</td>
                    <td>{[f.manufacturer, f.model_name || f.model_number].filter(Boolean).join(' ')}</td>
                    <td style={{ fontFamily: 'monospace' }}>{f.serial_number}</td>
                    <td>{f.customer}</td>
                    <td>{it.deleted ? <em>asset deleted</em> : f.status}</td>
                    <td>{f.asset_sent_to}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header"><h3>Rename batch</h3><button type="button" onClick={() => setEditing(null)}><X size={18} /></button></div>
            <div className="field"><label>Name</label><input value={editing.name} autoFocus onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} /></div>
            <div className="field"><label>Notes</label><textarea value={editing.notes || ''} onChange={(e) => setEditing((p) => ({ ...p, notes: e.target.value }))} /></div>
            <button type="button" className="btn btn-accent" onClick={saveEdit}>Save</button>
          </div>
        </div>
      )}
    </Layout>
  );
}
