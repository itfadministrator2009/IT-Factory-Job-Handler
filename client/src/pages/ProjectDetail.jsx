import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plus, X, UserPlus, Trash2 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';

  const [project, setProject] = useState(null);
  const [entries, setEntries] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [addUserId, setAddUserId] = useState('');
  const [error, setError] = useState('');
  const [creatingEntry, setCreatingEntry] = useState(false);

  function load() {
    api.get(`/projects/${id}`).then((res) => setProject(res.data.project)).catch(() => setError('Could not load project'));
    api.get(`/projects/${id}/entries`).then((res) => setEntries(res.data.entries));
  }
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (isAdmin) api.get('/users').then((res) => setAllUsers(res.data.users)); }, [isAdmin]);

  async function handleAssign(e) {
    e.preventDefault();
    if (!addUserId) return;
    await api.post(`/projects/${id}/assign`, { user_id: addUserId });
    setAddUserId('');
    load();
  }

  async function handleUnassign(userId) {
    await api.delete(`/projects/${id}/assign/${userId}`);
    load();
  }

  async function handleNewEntry() {
    setCreatingEntry(true);
    try {
      const { data } = await api.post(`/projects/${id}/entries`, {});
      navigate(`/projects/${id}/entries/${data.entry.id}`);
    } finally {
      setCreatingEntry(false);
    }
  }

  async function handleDeleteProject() {
    if (!confirm(`Delete "${project.name}"? This removes every entry and photo under it too — this can't be undone.`)) return;
    await api.delete(`/projects/${id}`);
    navigate('/projects');
  }

  if (error) return <Layout><div className="empty-state"><h3>{error}</h3></div></Layout>;
  if (!project) return <Layout><div className="empty-state">Loading…</div></Layout>;

  const unassignedUsers = allUsers.filter((u) => !project.assignedUsers.some((a) => a.id === u.id));

  return (
    <Layout>
      <Link to="/projects" className="back-link">&larr; Back to projects</Link>

      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          {project.description && <div className="subtitle">{project.description}</div>}
        </div>
        <button className="btn btn-accent" onClick={handleNewEntry} disabled={creatingEntry}>
          <Plus size={16} /> {creatingEntry ? 'Creating…' : 'New entry'}
        </button>
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 20 }}>
          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--coral)' }} onClick={handleDeleteProject}>
            <Trash2 size={13} /> Delete this project
          </button>
        </div>
      )}

      <div className="detail-grid">
        <div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="comment-meta"><strong style={{ color: 'var(--ink)' }}>Entries</strong></div>
            {!entries ? (
              <p style={{ color: 'var(--muted)' }}>Loading…</p>
            ) : entries.length === 0 ? (
              <div className="empty-state">
                <h3>No entries yet</h3>
                <p>Click "New entry" to log your first site visit under this project.</p>
              </div>
            ) : (
              <table className="ticket-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Site</th>
                    <th>Status</th>
                    <th>By</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/projects/${id}/entries/${e.id}`)}>
                      <td className="ticket-num">#{e.entry_number}</td>
                      <td>{e.site_name || <span style={{ color: 'var(--muted)' }}>Untitled</span>}</td>
                      <td>
                        <span className={'pill ' + (e.status === 'Submitted' ? 'pill-status-Complete' : 'pill-status-Open')}>{e.status}</span>
                      </td>
                      <td>{e.creator?.name}</td>
                      <td style={{ color: 'var(--muted)' }}>{formatDate(e.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {isAdmin && (
          <div>
            <div className="panel side-block">
              <h4><UserPlus size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Assigned people</h4>
              {project.assignedUsers.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>Nobody assigned yet.</p>}
              {project.assignedUsers.map((u) => (
                <div key={u.id} className="side-row">
                  <span>{u.name}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleUnassign(u.id)}><X size={12} /></button>
                </div>
              ))}
              {unassignedUsers.length > 0 && (
                <form onSubmit={handleAssign} style={{ marginTop: 12, display: 'flex', gap: 6 }}>
                  <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Add person…</option>
                    {unassignedUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={!addUserId}>Add</button>
                </form>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
