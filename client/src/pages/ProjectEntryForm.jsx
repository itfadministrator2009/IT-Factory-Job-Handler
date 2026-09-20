import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import SignaturePadLib from 'signature_pad';
import { CheckCircle2, Camera, Trash2, Plus, FileText, Mail, X } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

// Mirrors the exact same conditional-logic rules as the backend's validateSubmission
// (server/routes/projects.js) — kept in sync deliberately, since the two must agree
// on what's visible/required or the live form and the submit check would disagree.
function matchesCondition(cond, instanceAnswers) {
  if (!cond) return true;
  const val = instanceAnswers[cond.field];
  if (cond.equals !== undefined) return val === cond.equals;
  if (cond.notEmpty) return val !== undefined && val !== null && val !== '';
  if (cond.empty) return val === undefined || val === null || val === '';
  return true;
}
function isFieldVisible(field, instanceAnswers) {
  return matchesCondition(field.visibleIf, instanceAnswers);
}
function isFieldRequired(field, instanceAnswers) {
  if (field.required) return true;
  if (field.requiredIf) return matchesCondition(field.requiredIf, instanceAnswers);
  return false;
}

export default function ProjectEntryForm() {
  const { id, entryId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';

  const [project, setProject] = useState(null);
  const [entry, setEntry] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [answers, setAnswers] = useState(null);
  const [saveState, setSaveState] = useState(''); // '', 'saving', 'saved'
  const [problems, setProblems] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [reassigning, setReassigning] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [emailingPdf, setEmailingPdf] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState([]);
  const [newRecipientInput, setNewRecipientInput] = useState('');
  const [emailModalError, setEmailModalError] = useState('');
  const [emailSentMsg, setEmailSentMsg] = useState('');
  const saveTimer = useRef(null);

  useEffect(() => { if (isAdmin) api.get('/users').then((res) => setAllUsers(res.data.users)); }, [isAdmin]);

  useEffect(() => {
    api.get(`/projects/${id}`).then((res) => setProject(res.data.project));
    api.get(`/projects/${id}/entries/${entryId}`).then((res) => {
      setEntry(res.data.entry);
      setAnswers(res.data.entry.answers || {});
      setPhotos(res.data.photos);
    });
  }, [id, entryId]);

  // Debounced autosave — saves 1.2s after the last change, so a long form never
  // loses work if someone gets interrupted mid-way through a site visit.
  const scheduleSave = useCallback((nextAnswers) => {
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await api.patch(`/projects/${id}/entries/${entryId}`, { answers: nextAnswers });
      setSaveState('saved');
    }, 1200);
  }, [id, entryId]);

  function updateField(sectionId, fieldId, value, repeatIndex) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (repeatIndex === undefined) {
        next[sectionId] = { ...(next[sectionId] || {}), [fieldId]: value };
      } else {
        const arr = Array.isArray(next[sectionId]) ? [...next[sectionId]] : [];
        arr[repeatIndex] = { ...(arr[repeatIndex] || {}), [fieldId]: value };
        next[sectionId] = arr;
      }
      scheduleSave(next);
      return next;
    });
  }

  function addInstance(sectionId) {
    setAnswers((prev) => {
      const next = { ...prev };
      next[sectionId] = [...(Array.isArray(next[sectionId]) ? next[sectionId] : []), {}];
      scheduleSave(next);
      return next;
    });
  }

  function removeInstance(sectionId, idx) {
    if (!confirm('Remove this entry?')) return;
    setAnswers((prev) => {
      const next = { ...prev };
      next[sectionId] = (next[sectionId] || []).filter((_, i) => i !== idx);
      scheduleSave(next);
      return next;
    });
  }

  async function handlePhotoUpload(fieldId, repeatIndex, file) {
    const form = new FormData();
    form.append('file', file);
    form.append('field_id', fieldId);
    if (repeatIndex !== undefined) form.append('repeat_index', repeatIndex);
    const { data } = await api.post(`/projects/${id}/entries/${entryId}/photos`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    // Appends rather than replaces — a field can hold more than one photo (e.g.
    // several angles of a rack, or multiple pages of a config printout).
    setPhotos((prev) => [...prev, data.photo]);
  }

  async function handlePhotoDelete(photoId) {
    await api.delete(`/projects/photos/${photoId}`);
    setPhotos((prev) => prev.filter((p) => p.id !== photoId));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setProblems([]);
    try {
      const { data } = await api.patch(`/projects/${id}/entries/${entryId}`, { answers, submit: true });
      setEntry(data.entry);
    } catch (err) {
      setProblems(err.response?.data?.problems || [err.response?.data?.error || 'Could not submit']);
      window.scrollTo(0, 0);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReassign(newAssignedTo) {
    setReassigning(true);
    try {
      const { data } = await api.patch(`/projects/${id}/entries/${entryId}`, { assigned_to: newAssignedTo || null });
      setEntry(data.entry);
    } finally {
      setReassigning(false);
    }
  }

  async function handleViewPdf() {
    setGeneratingPdf(true);
    try {
      const res = await api.get(`/projects/${id}/entries/${entryId}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      // A blob URL has no filename of its own — if the browser hands the file off to
      // an external viewer (Adobe Acrobat, etc.) rather than showing it inline, that
      // app's own Save dialog just shows whatever temporary name the download got,
      // which is why this needs an explicit filename here rather than just opening
      // the blob URL directly.
      const rawName = `${project.name} - ${entry.site_name || `Entry ${entry.entry_number}`}`;
      const fileName = rawName.replace(/[\\/:*?"<>|]/g, '').trim() + '.pdf';
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      // no-op — nothing was opened to clean up
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function openEmailModal() {
    setEmailModalError('');
    setNewRecipientInput('');
    setShowEmailModal(true);
    try {
      const { data } = await api.get(`/projects/${id}/entries/${entryId}/email-defaults`);
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
    if (emailRecipients.includes(email)) {
      setNewRecipientInput('');
      return;
    }
    setEmailRecipients((prev) => [...prev, email]);
    setNewRecipientInput('');
    setEmailModalError('');
  }

  async function handleSendEmail() {
    setEmailingPdf(true);
    setEmailModalError('');
    try {
      const { data } = await api.post(`/projects/${id}/entries/${entryId}/email-pdf`, { recipients: emailRecipients });
      setShowEmailModal(false);
      setEmailSentMsg(`Sent to ${data.sentTo.join(', ')}`);
    } catch (err) {
      setEmailModalError(err.response?.data?.error || 'Could not send email');
    } finally {
      setEmailingPdf(false);
    }
  }

  if (!project || !entry || !answers) return <Layout><div className="empty-state">Loading…</div></Layout>;

  const readOnly = entry.status === 'Submitted';

  return (
    <Layout>
      <Link to={`/projects/${id}`} className="back-link">&larr; Back to {project.name}</Link>

      <div className="page-header">
        <div>
          <h1>Entry #{entry.entry_number}</h1>
          <div className="subtitle">{project.name}{entry.site_name ? ` · ${entry.site_name}` : ''}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!readOnly && saveState && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={handleViewPdf} disabled={generatingPdf}>
            <FileText size={14} /> {generatingPdf ? 'Generating…' : 'View PDF'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={openEmailModal} disabled={emailingPdf}>
            <Mail size={14} /> Email PDF
          </button>
          {readOnly ? (
            <span className="success-banner" style={{ margin: 0 }}><CheckCircle2 size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Submitted</span>
          ) : (
            <button className="btn btn-accent" onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
          )}
        </div>
      </div>

      {emailSentMsg && (
        <div className={emailSentMsg.startsWith('Sent to') ? 'success-banner' : 'error-banner'} style={{ marginBottom: 16 }}>
          {emailSentMsg}
        </div>
      )}

      {!readOnly && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 20, flexWrap: 'wrap' }}>
          <div className="field" style={{ maxWidth: 380, marginBottom: 0 }}>
            <label htmlFor="site-name">Site name</label>
            <input
              id="site-name"
              defaultValue={entry.site_name || ''}
              onBlur={(e) => api.patch(`/projects/${id}/entries/${entryId}`, { site_name: e.target.value })}
              placeholder="e.g. Harvey Norman Chatswood"
            />
          </div>
          {isAdmin && (
            <div className="field" style={{ maxWidth: 240, marginBottom: 0 }}>
              <label htmlFor="assigned-to">Assigned to</label>
              <select
                id="assigned-to"
                value={entry.assigned_to || ''}
                onChange={(e) => handleReassign(e.target.value)}
                disabled={reassigning}
              >
                <option value="">Unassigned</option>
                {allUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <div className="error-banner">
          <strong>This entry is incomplete:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {project.template.sections.map((section) => (
        <SectionBlock
          key={section.id}
          section={section}
          answers={answers}
          readOnly={readOnly}
          photos={photos}
          onFieldChange={updateField}
          onAddInstance={addInstance}
          onRemoveInstance={removeInstance}
          onPhotoUpload={handlePhotoUpload}
          onPhotoDelete={handlePhotoDelete}
          apiBase={id}
        />
      ))}

      {showEmailModal && (
        <div className="modal-overlay" onClick={() => !emailingPdf && setShowEmailModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Email PDF</h3>
              {!emailingPdf && <button type="button" onClick={() => setShowEmailModal(false)}><X size={18} /></button>}
            </div>
            {emailModalError && <div className="error-banner">{emailModalError}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              This will be sent to everyone below. Add or remove addresses as needed.
            </p>
            <div className="attachment-list" style={{ marginBottom: 12 }}>
              {emailRecipients.map((email) => (
                <div key={email} className="attachment-row">
                  <span className="name">{email}</span>
                  <button type="button" className="danger" onClick={() => removeRecipient(email)} disabled={emailingPdf}>Remove</button>
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
                disabled={emailingPdf}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={addRecipient} disabled={emailingPdf}>Add</button>
            </div>
            <button
              className="btn btn-accent"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleSendEmail}
              disabled={emailingPdf || emailRecipients.length === 0}
            >
              {emailingPdf ? 'Sending…' : `Send to ${emailRecipients.length} ${emailRecipients.length === 1 ? 'address' : 'addresses'}`}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

function SectionBlock({ section, answers, readOnly, photos, onFieldChange, onAddInstance, onRemoveInstance, onPhotoUpload, onPhotoDelete }) {
  if (section.repeatable) {
    const instances = Array.isArray(answers[section.id]) ? answers[section.id] : [];
    return (
      <div className="panel" style={{ padding: 18, marginTop: 18 }}>
        <div className="comment-meta"><strong style={{ color: 'var(--ink)' }}>{section.title}</strong></div>
        {section.instruction && <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>{section.instruction}</p>}
        {instances.map((instanceAnswers, idx) => (
          <div key={idx} className="panel" style={{ padding: 16, marginBottom: 14, background: 'var(--paper)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>{section.title} #{idx + 1}</strong>
              {!readOnly && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemoveInstance(section.id, idx)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            {section.fields.map((field) => (
              <FieldRenderer
                key={field.id}
                field={field}
                instanceAnswers={instanceAnswers}
                readOnly={readOnly}
                photos={photos}
                repeatIndex={idx}
                onChange={(value) => onFieldChange(section.id, field.id, value, idx)}
                onPhotoUpload={(file) => onPhotoUpload(field.id, idx, file)}
                onPhotoDelete={onPhotoDelete}
              />
            ))}
          </div>
        ))}
        {!readOnly && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAddInstance(section.id)}>
            <Plus size={13} /> Add {section.title}
          </button>
        )}
        {instances.length === 0 && readOnly && <p style={{ color: 'var(--muted)', fontSize: 13 }}>None recorded.</p>}
      </div>
    );
  }

  const instanceAnswers = answers[section.id] || {};
  return (
    <div className="panel" style={{ padding: 18, marginTop: 18 }}>
      <div className="comment-meta"><strong style={{ color: 'var(--ink)' }}>{section.title}</strong></div>
      {section.fields.map((field) => (
        <FieldRenderer
          key={field.id}
          field={field}
          instanceAnswers={instanceAnswers}
          readOnly={readOnly}
          photos={photos}
          repeatIndex={undefined}
          onChange={(value) => onFieldChange(section.id, field.id, value, undefined)}
          onPhotoUpload={(file) => onPhotoUpload(field.id, undefined, file)}
          onPhotoDelete={onPhotoDelete}
        />
      ))}
    </div>
  );
}

function FieldRenderer({ field, instanceAnswers, readOnly, photos, repeatIndex, onChange, onPhotoUpload, onPhotoDelete }) {
  if (!isFieldVisible(field, instanceAnswers)) return null;
  const required = isFieldRequired(field, instanceAnswers);
  const value = instanceAnswers[field.id];

  if (field.type === 'instruction') {
    return (
      <p style={{ fontSize: 13, color: 'var(--muted)', background: 'var(--paper)', borderRadius: 6, padding: '8px 12px', marginBottom: 14 }}>
        {field.label}
      </p>
    );
  }

  const label = (
    <label>{field.label}{required && <span className="req">*</span>}</label>
  );

  if (field.type === 'text') {
    return (
      <div className="field">
        {label}
        {readOnly ? <div className="comment-body">{value || <em style={{ color: 'var(--muted)' }}>—</em>}</div>
          : <input value={value || ''} onChange={(e) => onChange(e.target.value)} />}
      </div>
    );
  }
  if (field.type === 'textarea') {
    return (
      <div className="field">
        {label}
        {readOnly ? <div className="comment-body">{value || <em style={{ color: 'var(--muted)' }}>—</em>}</div>
          : <textarea value={value || ''} onChange={(e) => onChange(e.target.value)} />}
      </div>
    );
  }
  if (field.type === 'date') {
    return (
      <div className="field">
        {label}
        {readOnly ? <div className="comment-body">{value || '—'}</div>
          : <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} />}
      </div>
    );
  }
  if (field.type === 'datetime') {
    return (
      <div className="field">
        {label}
        {readOnly ? <div className="comment-body">{value || '—'}</div>
          : <input type="datetime-local" value={value || ''} onChange={(e) => onChange(e.target.value)} />}
      </div>
    );
  }
  if (field.type === 'yesno') {
    return (
      <div className="field">
        {label}
        {readOnly ? <div className="comment-body">{value || '—'}</div>
          : (
            <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
              <option value="">-Select-</option>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
          )}
      </div>
    );
  }
  if (field.type === 'photo') {
    const key = repeatIndex === undefined ? null : repeatIndex;
    const fieldPhotos = photos.filter((p) => p.field_id === field.id && (p.repeat_index ?? null) === key);
    return (
      <div className="field">
        {label}
        {fieldPhotos.length > 0 && (
          <div className="attachment-list">
            {fieldPhotos.map((photo) => (
              <div key={photo.id} className="attachment-row">
                <span className="name"><Camera size={13} /> {photo.original_name}</span>
                {!readOnly && (
                  <button type="button" className="danger" onClick={() => onPhotoDelete(photo.id)}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}
        {fieldPhotos.length === 0 && readOnly && (
          <div className="comment-body"><em style={{ color: 'var(--muted)' }}>No photo</em></div>
        )}
        {!readOnly && (
          <label className="dropzone" style={{ display: 'block', cursor: 'pointer', marginTop: fieldPhotos.length > 0 ? 8 : 0 }}>
            <Camera size={16} style={{ marginBottom: 4 }} /><br />
            {fieldPhotos.length > 0 ? 'Tap to add another photo' : 'Tap to take or upload a photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files[0]) onPhotoUpload(e.target.files[0]); e.target.value = ''; }}
            />
          </label>
        )}
      </div>
    );
  }
  if (field.type === 'signature') {
    return (
      <div className="field">
        {label}
        {readOnly ? (
          value ? <div className="signature-preview"><img src={value} alt="Signature" /></div> : <div className="comment-body"><em style={{ color: 'var(--muted)' }}>Not signed</em></div>
        ) : (
          <SignatureField value={value} onSave={onChange} />
        )}
      </div>
    );
  }
  return null;
}

function SignatureField({ value, onSave }) {
  const canvasRef = useRef(null);
  const padRef = useRef(null);
  const [signed, setSigned] = useState(!!value);

  useEffect(() => {
    if (signed) return; // already have a saved signature — no need for a live canvas
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    padRef.current = new SignaturePadLib(canvas, { backgroundColor: 'rgb(255,255,255)', penColor: 'rgb(20,20,20)' });
  }, [signed]);

  if (signed && value) {
    return (
      <div>
        <div className="signature-preview"><img src={value} alt="Signature" /></div>
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setSigned(false)}>Re-sign</button>
      </div>
    );
  }

  return (
    <div>
      <div className="signature-canvas-wrap">
        <canvas ref={canvasRef} className="signature-canvas" />
      </div>
      <div className="signature-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => padRef.current?.clear()}>Clear</button>
        <button
          type="button"
          className="btn btn-accent btn-sm"
          onClick={() => {
            if (padRef.current.isEmpty()) return;
            const dataUrl = padRef.current.toDataURL('image/png');
            onSave(dataUrl);
            setSigned(true);
          }}
        >
          Save signature
        </button>
      </div>
    </div>
  );
}
