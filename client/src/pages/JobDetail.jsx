import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Paperclip, Pencil, CheckCircle2, X, FileText, Mail, PenLine, Wrench, MapPin, History, AlertTriangle } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import AttachmentManager from '../components/AttachmentManager';
import ItemsManager from '../components/ItemsManager';
import SignaturePad from '../components/SignaturePad';
import { openJobPdf } from '../utils/pdf';
import { formatDMY } from '../utils/date';
import { StatusPill, PriorityPill } from '../components/Pill';

const STATUSES = ['Open', 'In Progress', 'On Hold', 'Complete', 'Collected', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

export default function JobDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreated, setShowCreated] = useState(!!location.state?.justCreated);

  const [job, setJob] = useState(null);
  const [notes, setNotes] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [items, setItems] = useState([]);
  const [audit, setAudit] = useState([]);
  const [users, setUsers] = useState([]);
  const [noteBody, setNoteBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [emailingPdf, setEmailingPdf] = useState(false);
  const [emailSentMsg, setEmailSentMsg] = useState('');

  const load = useCallback(() => {
    api.get(`/jobs/${id}`).then((res) => {
      setJob(res.data.job);
      setNotes(res.data.notes);
      setAttachments(res.data.attachments);
      setItems(res.data.items || []);
      setAudit(res.data.audit || []);
    }).catch(() => setError('Could not load job'));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/users').then((res) => setUsers(res.data.users)); }, []);

  async function updateField(field, value) {
    const { data } = await api.patch(`/jobs/${id}`, { [field]: value });
    setJob(data.job);
    load(); // refresh audit trail too
  }

  async function handleNote(e) {
    e.preventDefault();
    if (!noteBody.trim()) return;
    setSending(true);
    try {
      const { data } = await api.post(`/jobs/${id}/notes`, { body: noteBody });
      setNotes((prev) => [...prev, data.note]);
      setNoteBody('');
      if (data.job) {
        setJob(data.job);
        if (data.job.status !== job.status) load(); // status auto-changed — pull fresh audit entry too
      }
    } finally {
      setSending(false);
    }
  }

  async function handleSaveSignature(name, dataUrl, comments) {
    const { data } = await api.post(`/jobs/${id}/signature`, { name, dataUrl, comments });
    setJob(data.job);
    setShowSignaturePad(false);
  }

  async function handleClearSignature() {
    if (!confirm('Remove this signature?')) return;
    const { data } = await api.delete(`/jobs/${id}/signature`);
    setJob(data.job);
  }

  async function handleDownloadPdf() {
    setGeneratingPdf(true);
    try {
      await openJobPdf(api, id);
    } finally {
      setGeneratingPdf(false);
    }
  }

  async function handleEmailPdf() {
    setEmailingPdf(true);
    setEmailSentMsg('');
    try {
      const { data } = await api.post(`/jobs/${id}/email-pdf`);
      setEmailSentMsg(`Job sheet emailed to ${data.sentTo}`);
    } catch (err) {
      setEmailSentMsg(err.response?.data?.error || 'Could not send email');
    } finally {
      setEmailingPdf(false);
    }
  }

  if (error) return <Layout><div className="empty-state"><h3>{error}</h3></div></Layout>;
  if (!job) return <Layout><div className="empty-state">Loading…</div></Layout>;

  return (
    <Layout>
      <Link to="/jobs" className="back-link">&larr; Back to jobs</Link>

      {showCreated && (
        <div className="success-banner">
          <span><CheckCircle2 size={15} style={{ verticalAlign: -3, marginRight: 6 }} />Job #{job.job_number} created successfully.</span>
          <button type="button" onClick={() => setShowCreated(false)}><X size={15} /></button>
        </div>
      )}

      <div className="page-header">
        <div>
          <h1>
            #{job.job_number} &middot; {job.subject}
            {job.overdue && <span className="overdue-badge" style={{ marginLeft: 10 }}><AlertTriangle size={11} /> Overdue</span>}
          </h1>
          <div className="subtitle">{job.contact_name}{job.account_name ? ` · ${job.account_name}` : ''} &middot; {job.channel}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={handleDownloadPdf} disabled={generatingPdf}>
            <FileText size={14} /> {generatingPdf ? 'Generating…' : 'Job Sheet PDF'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={handleEmailPdf} disabled={emailingPdf || !job.email} title={!job.email ? 'No contact email on file' : ''}>
            <Mail size={14} /> {emailingPdf ? 'Sending…' : 'Email Job Sheet'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/jobs/${id}/edit`)}>
            <Pencil size={14} /> Edit details
          </button>
        </div>
      </div>

      {emailSentMsg && (
        <div className={emailSentMsg.startsWith('Job sheet') ? 'success-banner' : 'error-banner'} style={{ marginBottom: 16 }}>
          {emailSentMsg}
        </div>
      )}

      <div className="detail-grid">
        <div>
          <div className="panel" style={{ padding: 18 }}>
            <div className="comment-meta">
              <strong style={{ color: 'var(--ink)' }}>Description</strong>
            </div>
            <div className="comment-body">{job.description || <em style={{ color: 'var(--muted)' }}>No description provided.</em>}</div>
          </div>

          {job.site_address && (
            <div className="panel" style={{ padding: 18, marginTop: 18 }}>
              <div className="comment-meta">
                <strong style={{ color: 'var(--ink)' }}><MapPin size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Site</strong>
              </div>
              <div className="comment-body">{job.site_address}</div>
              {job.access_notes && (
                <div className="comment-body" style={{ marginTop: 8, color: 'var(--muted)', fontSize: 13 }}>
                  <strong style={{ color: 'var(--ink)' }}>Access notes: </strong>{job.access_notes}
                </div>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div className="panel" style={{ padding: 18, marginTop: 18 }}>
              <div className="comment-meta">
                <strong style={{ color: 'var(--ink)' }}><Wrench size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Equipment / Items</strong>
              </div>
              <ItemsManager jobId={id} initialItems={items} />
            </div>
          )}

          <div className="panel" style={{ padding: 18, marginTop: 18 }}>
            <div className="comment-meta">
              <strong style={{ color: 'var(--ink)' }}><Paperclip size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Attachments</strong>
            </div>
            <AttachmentManager jobId={id} initialAttachments={attachments} />
          </div>

          <div className="thread">
            {notes.map((n) => (
              <div key={n.id} className="comment">
                <div className="comment-meta">
                  <strong style={{ color: 'var(--ink)' }}>{n.author?.name}</strong>
                  <span>{formatDateTime(n.created_at)}</span>
                </div>
                <div className="comment-body">{n.body}</div>
              </div>
            ))}
          </div>

          <div className="panel reply-box" style={{ padding: 18, marginTop: 18 }}>
            <form onSubmit={handleNote}>
              <textarea
                placeholder="Log an update on this job…"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
              />
              <div className="reply-actions">
                <span />
                <button className="btn btn-primary btn-sm" type="submit" disabled={sending || !noteBody.trim()}>
                  {sending ? 'Saving…' : 'Add note'}
                </button>
              </div>
            </form>
          </div>

          <div className="panel" style={{ padding: 18, marginTop: 18 }}>
            <div className="comment-meta">
              <strong style={{ color: 'var(--ink)' }}><PenLine size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Sign-off</strong>
            </div>
            {job.signature_data ? (
              <div>
                {job.comments && (
                  <div style={{ fontSize: 13, color: 'var(--ink)', background: 'var(--paper)', borderRadius: 8, padding: '8px 12px', marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                    {job.comments}
                  </div>
                )}
                <div className="signature-preview">
                  <img src={job.signature_data} alt="Customer signature" />
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
                  Signed by <strong style={{ color: 'var(--ink)' }}>{job.signature_name}</strong> on {formatDateTime(job.signature_at)}
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSignaturePad(true)}>Re-capture</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={handleClearSignature}>Remove</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-accent btn-sm" onClick={() => setShowSignaturePad(true)}>
                Fill out job sheet
              </button>
            )}
          </div>
        </div>

        <div>
          <div className="panel side-block">
            <h4>Job details</h4>
            <div className="side-row">
              <label>Status</label>
              <select value={job.status} onChange={(e) => updateField('status', e.target.value)}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="side-row">
              <label>Priority</label>
              <select value={job.priority || ''} onChange={(e) => updateField('priority', e.target.value)}>
                <option value="">-None-</option>
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="side-row">
              <label>Owner</label>
              <select value={job.owner_id || ''} onChange={(e) => updateField('owner_id', e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>

          <div className="panel side-block">
            <h4>Contact</h4>
            <div className="side-row"><label>Name</label><span>{job.contact_name}</span></div>
            {job.account_name && <div className="side-row"><label>Account</label><span>{job.account_name}</span></div>}
            {job.email && <div className="side-row"><label>Email</label><span>{job.email}</span></div>}
            {job.phone && <div className="side-row"><label>Phone</label><span>{job.phone}</span></div>}
          </div>

          {(job.product_name || job.due_date || job.scheduled_time || job.language || job.classifications || job.customer_reference) && (
            <div className="panel side-block">
              <h4>Additional info</h4>
              {job.product_name && <div className="side-row"><label>Product</label><span>{job.product_name}</span></div>}
              {job.due_date && <div className="side-row"><label>Due date</label><span>{formatDMY(job.due_date)}</span></div>}
              {job.scheduled_time && <div className="side-row"><label>Time</label><span>{job.scheduled_time}</span></div>}
              {job.language && <div className="side-row"><label>Vehicle</label><span>{job.language}</span></div>}
              {job.classifications && <div className="side-row"><label>Classification</label><span>{job.classifications}</span></div>}
              {job.customer_reference && <div className="side-row"><label>Reference</label><span>{job.customer_reference}</span></div>}
            </div>
          )}

          {audit.length > 0 && (
            <div className="panel side-block">
              <h4><History size={12} style={{ verticalAlign: -1, marginRight: 4 }} />History</h4>
              {audit.map((a) => (
                <div key={a.id} className="audit-item">
                  <strong>{a.user?.name || 'System'}</strong> changed {fieldLabel(a.field)} from{' '}
                  <strong>{a.old_value || '—'}</strong> to <strong>{a.new_value || '—'}</strong>
                  <div>{formatDateTime(a.changed_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showSignaturePad && (
        <SignaturePad
          defaultName={job.signature_name || job.contact_name}
          defaultComments={job.comments}
          onSave={handleSaveSignature}
          onClose={() => setShowSignaturePad(false)}
        />
      )}
    </Layout>
  );
}

function formatDateTime(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fieldLabel(field) {
  return field === 'owner_id' ? 'owner' : field;
}
