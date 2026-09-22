import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Download, Upload, Printer, X, Mail, Trash2, Pencil, BarChart3, Sliders } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

// Columns shown in the main table — a curated subset of the (potentially many)
// fields, since showing all 24+ as columns would be unusable. Clicking a row opens
// every field for that asset.
const SUMMARY_KEYS = ['asset_tag', 'category', 'manufacturer', 'model_name', 'model_number', 'serial_number', 'customer', 'status', 'zoho_ticket_number'];

export default function AssetTracker() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';

  const [fieldDefs, setFieldDefs] = useState(null);
  const [assets, setAssets] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set());

  const [showForm, setShowForm] = useState(false);
  const [editingAsset, setEditingAsset] = useState(null); // null = adding new
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState([]);
  const [newRecipientInput, setNewRecipientInput] = useState('');
  const [emailModalError, setEmailModalError] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailResultMsg, setEmailResultMsg] = useState('');

  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkFieldKey, setBulkFieldKey] = useState('');
  const [bulkFieldValue, setBulkFieldValue] = useState('');
  const importInputRef = useRef(null);
  const [importMsg, setImportMsg] = useState('');

  function loadFieldDefs() {
    api.get('/assets/field-defs').then((res) => setFieldDefs(res.data.fields));
  }
  function loadAssets(p = page, q = query) {
    api.get('/assets', { params: { page: p, q } }).then((res) => {
      setAssets(res.data.assets);
      setTotal(res.data.total);
      setTotalPages(res.data.totalPages);
      setPage(res.data.page);
    });
  }
  useEffect(() => { loadFieldDefs(); loadAssets(1, ''); }, []);

  function handleSearch(e) {
    e.preventDefault();
    setSelected(new Set());
    loadAssets(1, query);
  }

  function openAddForm() {
    setEditingAsset(null);
    setFormValues({});
    setError('');
    setShowForm(true);
  }
  function openEditForm(asset) {
    setEditingAsset(asset);
    setFormValues({ ...asset.fields });
    setError('');
    setShowForm(true);
  }

  function updateFormField(key, value) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSaveAsset(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingAsset) {
        await api.patch(`/assets/${editingAsset.id}`, { fields: formValues });
      } else {
        await api.post('/assets', { fields: formValues });
      }
      setShowForm(false);
      loadAssets();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAsset(id, e) {
    e.stopPropagation();
    if (!confirm('Delete this asset?')) return;
    await api.delete(`/assets/${id}`);
    loadAssets();
  }

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (selected.size === assets.length) setSelected(new Set());
    else setSelected(new Set(assets.map((a) => a.id)));
  }

  async function handleSelectAllMatching() {
    const { data } = await api.get('/assets/all-ids', { params: { q: query } });
    setSelected(new Set(data.ids));
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${selected.size} selected ${selected.size === 1 ? 'asset' : 'assets'}?`)) return;
    setBulkApplying(true);
    try {
      await api.post('/assets/bulk-delete', { ids: Array.from(selected) });
      setSelected(new Set());
      loadAssets();
    } finally {
      setBulkApplying(false);
    }
  }

  async function handleBulkEdit() {
    if (!bulkFieldKey) return;
    setBulkApplying(true);
    try {
      await api.patch('/assets/bulk-edit', { ids: Array.from(selected), updates: { [bulkFieldKey]: bulkFieldValue } });
      setSelected(new Set());
      setBulkFieldKey('');
      setBulkFieldValue('');
      loadAssets();
    } finally {
      setBulkApplying(false);
    }
  }

  function openEmailModal() {
    setEmailModalError('');
    setEmailResultMsg('');
    setNewRecipientInput('');
    setEmailRecipients([]);
    setShowEmailModal(true);
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
    if (!emailRecipients.includes(email)) setEmailRecipients((prev) => [...prev, email]);
    setNewRecipientInput('');
    setEmailModalError('');
  }
  async function handleSendEmail() {
    setEmailSending(true);
    setEmailModalError('');
    try {
      const { data } = await api.post('/assets/bulk-email', { ids: Array.from(selected), recipients: emailRecipients });
      setShowEmailModal(false);
      setEmailResultMsg(`Sent a report of ${data.count} ${data.count === 1 ? 'asset' : 'assets'} to ${emailRecipients.join(', ')}`);
    } catch (err) {
      setEmailModalError(err.response?.data?.error || 'Could not send email');
    } finally {
      setEmailSending(false);
    }
  }

  async function handleExport() {
    // A plain window.open() wouldn't carry the Authorization header this endpoint
    // requires — fetching via the API client and triggering a named download
    // client-side (same approach used for PDF downloads elsewhere in this app)
    // avoids that entirely.
    const res = await api.get('/assets/export', { params: { q: query }, responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `asset-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportMsg('Importing…');
    const form = new FormData();
    form.append('file', file);
    try {
      const { data } = await api.post('/assets/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportMsg(`Imported ${data.created} asset${data.created === 1 ? '' : 's'}.${data.skippedColumns.length ? ` Columns not recognised: ${data.skippedColumns.join(', ')}` : ''}`);
      loadAssets();
    } catch (err) {
      setImportMsg(err.response?.data?.error || 'Import failed');
    } finally {
      e.target.value = '';
    }
  }

  function renderFieldInput(field, value, onChange) {
    if (field.type === 'dropdown') {
      return (
        <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">-Select-</option>
          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (field.type === 'multiselect') {
      const selectedVals = Array.isArray(value) ? value : [];
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px 12px', border: '1px solid var(--line)', borderRadius: 8, padding: 10, maxHeight: 220, overflowY: 'auto' }}>
          {field.options?.map((o) => (
            <label key={o} className="checkbox-label" style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={selectedVals.includes(o)}
                onChange={(e) => {
                  onChange(e.target.checked ? [...selectedVals, o] : selectedVals.filter((v) => v !== o));
                }}
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    if (field.type === 'textarea') {
      return <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} />;
    }
    if (field.type === 'date') {
      return <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
    }
    if (field.type === 'number') {
      return <input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    }
    return <input type="text" value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  }

  function displayValue(v) {
    if (Array.isArray(v)) return v.join(', ');
    return v || '';
  }

  const bulkFieldDef = fieldDefs?.find((f) => f.field_key === bulkFieldKey);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>ITF Asset Tracker</h1>
          <div className="subtitle">{total} asset{total === 1 ? '' : 's'} on file</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-accent" onClick={openAddForm}><Plus size={16} /> Add asset</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 240 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search any field — tag, serial, customer, model…"
            style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '9px 12px' }}
          />
          <button type="submit" className="btn btn-ghost btn-sm"><Search size={14} /> Search</button>
        </form>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleExport}><Download size={14} /> Export</button>
        {isAdmin && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => importInputRef.current?.click()}><Upload size={14} /> Import</button>
            <input ref={importInputRef} type="file" accept=".csv" onChange={handleImportFile} style={{ display: 'none' }} />
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
        <Link to="/assets/reports" className="btn btn-ghost btn-sm"><BarChart3 size={14} /> Reports</Link>
        {isAdmin && <Link to="/assets/fields" className="btn btn-ghost btn-sm"><Sliders size={14} /> Manage fields</Link>}
      </div>

      {importMsg && (
        <div className={importMsg.startsWith('Imported') ? 'success-banner' : 'error-banner'} style={{ marginBottom: 16 }}>
          <span>{importMsg}</span>
          <button type="button" onClick={() => setImportMsg('')}><X size={15} /></button>
        </div>
      )}
      {emailResultMsg && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          <span>{emailResultMsg}</span>
          <button type="button" onClick={() => setEmailResultMsg('')}><X size={15} /></button>
        </div>
      )}

      {isAdmin && selected.size > 0 && selected.size === assets?.length && total > assets.length && (
        <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--muted)' }}>
          All {assets.length} on this page are selected.{' '}
          <button type="button" onClick={handleSelectAllMatching} style={{ background: 'none', border: 'none', color: 'var(--teal)', fontWeight: 600, textDecoration: 'underline', cursor: 'pointer', padding: 0 }}>
            Select all {total} matching assets
          </button>
        </div>
      )}

      {isAdmin && selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <select value={bulkFieldKey} onChange={(e) => { setBulkFieldKey(e.target.value); setBulkFieldValue(''); }}>
            <option value="">Set field…</option>
            {fieldDefs?.filter((f) => f.field_key !== 'asset_tag').map((f) => <option key={f.field_key} value={f.field_key}>{f.label}</option>)}
          </select>
          {bulkFieldDef && bulkFieldDef.type === 'dropdown' && (
            <select value={bulkFieldValue} onChange={(e) => setBulkFieldValue(e.target.value)}>
              <option value="">-Select-</option>
              {bulkFieldDef.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {bulkFieldDef && !['dropdown', 'multiselect'].includes(bulkFieldDef.type) && (
            <input value={bulkFieldValue} onChange={(e) => setBulkFieldValue(e.target.value)} placeholder="value" style={{ width: 140 }} />
          )}
          <button type="button" onClick={handleBulkEdit} disabled={bulkApplying || !bulkFieldKey}>Apply</button>
          <button type="button" onClick={openEmailModal} disabled={bulkApplying}><Mail size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Email</button>
          <button type="button" onClick={handleBulkDelete} disabled={bulkApplying} style={{ color: 'var(--danger)' }}><Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Delete</button>
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="panel" style={{ padding: 0 }}>
        {!assets ? (
          <div className="empty-state">Loading…</div>
        ) : assets.length === 0 ? (
          <div className="empty-state">
            <h3>No assets yet</h3>
            <p>Click "Add asset" to log your first entry.</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                {isAdmin && <th style={{ width: 32 }}><input type="checkbox" checked={selected.size === assets.length} onChange={toggleSelectAll} /></th>}
                {SUMMARY_KEYS.map((key) => {
                  const def = fieldDefs?.find((f) => f.field_key === key);
                  return <th key={key}>{def?.label || key}</th>;
                })}
                <th>Date</th>
                <th>By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => openEditForm(a)}>
                  {isAdmin && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} />
                    </td>
                  )}
                  {SUMMARY_KEYS.map((key) => <td key={key}>{displayValue(a.fields[key])}</td>)}
                  <td style={{ color: 'var(--muted)' }}>{formatDate(a.created_at)}</td>
                  <td style={{ color: 'var(--muted)' }}>{a.fields._imported_creator_name || a.creator?.name || '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button type="button" className="btn btn-ghost btn-sm icon-btn" onClick={() => openEditForm(a)} title="Edit"><Pencil size={13} /></button>
                      {isAdmin && (
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={(e) => handleDeleteAsset(a.id, e)} title="Delete">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {assets && assets.length > 0 && totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', padding: '14px 0' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadAssets(page - 1)} disabled={page <= 1}>Previous</button>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Page {page} of {totalPages}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadAssets(page + 1)} disabled={page >= totalPages}>Next</button>
          </div>
        )}
      </div>

      {showForm && fieldDefs && (
        <div className="modal-overlay" onClick={() => !saving && setShowForm(false)}>
          <div className="modal-card sign-off-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1100, width: '95vw', height: '92vh' }}>
            <div className="modal-header">
              <h3>{editingAsset ? 'Edit asset' : 'Add asset'}</h3>
              {!saving && <button type="button" onClick={() => setShowForm(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSaveAsset} className="sign-off-scroll">
              <div className="form-grid">
                {fieldDefs.map((f) => (
                  <div className={'field' + ((f.type === 'multiselect' || f.type === 'textarea') ? ' span-2' : '')} key={f.field_key}>
                    <label>{f.label}</label>
                    {renderFieldInput(f, formValues[f.field_key], (v) => updateFormField(f.field_key, v))}
                  </div>
                ))}
              </div>
              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </form>
          </div>
        </div>
      )}

      {showEmailModal && (
        <div className="modal-overlay" onClick={() => !emailSending && setShowEmailModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Email {selected.size} asset{selected.size === 1 ? '' : 's'}</h3>
              {!emailSending && <button type="button" onClick={() => setShowEmailModal(false)}><X size={18} /></button>}
            </div>
            {emailModalError && <div className="error-banner">{emailModalError}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>A CSV of the selected assets will be sent to everyone below.</p>
            <div className="attachment-list" style={{ marginBottom: 12 }}>
              {emailRecipients.map((email) => (
                <div key={email} className="attachment-row">
                  <span className="name">{email}</span>
                  <button type="button" className="danger" onClick={() => removeRecipient(email)} disabled={emailSending}>Remove</button>
                </div>
              ))}
              {emailRecipients.length === 0 && <p style={{ fontSize: 13, color: 'var(--muted)' }}>No recipients yet — add one below.</p>}
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
            <button className="btn btn-accent" style={{ width: '100%', justifyContent: 'center' }} onClick={handleSendEmail} disabled={emailSending || emailRecipients.length === 0}>
              {emailSending ? 'Sending…' : `Send to ${emailRecipients.length} ${emailRecipients.length === 1 ? 'address' : 'addresses'}`}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
