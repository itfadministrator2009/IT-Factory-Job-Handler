import { useEffect, useState } from 'react';
import { Plus, Trash2, ShieldCheck } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'agent';

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api.get('/users/admin').then((res) => {
      setUsers(res.data.users);
      setLoading(false);
    }).catch(() => setLoading(false));
  }

  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  async function handleAddUser(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/users/admin', { name, email, password, role });
      setName(''); setEmail(''); setPassword(''); setRole('user');
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add user');
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleChange(userId, newRole) {
    setError('');
    try {
      await api.patch(`/users/admin/${userId}`, { role: newRole });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update role');
    }
  }

  async function handleDelete(u) {
    if (!confirm(`Remove ${u.name}? They'll lose access immediately.`)) return;
    setError('');
    try {
      await api.delete(`/users/admin/${u.id}`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove user');
    }
  }

  if (!isAdmin) {
    return (
      <Layout>
        <div className="page-header"><div><h1>Settings</h1></div></div>
        <div className="empty-state">
          <h3>Admins only</h3>
          <p>You need admin access to view this page.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <div className="subtitle">Manage your Work Desk configuration.</div>
        </div>
      </div>

      <div className="settings-tabs">
        <span className="settings-tab active">Users</span>
      </div>

      <div className="page-header" style={{ marginTop: 20 }}>
        <div>
          <h3 style={{ fontSize: 16 }}>Team members</h3>
          <div className="subtitle">Add people and control who has admin access.</div>
        </div>
        <button className="btn btn-accent" onClick={() => setShowForm((s) => !s)}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showForm && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 480 }}>
          <form onSubmit={handleAddUser}>
            <div className="field">
              <label htmlFor="uname">Full name</label>
              <input id="uname" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="uemail">Email</label>
              <input id="uemail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="upass">Password</label>
              <input id="upass" type="password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="urole">Role</label>
              <select id="urole" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button className="btn btn-accent" type="submit" disabled={saving}>
              {saving ? 'Adding…' : 'Add user'}
            </button>
          </form>
        </div>
      )}

      <div className="panel" style={{ padding: users.length ? 0 : 20 }}>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    {u.id === currentUser.id && <span style={{ color: 'var(--muted)' }}> (you)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select
                      value={u.role === 'agent' ? 'admin' : u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDelete(u)}
                      disabled={u.id === currentUser.id}
                      title={u.id === currentUser.id ? "You can't remove your own account" : 'Remove user'}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldCheck size={13} /> Admins can manage users and roles here. Everyone — Admin or User — has the same access to jobs, reports, templates, and the knowledge base.
      </p>
    </Layout>
  );
}
