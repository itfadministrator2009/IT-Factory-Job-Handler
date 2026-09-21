import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Plus, Trash2, Mail, X, Pencil } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import TemplateBuilder from '../components/TemplateBuilder';

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
  const [showEditForm, setShowEditForm] = useState(false);
  const [editSections, setEditSections] = useState([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [newAssignedTo, setNewAssignedTo] = useState('');
  const [creatingEntry, setCreatingEntry] = useState(false);

  const [selected, setSelected] = useState(new Set());
  const [bulkAssignTo, setBulkAssignTo] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState([]);
  const [newRecipientInput, setNewRecipientInput] = useState('');
  const [emailModalError, setEmailModalError] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [bulkEmailResultMsg, setBulkEmailResultMsg] = useState('');

  const [entriesPage, setEntriesPage] = useState(1);
  const [totalEntryPages, setTotalEntryPages] = useState(1);

  function load(page = entriesPage) {
    api.get(`/projects/${id}`).then((res) => setProject(res.data.project)).catch(() => setError('Could not load project'));
    api.get(`/projects/${id}/entries`, { params: { page } }).then((res) => {
      setEntries(res.data.entries);
      setTotalEntryPages(res.data.totalPages);
      setEntriesPage(res.data.page);
    });
  }
  useEffect(() => { load(1); }, [id]);
  useEffect(() => { if (isAdmin) api.get('/users').then((res) => setAllUsers(res.data.users)); }, [isAdmin]);
  useEffect(() => { setSelected(new Set()); }, [entries?.length === 0]);

  function goToPage(page) {
    if (page < 1 || page > totalEntryPages) return;
    load(page);
  }

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

  function openEditForm() {
    // Deep-clone so cancelling doesn't leave any half-edited state behind if the
    // form is reopened later in the same visit.
    setEditSections(JSON.parse(JSON.stringify(project.template.sections)));
    setTemplateError('');
    setShowEditForm(true);
  }

  async function handleSaveTemplate(force) {
    setTemplateError('');
    if (editSections.length === 0) {
      setTemplateError('Add at least one section before saving.');
      return;
    }
    if (editSections.some((s) => s.fields.length === 0)) {
      setTemplateError('Every section needs at least one question — remove any empty sections or add a question to them.');
      return;
    }
    setSavingTemplate(true);
    try {
      const { data } = await api.patch(`/projects/${id}`, { template: { sections: editSections }, force });
      setProject(data.project);
      setShowEditForm(false);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.requiresConfirmation) {
        const list = err.response.data.warnings.join('\n');
        const confirmed = confirm(
          `Some entries already have answers to questions you're removing:\n\n${list}\n\nThose answers will stay in the database but won't be visible anywhere once you remove these questions. Continue anyway?`
        );
        if (confirmed) {
          await handleSaveTemplate(true);
          return;
        }
      } else {
        setTemplateError(err.response?.data?.error || 'Could not save changes');
      }
    } finally {
      setSavingTemplate(false);
    }
  }

  async function handleDeleteEntry(entryId, e) {
    e.stopPropagation();
    if (!confirm('Delete this entry?')) return;
    await api.delete(`/projects/${id}/entries/${entryId}`);
    load();
  }

  function toggleSelect(entryId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === entries.length) setSelected(new Set());
    else setSelected(new Set(entries.map((e) => e.id)));
  }

  async function handleBulkReassign() {
    if (!bulkAssignTo) return;
    setBulkApplying(true);
    try {
      await api.patch(`/projects/${id}/entries/bulk`, { ids: Array.from(selected), assigned_to: bulkAssignTo === 'unassigned' ? null : bulkAssignTo });
      setSelected(new Set());
      setBulkAssignTo('');
      load();
    } finally {
      setBulkApplying(false);
    }
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${selected.size} selected ${selected.size === 1 ? 'entry' : 'entries'}? This can't be undone.`)) return;
    setBulkApplying(true);
    try {
      await api.post(`/projects/${id}/entries/bulk-delete`, { ids: Array.from(selected) });
      setSelected(new Set());
      load();
    } finally {
      setBulkApplying(false);
    }
  }

  async function openBulkEmailModal() {
    setEmailModalError('');
    setBulkEmailResultMsg('');
    setNewRecipientInput('');
    setShowEmailModal(true);
    try {
      const { data } = await api.get(`/projects/${id}/email-defaults`);
      setEmailRecipients(data.recipients);
    } catch (err) {
      setEmailModalError('Could not load the default recipient list — you can still add addresses manually.');
      setEmailRecipients([]);
    }
  }

  function removeRecipient(email) {
    setEmailRecipients((prev) => prev.filter((r) => r !== email));
  }

  function addRecipient() {
    const email = newRecipientInput.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailModalError(`"${email}" doesn't look like a valid email address`);
      return;
    }
    if (emailRecipients.includes(email)) { setNewRecipientInput(''); return; }
    setEmailRecipients((prev) => [...prev, email]);
    setNewRecipientInput('');
    setEmailModalError('');
  }

  async function handleSendBulkEmail() {
    setEmailSending(true);
    setEmailModalError('');
    try {
      const { data } = await api.post(`/projects/${id}/entries/bulk-email-pdf`, { ids: Array.from(selected), recipients: emailRecipients });
      setShowEmailModal(false);
      setBulkEmailResultMsg(
        data.failedCount > 0
          ? `Sent ${data.sentCount} of ${data.results.length} — ${data.failedCount} failed.`
          : `Sent ${data.sentCount} ${data.sentCount === 1 ? 'entry' : 'entries'} to ${emailRecipients.length} ${emailRecipients.length === 1 ? 'address' : 'addresses'}.`
      );
    } catch (err) {
      setEmailModalError(err.response?.data?.error || 'Could not send emails');
    } finally {
      setEmailSending(false);
    }
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
        <div style={{ marginBottom: 20, display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={openEditForm}>
            <Pencil size={13} /> Edit form
          </button>
          <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={handleDeleteProject}>
            <Trash2 size={13} /> Delete this project
          </button>
        </div>
      )}

      {showEditForm && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 760 }}>
          <h3 style={{ fontSize: 15, marginBottom: 6 }}>Edit form</h3>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
            Changes apply to every new entry from now on. Entries already submitted keep whatever was on the form when they were filled out.
          </p>
          {templateError && <div className="error-banner">{templateError}</div>}
          <TemplateBuilder sections={editSections} onChange={setEditSections} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-accent" type="button" onClick={() => handleSaveTemplate(false)} disabled={savingTemplate}>
              {savingTemplate ? 'Saving…' : 'Save changes'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => setShowEditForm(false)} disabled={savingTemplate}>
              Cancel
            </button>
          </div>
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

      {bulkEmailResultMsg && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          <span>{bulkEmailResultMsg}</span>
          <button type="button" onClick={() => setBulkEmailResultMsg('')}><X size={15} /></button>
        </div>
      )}

      {isAdmin && selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <select value={bulkAssignTo} onChange={(e) => setBulkAssignTo(e.target.value)}>
            <option value="">Assign to…</option>
            <option value="unassigned">Unassigned</option>
            {allUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button type="button" onClick={handleBulkReassign} disabled={bulkApplying || !bulkAssignTo}>
            {bulkApplying ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" onClick={openBulkEmailModal} disabled={bulkApplying}>
            <Mail size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Email PDFs
          </button>
          <button type="button" onClick={handleBulkDelete} disabled={bulkApplying} style={{ color: 'var(--danger)' }}>
            <Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Delete
          </button>
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
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
                {isAdmin && (
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={selected.size === entries.length} onChange={toggleSelectAll} />
                  </th>
                )}
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
                  {isAdmin && (
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} />
                    </td>
                  )}
                  <td className="ticket-num">#{e.entry_number}</td>
                  <td>{e.site_name || <span style={{ color: 'var(--muted)' }}>Untitled</span>}</td>
                  <td>
                    <span className={'pill ' + (e.status === 'Submitted' ? 'pill-status-Complete' : 'pill-status-Open')}>{e.status}</span>
                  </td>
                  <td>{e.assignee?.name || <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</td>
                  <td style={{ color: 'var(--muted)' }}>{formatDate(e.updated_at)}</td>
                  {isAdmin && (
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={(ev) => handleDeleteEntry(e.id, ev)} title="Delete entry">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {entries && entries.length > 0 && totalEntryPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', padding: '14px 0 4px' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToPage(entriesPage - 1)} disabled={entriesPage <= 1}>
              Previous
            </button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Page {entriesPage} of {totalEntryPages}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => goToPage(entriesPage + 1)} disabled={entriesPage >= totalEntryPages}>
              Next
            </button>
          </div>
        )}
      </div>

      {showEmailModal && (
        <div className="modal-overlay" onClick={() => !emailSending && setShowEmailModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Email {selected.size} {selected.size === 1 ? 'PDF' : 'PDFs'}</h3>
              {!emailSending && <button type="button" onClick={() => setShowEmailModal(false)}><X size={18} /></button>}
            </div>
            {emailModalError && <div className="error-banner">{emailModalError}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              Each selected entry's completed PDF will be sent to everyone below.
            </p>
            <div className="attachment-list" style={{ marginBottom: 12 }}>
              {emailRecipients.map((email) => (
                <div key={email} className="attachment-row">
                  <span className="name">{email}</span>
                  <button type="button" className="danger" onClick={() => removeRecipient(email)} disabled={emailSending}>Remove</button>
                </div>
              ))}
              {emailRecipients.length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>No recipients yet — add at least one below.</p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                type="email"
                value={newRecipientInput}
                onChange={(e) => setNewRecipientInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }}
                placeholder="Add an email address"
                disabled={emailSending}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={addRecipient} disabled={emailSending}>Add</button>
            </div>
            <button
              className="btn btn-accent"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleSendBulkEmail}
              disabled={emailSending || emailRecipients.length === 0}
            >
              {emailSending ? 'Sending…' : `Send ${selected.size} ${selected.size === 1 ? 'PDF' : 'PDFs'} to ${emailRecipients.length} ${emailRecipients.length === 1 ? 'address' : 'addresses'}`}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
