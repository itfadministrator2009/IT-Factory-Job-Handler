import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
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
  const [error, setError] = useState('');

  const [showNewEntry, setShowNewEntry] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [newAssignedTo, setNewAssignedTo] = useState('');
  const [creatingEntry, setCreatingEntry] = useState(false);

  function load() {
    api.get(`/projects/${id}`).then((res) => setProject(res.data.project)).catch(() => setError('Could not load project'));
    api.get(`/projects/${id}/entries`).then((res) => setEntries(res.data.entries));
  }
  useEffect(() => { load(); }, [id]);
  useEffect(() => { if (isAdmin) api.get('/users').then((res) => setAllUsers(res.data.users)); }, [isAdmin]);

  async function handleCreateEntry(e) {
    e.preventDefault();
    setCreatingEntry(true);
    try {
      await api.post(`/projects/${id}/entries`, { site_name: newSiteName, assigned_to: newAssignedTo || null });
      setNewSiteName('');
      setNewAssignedTo('');
      setShowNewEntry(false);
      load();
    } finally {
      setCreatingEntry(false);
    }
  }

  async function handleDeleteProject() {
    if (!confirm(`Delete "${project.name}"? This removes every entry and photo under it too — this can't be undone.`)) return;
    await api.delete(`/projects/${id}`);
    navigate('/projects');
  }

  async function handleDeleteEntry(entryId, e) {
    e.stopPropagation();
    if (!confirm('Delete this entry?')) return;
    await api.delete(`/projects/${id}/entries/${entryId}`);
    load();
  }

  if (error) return <Layout><div className="empty-state"><h3>{error}</h3></div></Layout>;
  if (!project) return <Layout><div className="empty-state">Loading…</div></Layout>;

  return (
    <Layout>
      <Link to="/projects" className="back-link">&larr; Back to projects</Link>

      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          {project.description && <div className="subtitle">{project.description}</div>}
        </div>
        {isAdmin && (
          <button className="btn btn-accent" onClick={() => setShowNewEntry((s) => !s)}>
            <Plus size={16} /> {showNewEntry ? 'Cancel' : 'New entry'}
          </button>
        )}
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 20 }}>
          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--coral)' }} onClick={handleDeleteProject}>
            <Trash2 size={13} /> Delete this project
          </button>
        </div>
      )}

      {showNewEntry && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 420 }}>
          <form onSubmit={handleCreateEntry}>
            <div className="field">
              <label htmlFor="new-site-name">Site name</label>
              <input
                id="new-site-name"
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                placeholder="e.g. Harvey Norman Auburn"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="new-assigned-to">Assign to</label>
              <select id="new-assigned-to" value={newAssignedTo} onChange={(e) => setNewAssignedTo(e.target.value)}>
                <option value="">Unassigned</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <button className="btn btn-accent" type="submit" disabled={creatingEntry}>
              {creatingEntry ? 'Saving…' : 'Save'}
            </button>
          </form>
        </div>
      )}

      <div className="panel" style={{ padding: 18 }}>
        <div className="comment-meta"><strong style={{ color: 'var(--ink)' }}>Entries</strong></div>
        {!entries ? (
          <p style={{ color: 'var(--muted)' }}>Loading…</p>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <h3>No entries yet</h3>
            <p>{isAdmin ? 'Click "New entry" to log a site and assign it to someone.' : "You haven't been assigned any entries under this project yet."}</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Site</th>
                <th>Status</th>
                <th>Assigned to</th>
                <th>Updated</th>
                {isAdmin && <th></th>}
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
                  <td>{e.assignee?.name || <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</td>
                  <td style={{ color: 'var(--muted)' }}>{formatDate(e.updated_at)}</td>
                  {isAdmin && (
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={(ev) => handleDeleteEntry(e.id, ev)}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
