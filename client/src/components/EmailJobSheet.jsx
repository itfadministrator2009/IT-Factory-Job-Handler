import { useState } from 'react';
import { Mail, X, Plus } from 'lucide-react';
import EmailChips, { addEmails, isEmail } from './EmailChips';

// "Email Job Sheet": opens a small window with admin@itfactory.com.au filled in.
// More addresses can be added (typed, pasted, or the job's contact with one
// click) before the job sheet PDF is sent to all of them in one email.
const DEFAULT_TO = 'admin@itfactory.com.au';

export default function EmailJobSheet({ api, job, onResult }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState([DEFAULT_TO]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const contact = (job.email || '').trim();
  const hasContact = contact && to.some((a) => a.toLowerCase() === contact.toLowerCase());

  function show() {
    setTo([DEFAULT_TO]);
    setDraft('');
    setError('');
    setOpen(true);
  }

  async function send() {
    const recipients = addEmails(to, draft);
    const bad = recipients.filter((a) => !isEmail(a));
    if (!recipients.length) { setError('Add at least one email address.'); return; }
    if (bad.length) { setError(`Not a valid email address: ${bad.join(', ')}`); return; }
    setTo(recipients);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/jobs/${job.id}/email-pdf`, { toEmails: recipients });
      setOpen(false);
      onResult?.(`Job sheet emailed to ${data.sentTo}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the email');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={show}>
        <Mail size={14} /> Email Job Sheet
      </button>

      {open && (
        <div className="modal-overlay" onClick={() => !busy && setOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>Email job sheet — #{job.job_number}</h3>
              {!busy && <button type="button" onClick={() => setOpen(false)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              The job sheet PDF is sent to everyone below in one email.
            </p>
            <div className="field">
              <label htmlFor="jobsheet-to">Send to</label>
              <EmailChips id="jobsheet-to" value={to} onChange={setTo} draft={draft} onDraftChange={setDraft} placeholder="name@example.com" />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Press Enter or comma after each address. You can also paste a list.</div>
            </div>
            {contact && !hasContact && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTo(addEmails(to, contact))} style={{ marginTop: 2 }}>
                <Plus size={13} /> Add job contact ({contact})
              </button>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy} style={{ flex: 1 }}>Cancel</button>
              <button type="button" className="btn btn-accent" onClick={send} disabled={busy || (!to.length && !draft.trim())} style={{ flex: 1 }}>
                {busy ? 'Sending…' : 'Send job sheet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
