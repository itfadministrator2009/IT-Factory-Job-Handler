import { useEffect, useState } from 'react';
import { Plus, Trash2, ShieldCheck, KeyRound, X, DatabaseBackup, Pencil, Eye, EyeOff, RotateCcw, AlertTriangle } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function Settings() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'agent';
  const [tab, setTab] = useState('users'); // 'users' | 'backup'

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

      <div className="settings-tabs" style={{ marginBottom: 20 }}>
        <span className={'settings-tab' + (tab === 'users' ? ' active' : '')} style={{ cursor: 'pointer' }} onClick={() => setTab('users')}>
          Manage Users
        </span>
        <span className={'settings-tab' + (tab === 'backup' ? ' active' : '')} style={{ cursor: 'pointer' }} onClick={() => setTab('backup')}>
          Backup
        </span>
      </div>

      {tab === 'users' ? <ManageUsersTab currentUser={currentUser} /> : <BackupTab />}
    </Layout>
  );
}

function ManageUsersTab({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetDoneFor, setResetDoneFor] = useState(null);
  const [showResetPassword, setShowResetPassword] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState('user');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  function load() {
    setLoading(true);
    api.get('/users/admin').then((res) => {
      setUsers(res.data.users);
      setLoading(false);
    }).catch(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

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

  function openReset(u) {
    setResetTarget(u);
    setResetPassword('');
    setResetError('');
    setResetDoneFor(null);
  }

  function openEdit(u) {
    setEditTarget(u);
    setEditName(u.name);
    setEditEmail(u.email);
    setEditRole(u.role === 'agent' ? 'admin' : u.role);
    setEditError('');
  }

  async function handleEditUser(e) {
    e.preventDefault();
    setEditSaving(true);
    setEditError('');
    try {
      await api.patch(`/users/admin/${editTarget.id}`, { name: editName, email: editEmail, role: editRole });
      setEditTarget(null);
      load();
    } catch (err) {
      setEditError(err.response?.data?.error || 'Could not update user');
    } finally {
      setEditSaving(false);
    }
  }

  function emailSharedWithSomeoneElse(email, excludingUserId) {
    const target = (email || '').trim().toLowerCase();
    if (!target) return false;
    return users.some((u) => u.id !== excludingUserId && u.email.trim().toLowerCase() === target);
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setResetSaving(true);
    setResetError('');
    try {
      await api.post(`/users/admin/${resetTarget.id}/reset-password`, { password: resetPassword });
      setResetDoneFor(resetTarget.name);
      setResetTarget(null);
    } catch (err) {
      setResetError(err.response?.data?.error || 'Could not reset password');
    } finally {
      setResetSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header" style={{ marginTop: 0 }}>
        <div>
          <h3 style={{ fontSize: 16 }}>Team members</h3>
          <div className="subtitle">Add people and control who has admin access.</div>
        </div>
        <button className="btn btn-accent" onClick={() => setShowForm((s) => !s)}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {resetDoneFor && (
        <div className="success-banner">
          <span>Password reset for {resetDoneFor}. Let them know their new password directly.</span>
          <button type="button" onClick={() => setResetDoneFor(null)}><X size={15} /></button>
        </div>
      )}

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
              {emailSharedWithSomeoneElse(email, null) && (
                <p style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>
                  Another user already has this email. Logging in still works fine (by password), but "Forgot password" can only reach one of the accounts — use "Reset password" here instead for the other one.
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor="upass">Password</label>
              <div className="password-field-wrap">
                <input
                  id="upass"
                  type={showPassword ? 'text' : 'password'}
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button type="button" className="password-toggle" onClick={() => setShowPassword((s) => !s)} tabIndex={-1}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
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
                  <td>{u.name}{u.id === currentUser.id && <span style={{ color: 'var(--muted)' }}> (you)</span>}</td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role === 'agent' ? 'admin' : u.role} onChange={(e) => handleRoleChange(u.id, e.target.value)}>
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(u)} title="Edit user"><Pencil size={13} /></button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openReset(u)} title="Reset password"><KeyRound size={13} /></button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => handleDelete(u)}
                        disabled={u.id === currentUser.id}
                        title={u.id === currentUser.id ? "You can't remove your own account" : 'Remove user'}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
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

      {editTarget && (
        <div className="modal-overlay" onClick={() => setEditTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit {editTarget.name}</h3>
              <button type="button" onClick={() => setEditTarget(null)}><X size={18} /></button>
            </div>
            {editError && <div className="error-banner">{editError}</div>}
            <form onSubmit={handleEditUser}>
              <div className="field">
                <label htmlFor="edit-name">Full name</label>
                <input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="edit-email">Email</label>
                <input id="edit-email" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
                {emailSharedWithSomeoneElse(editEmail, editTarget.id) && (
                  <p style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>
                    Another user already has this email. Logging in still works fine (by password), but "Forgot password" can only reach one of the accounts — use "Reset password" here instead for the other one.
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="edit-role">Role</label>
                <select id="edit-role" value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button className="btn btn-accent" type="submit" disabled={editSaving} style={{ width: '100%', justifyContent: 'center' }}>
                {editSaving ? 'Saving…' : 'Save changes'}
              </button>
            </form>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="modal-overlay" onClick={() => setResetTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Reset password for {resetTarget.name}</h3>
              <button type="button" onClick={() => setResetTarget(null)}><X size={18} /></button>
            </div>
            {resetError && <div className="error-banner">{resetError}</div>}
            <form onSubmit={handleResetPassword}>
              <div className="field">
                <label htmlFor="reset-pass">New password</label>
                <div className="password-field-wrap">
                  <input
                    id="reset-pass"
                    type={showResetPassword ? 'text' : 'password'}
                    minLength={8}
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    required
                    autoFocus
                  />
                  <button type="button" className="password-toggle" onClick={() => setShowResetPassword((s) => !s)} tabIndex={-1}>
                    {showResetPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
                This takes effect immediately. You'll need to tell {resetTarget.name.split(' ')[0]} their new password directly — it isn't emailed to them.
              </p>
              <button className="btn btn-accent" type="submit" disabled={resetSaving} style={{ width: '100%', justifyContent: 'center' }}>
                {resetSaving ? 'Resetting…' : 'Reset password'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function BackupTab() {
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');

  const [backups, setBackups] = useState(null);
  const [listError, setListError] = useState('');

  const [restoreTarget, setRestoreTarget] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreDone, setRestoreDone] = useState(false);

  function loadBackups() {
    setListError('');
    api.get('/backup/list').then((res) => setBackups(res.data.backups)).catch((err) => {
      setListError(err.response?.data?.error || 'Could not load backups');
      setBackups([]);
    });
  }
  useEffect(() => { loadBackups(); }, []);

  async function handleBackupNow() {
    setBackupRunning(true);
    setBackupMsg('');
    try {
      const { data } = await api.post('/backup/now');
      setBackupMsg(`Backup uploaded to OneDrive (${data.folder}/${data.filename})`);
      loadBackups();
    } catch (err) {
      setBackupMsg(err.response?.data?.error || 'Could not run backup');
    } finally {
      setBackupRunning(false);
    }
  }

  function openRestore(backup) {
    setRestoreTarget(backup);
    setConfirmText('');
    setRestoreError('');
  }

  async function handleRestore() {
    setRestoring(true);
    setRestoreError('');
    try {
      await api.post('/backup/restore', { backupId: restoreTarget.id });
      setRestoreDone(true);
      setRestoreTarget(null);
    } catch (err) {
      setRestoreError(err.response?.data?.error || 'Restore failed');
      setRestoring(false);
    }
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  function formatDate(s) {
    return new Date(s).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  if (restoreDone) {
    return (
      <div className="panel" style={{ padding: 24, maxWidth: 480 }}>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>Restoring…</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          The database has been swapped and the app is restarting now — this takes a few seconds.
          Refresh this page shortly; you may need to log in again.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="panel" style={{ padding: 24, marginBottom: 24, maxWidth: 520 }}>
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>
          <DatabaseBackup size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Back up now
        </h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          A backup of the database uploads to OneDrive automatically every night at 2am (Sydney time). You can also trigger one right now.
        </p>
        {backupMsg && (
          <div className={backupMsg.startsWith('Backup uploaded') ? 'success-banner' : 'error-banner'} style={{ marginBottom: 12 }}>
            {backupMsg}
          </div>
        )}
        <button className="btn btn-ghost btn-sm" onClick={handleBackupNow} disabled={backupRunning}>
          {backupRunning ? 'Sending…' : 'Back up now'}
        </button>
      </div>

      <div className="panel" style={{ padding: 24, maxWidth: 640 }}>
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>
          <RotateCcw size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Restore from backup
        </h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          This replaces everything currently in the app with an older backup. A safety copy of the current data is always taken automatically first, but this is still a big action — the app will restart afterward.
        </p>

        {listError && <div className="error-banner">{listError}</div>}

        {!backups ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading backups…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>No backups found yet.</p>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Date</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td style={{ color: 'var(--muted)' }}>{formatDate(b.lastModified)}</td>
                  <td style={{ color: 'var(--muted)' }}>{formatSize(b.size)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => openRestore(b)}>Restore</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {restoreTarget && (
        <div className="modal-overlay" onClick={() => !restoring && setRestoreTarget(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3><AlertTriangle size={16} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--coral)' }} />Restore this backup?</h3>
              {!restoring && <button type="button" onClick={() => setRestoreTarget(null)}><X size={18} /></button>}
            </div>
            {restoreError && <div className="error-banner">{restoreError}</div>}
            <p style={{ fontSize: 13, color: '#333', lineHeight: 1.6, marginBottom: 10 }}>
              This will replace <strong>everything</strong> currently in the app with <strong>{restoreTarget.name}</strong> (from {formatDate(restoreTarget.lastModified)}).
              Anything added or changed since that backup will be lost from the live app (it will still exist in today's automatic safety backup).
            </p>
            <p style={{ fontSize: 13, color: '#333', marginBottom: 14 }}>
              Type <strong>RESTORE</strong> below to confirm.
            </p>
            <div className="field">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" disabled={restoring} autoFocus />
            </div>
            <button
              className="btn btn-accent"
              style={{ width: '100%', justifyContent: 'center', background: 'var(--coral)' }}
              disabled={confirmText !== 'RESTORE' || restoring}
              onClick={handleRestore}
            >
              {restoring ? 'Restoring…' : 'Restore and restart the app'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
