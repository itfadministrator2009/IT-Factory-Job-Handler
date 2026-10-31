import { useEffect, useState } from 'react';
import { Plus, Trash2, ShieldCheck, KeyRound, X, DatabaseBackup, Pencil, Eye, EyeOff, RotateCcw, AlertTriangle, LogOut } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import DiskUsage from '../components/DiskUsage';
import SearchField from '../components/SearchField';
import ActivityLog from '../components/ActivityLog';
import SecuritySettings from '../components/SecuritySettings';

// Manage Users groups. Stored role → label. 'user' is the original staff role, now ITF Contractors.
const ROLE_OPTIONS = [['admin', 'ITF Admin'], ['staff', 'ITF Staff'], ['user', 'ITF Contractor'], ['contractor', 'ITF Casual']];
const ROLE_LABEL = { admin: 'ITF Admins', staff: 'ITF Staff', user: 'ITF Contractors', contractor: 'ITF Casuals' };
// Staff and Contractors work the same way: sections are switched on for them.
const staffLike = (r) => r === 'user' || r === 'staff';

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export default function Settings() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'agent';
  // The open tab is in the address (?tab=activity) so it can be linked to and survives a refresh.
  const [params, setParams] = useSearchParams();
  // Activity log, Security & alerts and Backup are for the Super Admin only.
  const isSuper = currentUser?.superAdmin === true;
  const TABS = [['users', 'Manage Users'], ...(isSuper ? [['activity', 'Activity log'], ['security', 'Security & alerts'], ['backup', 'Backup']] : []), ['disk', 'Disk usage']];
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'users';
  const setTab = (k) => setParams(k === 'users' ? {} : { tab: k }, { replace: true });

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
        {TABS.map(([k, label]) => (
          <span key={k} className={'settings-tab' + (tab === k ? ' active' : '')} style={{ cursor: 'pointer' }} onClick={() => setTab(k)}>
            {label}
          </span>
        ))}
      </div>

      {tab === 'users' && <ManageUsersTab currentUser={currentUser} />}
      {tab === 'activity' && <ActivityLog />}
      {tab === 'security' && <SecuritySettings />}
      {tab === 'backup' && <BackupTab />}
      {tab === 'disk' && <DiskUsage />}
    </Layout>
  );
}

function ManageUsersTab({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  // Tick people, then move them into a group in one go.
  const [selected, setSelected] = useState(() => new Set());
  const [moveTo, setMoveTo] = useState('staff');
  const [moving, setMoving] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [newAccessAssets, setNewAccessAssets] = useState(true);
  const [newAccessStorage, setNewAccessStorage] = useState(true);
  const [newAccessSales, setNewAccessSales] = useState(false);
  const [newRate, setNewRate] = useState('');
  const [newAccessTimecard, setNewAccessTimecard] = useState(false);
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
  const [editRate, setEditRate] = useState('');
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
      const logsTime = role === 'contractor' || (staffLike(role) && newAccessTimecard);
      await api.post('/users/admin', { name, email, password, role, accessAssets: newAccessAssets, accessStorage: newAccessStorage, accessSales: newAccessSales, accessTimecard: staffLike(role) && newAccessTimecard, hourlyRate: logsTime ? newRate : undefined });
      setName(''); setEmail(''); setPassword(''); setRole('user'); setNewAccessAssets(true); setNewAccessStorage(true); setNewAccessSales(false); setNewAccessTimecard(false); setNewRate('');
      setShowForm(false);
      setNotice(`${name} has been added.`);
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

  async function moveSelected() {
    const ids = [...selected];
    const target = ROLE_OPTIONS.find(([v]) => v === moveTo)?.[1] || moveTo;
    setError(''); setNotice(''); setMoving(true);
    let moved = 0; const failed = [];
    for (const id of ids) {
      const u = users.find((x) => x.id === id);
      if (!u) continue;
      const current = (u.role === 'agent' ? 'admin' : u.role);
      if (current === moveTo) continue;
      try { await api.patch(`/users/admin/${id}`, { role: moveTo }); moved += 1; } catch (err) { failed.push(`${u.name}: ${err.response?.data?.error || 'could not move'}`); }
    }
    setMoving(false);
    setSelected(new Set());
    await load();
    if (moved) setNotice(`Moved ${moved} ${moved === 1 ? 'person' : 'people'} to ${target}.`);
    if (failed.length) setError(failed.join(' '));
    else if (!moved) setNotice(`Everyone ticked is already in ${target}.`);
  }

  // Switch a user's access to the ITF Asset Tracker / ITF Storage Centre on or off.
  async function handleAccessChange(u, field, value) {
    setError('');
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, [field]: value } : x)));
    try {
      await api.patch(`/users/admin/${u.id}`, { [field]: value });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update access');
      load();
    }
  }

  // Log someone out of Work Desk on every device (they can log straight back in).
  async function handleLogOut(u) {
    if (!confirm(`Log ${u.name} out of Work Desk? They'll be sent to the login page on every device they're signed in on.`)) return;
    setError(''); setNotice('');
    try {
      await api.post(`/presence/${u.id}/logout`);
      setNotice(`${u.name} has been logged out.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not log them out');
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
    setEditRate(u.hourlyRate ?? '');
    setEditError('');
  }

  async function handleEditUser(e) {
    e.preventDefault();
    setEditSaving(true);
    setEditError('');
    try {
      await api.patch(`/users/admin/${editTarget.id}`, { name: editName, email: editEmail, role: editRole, hourlyRate: editRole === 'contractor' || (staffLike(editRole) && editTarget.accessTimecard) ? editRate : undefined });
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

  const isAdminRole = (r) => r === 'admin' || r === 'agent';
  const iAmSuper = !!(users.find((x) => x.id === currentUser.id)?.superAdmin ?? currentUser.superAdmin);
  const roleKey = (u) => (isAdminRole(u.role) ? 'admin' : u.role === 'contractor' ? 'contractor' : u.role === 'staff' ? 'staff' : 'user');
  const counts = users.reduce((c, u) => ({ ...c, [roleKey(u)]: (c[roleKey(u)] || 0) + 1 }), {});
  const q = query.trim().toLowerCase();
  const shown = users
    .filter((u) => roleFilter === 'all' || roleKey(u) === roleFilter)
    .filter((u) => !q || `${u.name} ${u.email} ${ROLE_LABEL[roleKey(u)]}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const FILTERS = [['all', 'All', users.length], ['admin', 'ITF Admins', counts.admin || 0], ['staff', 'ITF Staff', counts.staff || 0], ['user', 'ITF Contractors', counts.user || 0], ['contractor', 'ITF Casuals', counts.contractor || 0]];

  // Super Admin: switch one app on or off for an admin.
  async function handleAdminApp(u, app, on) {
    setError('');
    const blocked = new Set(u.blockedApps || []);
    if (on) blocked.delete(app); else blocked.add(app);
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, blockedApps: [...blocked] } : x)));
    try {
      await api.patch(`/users/admin/${u.id}`, { adminApps: { [app]: on } });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not update access');
      load();
    }
  }

  // One access cell: a switch, or a fixed state for admins (and Casuals' Time Card).
  // The Super Admin gets switches for other admins too.
  function accessCell(u, field, label) {
    const admin = isAdminRole(u.role);
    const contractor = u.role === 'contractor';
    if (admin && iAmSuper && !u.superAdmin) {
      const app = { accessAssets: 'assets', accessStorage: 'storage', accessSales: 'sales', accessTimecard: 'timecard' }[field];
      const on = !(u.blockedApps || []).includes(app);
      const what = field === 'accessTimecard' ? `${label} approvals` : label;
      return (
        <button type="button" role="switch" aria-checked={on} className={'mu-switch' + (on ? ' on' : '')}
          aria-label={`${what} for ${u.name}`} title={on ? `Turn off ${what} for this admin` : `Turn on ${what} for this admin`}
          onClick={() => handleAdminApp(u, app, !on)}>
          <span className="mu-knob" />
        </button>
      );
    }
    const appOf = { accessAssets: 'assets', accessStorage: 'storage', accessSales: 'sales', accessTimecard: 'timecard' }[field];
    if (admin && (u.blockedApps || []).includes(appOf)) return <span className="mu-fixed" title="Switched off by the Super Admin">Off</span>;
    if (field === 'accessTimecard') {
      if (admin) return <span className="mu-fixed" title="Admins approve timesheets">Approves</span>;
      if (contractor) return <span className="mu-fixed on" title="Casuals always log their hours">Always</span>;
    } else {
      if (admin) return <span className="mu-fixed on" title="Admins always have access">Full</span>;
    }
    // Casuals: off unless switched on here. Sales Manager: off for everyone unless switched on.
    const on = field === 'accessTimecard' || field === 'accessSales' ? !!u[field] : contractor ? u[field] === true : u[field] !== false;
    return (
      <button type="button" role="switch" aria-checked={on} className={'mu-switch' + (on ? ' on' : '')}
        aria-label={`${label} access for ${u.name}`} title={on ? `Turn off ${label}` : `Turn on ${label}`}
        onClick={() => handleAccessChange(u, field, !on)}>
        <span className="mu-knob" />
      </button>
    );
  }

  return (
    <div className="mu">
      <div className="mu-head">
        <div>
          <h3>Team members</h3>
          <p>Add people, put them in their group, and choose which sections each person can use. Tick people to move several into a group at once. Changes apply straight away.</p>
        </div>
        <button className="btn btn-accent" onClick={() => setShowForm(true)}><Plus size={16} /> Add user</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner" style={{ marginBottom: 12 }}><span>{notice}</span><button type="button" onClick={() => setNotice('')}><X size={15} /></button></div>}
      {resetDoneFor && (
        <div className="success-banner">
          <span>Password reset for {resetDoneFor}. Let them know their new password directly.</span>
          <button type="button" onClick={() => setResetDoneFor(null)}><X size={15} /></button>
        </div>
      )}

      <div className="mu-toolbar">
        <div className="mu-filters" role="tablist" aria-label="Filter by role">
          {FILTERS.map(([key, label, n]) => (
            <button key={key} type="button" role="tab" aria-selected={roleFilter === key}
              className={'mu-filter' + (roleFilter === key ? ' active' : '')} onClick={() => setRoleFilter(key)}>
              {label}<span className="mu-count">{n}</span>
            </button>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search by name or email" label="Search users" style={{ maxWidth: 320, flex: '1 1 240px' }} />
      </div>

      {selected.size > 0 && (
        <div className="mu-movebar">
          <strong>{selected.size} selected</strong>
          <label htmlFor="mu-move">Move to</label>
          <select id="mu-move" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {ROLE_OPTIONS.map(([v]) => <option key={v} value={v}>{ROLE_LABEL[v]}</option>)}
          </select>
          <button type="button" className="btn btn-accent btn-sm" onClick={moveSelected} disabled={moving}>{moving ? 'Moving…' : 'Move'}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())} disabled={moving}>Clear</button>
        </div>
      )}

      <div className="panel mu-panel">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <table className="mu-table">
            <thead>
              <tr>
                <th className="mu-pick"><input type="checkbox" aria-label="Select everyone shown"
                  checked={shown.length > 0 && shown.every((u) => selected.has(u.id))}
                  onChange={(e) => setSelected((s) => { const n = new Set(s); shown.forEach((u) => (e.target.checked ? n.add(u.id) : n.delete(u.id))); return n; })} /></th>
                <th>Name</th>
                <th>Group</th>
                <th className="c">Asset Tracker</th>
                <th className="c">Storage Centre</th>
                <th className="c">Sales Manager</th>
                <th className="c">Time Card</th>
                <th className="r"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const me = u.id === currentUser.id;
                const rk = roleKey(u);
                // Only the Super Admin can remove admins, take admin access away, or change the Super Admin's account.
                const lockedAdmin = !iAmSuper && rk === 'admin';
                const lockedSuper = !iAmSuper && u.superAdmin && !me;
                return (
                  <tr key={u.id} className={selected.has(u.id) ? 'mu-picked' : ''}>
                    <td className="mu-pick"><input type="checkbox" aria-label={`Select ${u.name}`} checked={selected.has(u.id)}
                      onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(u.id); else n.delete(u.id); return n; })} /></td>
                    <td>
                      <div className="mu-person">
                        <span className={`mu-avatar ${rk}`} aria-hidden="true">{initials(u.name)}</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="mu-name">{u.name}{u.superAdmin && <span className="mu-super" title="Super Admin: the only account that can remove admins">Super Admin</span>}{me && <span className="mu-you">You</span>}</div>
                          <div className="mu-email">{u.email}{u.hourlyRate && (rk === 'contractor' || u.accessTimecard) ? <span className="mu-rate"> · ${Number(u.hourlyRate).toFixed(2)}/hr</span> : null}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select className={`mu-role ${rk}`} value={rk} onChange={(e) => handleRoleChange(u.id, e.target.value)} aria-label={`Group for ${u.name}`}
                        disabled={lockedAdmin} title={lockedAdmin ? 'Only the Super Admin can move an admin to another group' : undefined}>
                        {ROLE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </td>
                    <td className="c">{accessCell(u, 'accessAssets', 'ITF Asset Tracker')}</td>
                    <td className="c">{accessCell(u, 'accessStorage', 'ITF Storage Centre')}</td>
                    <td className="c">{accessCell(u, 'accessSales', 'ITF Sales Manager')}</td>
                    <td className="c">{accessCell(u, 'accessTimecard', 'ITF Time Card')}</td>
                    <td className="r">
                      <div className="mu-actions">
                        <button type="button" className="mu-act" onClick={() => openEdit(u)} disabled={lockedSuper} title={lockedSuper ? 'Only the Super Admin can change this account' : 'Edit details'} aria-label={`Edit ${u.name}`}><Pencil size={15} /></button>
                        <button type="button" className="mu-act" onClick={() => openReset(u)} disabled={lockedSuper} title={lockedSuper ? 'Only the Super Admin can change this account' : 'Reset password'} aria-label={`Reset password for ${u.name}`}><KeyRound size={15} /></button>
                        <button type="button" className="mu-act" onClick={() => handleLogOut(u)} disabled={me}
                          title={me ? 'Use Log out to sign yourself out' : 'Log out of Work Desk'} aria-label={`Log ${u.name} out`}><LogOut size={15} /></button>
                        <button type="button" className="mu-act danger" onClick={() => handleDelete(u)} disabled={me || lockedAdmin}
                          title={me ? "You can't remove your own account" : lockedAdmin ? 'Only the Super Admin can remove an admin' : 'Remove user'} aria-label={`Remove ${u.name}`}><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={8} className="mu-empty">No one matches{query ? ` “${query}”` : ''}{roleFilter !== 'all' ? ` in ${FILTERS.find((f) => f[0] === roleFilter)[1]}` : ''}.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <p className="mu-foot">
        <ShieldCheck size={13} /> <span><strong>ITF Admins</strong> have full access and approve timesheets. <strong>ITF Staff</strong> and <strong>ITF Contractors</strong> get the sections switched on for them — turn on Time Card to let them log their own hours. <strong>ITF Casuals</strong> always log hours in ITF Time Card, and can be given the Asset Tracker and Storage Centre too. <strong>ITF Sales Manager</strong> is off for everyone except admins until it is switched on here. Only the <strong>Super Admin</strong> can remove admins, take admin access away, or switch apps off for an admin.</span>
      </p>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add user</h3>
              <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>
            </div>
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
              <label htmlFor="urole">Group</label>
              <select id="urole" value={role} onChange={(e) => {
                const next = e.target.value;
                // Casuals start with only ITF Time Card; tick extra sections below.
                if ((next === 'contractor') !== (role === 'contractor')) { setNewAccessAssets(next !== 'contractor'); setNewAccessStorage(next !== 'contractor'); }
                setRole(next);
              }}>
                {ROLE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
            {(role === 'contractor' || (staffLike(role) && newAccessTimecard)) && (
              <div className="field">
                <label htmlFor="urate">Hourly rate (optional)</label>
                <input id="urate" type="number" min="0" step="0.01" inputMode="decimal" placeholder="e.g. 75" value={newRate} onChange={(e) => setNewRate(e.target.value)} />
                <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Used for estimated pay on approved timesheets.</p>
              </div>
            )}
            {(staffLike(role) || role === 'contractor') && (
              <div className="field">
                <label>Access</label>
                <label className="mu-check">
                  <input type="checkbox" checked={newAccessAssets} onChange={(e) => setNewAccessAssets(e.target.checked)} /> ITF Asset Tracker
                </label>
                <label className="mu-check">
                  <input type="checkbox" checked={newAccessStorage} onChange={(e) => setNewAccessStorage(e.target.checked)} /> ITF Storage Centre
                </label>
                <label className="mu-check">
                  <input type="checkbox" checked={newAccessSales} onChange={(e) => setNewAccessSales(e.target.checked)} /> ITF Sales Manager
                </label>
                {role === 'contractor' ? (
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Casuals always have ITF Time Card.</p>
                ) : (
                <label className="mu-check">
                  <input type="checkbox" checked={newAccessTimecard} onChange={(e) => setNewAccessTimecard(e.target.checked)} /> ITF Time Card <span style={{ color: 'var(--muted)' }}>(logs their own hours)</span>
                </label>
                )}
              </div>
            )}
            <button className="btn btn-accent" type="submit" disabled={saving} style={{ width: '100%', justifyContent: 'center' }}>
              {saving ? 'Adding…' : 'Add user'}
            </button>
          </form>
          </div>
        </div>
      )}

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
                <label htmlFor="edit-role">Group</label>
                <select id="edit-role" value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                  {ROLE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
              {(editRole === 'contractor' || (staffLike(editRole) && editTarget.accessTimecard)) && (
                <div className="field">
                  <label htmlFor="edit-rate">Hourly rate (optional)</label>
                  <input id="edit-rate" type="number" min="0" step="0.01" inputMode="decimal" placeholder="e.g. 75" value={editRate} onChange={(e) => setEditRate(e.target.value)} />
                </div>
              )}
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

  // "Back up now" starts the backup on the server and then checks on it every few
  // seconds, so a long backup (lots of photos) doesn't get cut off mid-request.
  const STEP_LABEL = { database: 'database', photos: 'photos and attachments', 'storage centre': 'Storage Centre data', 'time card': 'ITF Time Card data' };
  function describe(status) {
    const last = status.last;
    if (!last) return 'The backup did not report back. Try again, and if it keeps happening check the Render logs for lines starting with [backup].';
    if (last.state === 'interrupted') {
      return `The backup stopped part-way while backing up the ${STEP_LABEL[last.step] || last.step} — the server restarted (a redeploy, or it ran out of memory). Try again in a minute; if it stops at the same step again, check the Render logs for lines starting with [backup].`;
    }
    if (last.state === 'failed') return status.message || 'Backup failed';
    const r = last.result || {};
    const parts = [r.filename, r.uploadsFilename, r.storageFilename, r.timecardFilename].filter(Boolean).join(' + ');
    const warn = r.warnings?.length ? ` Note: ${r.warnings.join(' ')}` : '';
    return `Backup uploaded to OneDrive (${r.folder}: ${parts}).${warn}`;
  }

  async function handleBackupNow() {
    setBackupRunning(true);
    setBackupMsg('');
    const startedAt = Date.now();
    try {
      await api.post('/backup/now');
    } catch (err) {
      setBackupMsg(err.response?.data?.error || 'Could not reach the server to start the backup. If the app was just updated, wait a minute and try again.');
      setBackupRunning(false);
      return;
    }
    let misses = 0;
    for (let i = 0; i < 400; i += 1) { // up to ~20 minutes
      await new Promise((r) => setTimeout(r, 3000));
      let status;
      try {
        status = (await api.get('/backup/status')).data;
        misses = 0;
      } catch (err) {
        // The server may be restarting; keep checking for a little while.
        misses += 1;
        if (misses >= 20) { setBackupMsg('Lost contact with the server during the backup. Refresh in a minute and check the list below for today\'s backup.'); break; }
        continue;
      }
      if (status.running) continue;
      const fresh = status.last && new Date(status.last.startedAt).getTime() >= startedAt - 60000;
      setBackupMsg(fresh ? describe(status) : describe({ last: null }));
      break;
    }
    loadBackups();
    setBackupRunning(false);
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
          Everything in Work Desk — jobs, projects, ITF Asset Tracker, ITF Storage Centre and ITF Time Card — is backed up to OneDrive automatically every night at 2am (Sydney time), along with photos and attachments. Storage Centre and Time Card are also saved as spreadsheets (CSV files) you can open in Excel. You can also trigger a backup right now. Old backups are tidied automatically: photos are kept for every night of the last 30 days, the database and spreadsheets for every night of the last year, and after that one backup a month is kept for good.
        </p>
        {backupMsg && (
          <div className={backupMsg.startsWith('Backup uploaded') ? 'success-banner' : 'error-banner'} style={{ marginBottom: 12 }}>
            {backupMsg}
          </div>
        )}
        <button className="btn btn-ghost btn-sm" onClick={handleBackupNow} disabled={backupRunning}>
          {backupRunning ? 'Backing up… (can take a few minutes)' : 'Back up now'}
        </button>
      </div>

      <div className="panel" style={{ padding: 24, maxWidth: 640 }}>
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>
          <RotateCcw size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Restore from backup
        </h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          This replaces everything currently in the app with an older backup. A safety copy of the current data is always taken automatically first, but this is still a big action — the app will restart afterward.
        </p>
        <div style={{ fontSize: 13, background: 'var(--accent-soft, #fdf0e8)', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
          Only need one job, asset or Storage Centre item back? Use <Link to="/restore-records">Restore individual records</Link> — it brings back just the records you tick and leaves everything else as it is.
        </div>

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
              <h3><AlertTriangle size={16} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--danger)' }} />Restore this backup?</h3>
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
              style={{ width: '100%', justifyContent: 'center', background: 'var(--danger)' }}
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
