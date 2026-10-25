import { useEffect, useState } from 'react';
import { ShieldCheck, BellRing, Activity, Laptop, Copy, Check } from 'lucide-react';
import api from '../api';
import { forgetThisDevice } from '../context/AuthContext';

// Settings → Security & alerts: two-step login for admins, error alert emails,
// and how to set up an outside uptime check.
export default function SecuritySettings() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [emails, setEmails] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [copied, setCopied] = useState(false);

  function apply(data) { setS(data); setEmails(data.alerts.emails || ''); }
  useEffect(() => {
    api.get('/admin/security').then(({ data }) => apply(data)).catch((err) => setError(err.response?.data?.error || 'Could not load security settings'));
  }, []);

  async function save(body, okMsg) {
    setError(''); setNotice(''); setSaving(true);
    try {
      const { data } = await api.patch('/admin/security', body);
      apply(data);
      if (okMsg) setNotice(okMsg);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally { setSaving(false); }
  }

  async function sendTest() {
    setError(''); setNotice(''); setTesting(true);
    try {
      const { data } = await api.post('/admin/security/test-alert');
      setNotice(`Test alert sent to ${data.to.join(', ')}. Check those inboxes (and junk folders).`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the test alert');
    } finally { setTesting(false); }
  }

  async function forgetDevices() {
    if (!window.confirm('Forget every device you ticked "Remember this device" on? Your next login on each will ask for a code.')) return;
    try {
      const { data } = await api.delete('/auth/devices');
      forgetThisDevice();
      setNotice(`Forgot ${data.forgotten} device${data.forgotten === 1 ? '' : 's'}.`);
      const fresh = await api.get('/admin/security');
      apply(fresh.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not forget devices');
    }
  }

  const healthUrl = `${String(api.defaults.baseURL || '').replace(/\/$/, '')}/health`;
  async function copyHealth() {
    try { await navigator.clipboard.writeText(healthUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { /* copy blocked */ }
  }

  if (!s) return <div className="panel" style={{ padding: 24 }}>{error ? <span className="tc-err">{error}</span> : 'Loading…'}</div>;

  const ts = s.twoStep;
  const tsOn = ts.setting !== 'off';
  let tsStatus;
  if (ts.envOverride === 'off' || ts.envOverride === 'false' || ts.envOverride === '0' || ts.envOverride === 'no') tsStatus = { tone: 'warn', text: 'Switched off on the server (ADMIN_2FA=off on Render). Remove that setting to use the switch here.' };
  else if (ts.active) tsStatus = { tone: 'ok', text: 'On — admins are emailed a 6-digit code when they log in on a new device.' };
  else if (tsOn && !ts.emailConfigured) tsStatus = { tone: 'warn', text: 'Waiting on email: the server can’t send email yet, so admins log in with just their password.' };
  else tsStatus = { tone: 'off', text: 'Off — admins log in with just their password.' };

  return (
    <div className="sec">
      {error && <div className="error-banner" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="success-banner" style={{ marginBottom: 14 }}>{notice}</div>}

      <section className="panel sec-card">
        <div className="sec-head">
          <span className="sec-icon"><ShieldCheck size={18} /></span>
          <div className="sec-title">
            <h3>Two-step login for admins</h3>
            <p>After the right password, admins are emailed a code to finish logging in, so a stolen password alone isn’t enough. Ticking “Remember this device” skips the code on that browser for 30 days. Users and casuals aren’t affected.</p>
          </div>
          <button type="button" role="switch" aria-checked={tsOn} aria-label="Two-step login for admins" disabled={saving}
            className={'mu-switch' + (tsOn ? ' on' : '')} onClick={() => save({ twoStep: !tsOn }, tsOn ? 'Two-step login is off.' : 'Two-step login is on.')}>
            <span className="mu-knob" />
          </button>
        </div>
        <div className={`sec-status ${tsStatus.tone}`}>{tsStatus.text}</div>

        <div className="sec-sub">
          <h4><Laptop size={14} /> Your remembered devices</h4>
          {s.myDevices.length ? (
            <>
              <ul className="sec-devices">
                {s.myDevices.map((d) => (
                  <li key={d.id}>
                    <strong>{d.label || 'Unnamed device'}</strong>
                    <span>Remembered {fmt(d.createdAt)}{d.lastUsedAt ? ` · last used ${fmt(d.lastUsedAt)}` : ''} · until {fmt(d.expiresAt)}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost btn-sm" onClick={forgetDevices}>Forget all my devices</button>
            </>
          ) : <p className="tc-muted">None. Tick “Remember this device” when you enter a login code to add one.</p>}
          <p className="tc-muted" style={{ marginTop: 10 }}>Setting someone’s password, or logging them out everywhere, also forgets their devices.</p>
        </div>
      </section>

      <section className="panel sec-card">
        <div className="sec-head">
          <span className="sec-icon coral"><BellRing size={18} /></span>
          <div className="sec-title">
            <h3>Error alerts</h3>
            <p>Emails you when something goes wrong: a page fails with a server error, the nightly backup fails, or the Friday reminders or weekly invoicing email break. Repeats of the same problem are held back for 30 minutes.</p>
          </div>
          <button type="button" role="switch" aria-checked={s.alerts.enabled} aria-label="Error alerts" disabled={saving}
            className={'mu-switch' + (s.alerts.enabled ? ' on' : '')} onClick={() => save({ alertsEnabled: !s.alerts.enabled }, s.alerts.enabled ? 'Error alerts are off.' : 'Error alerts are on.')}>
            <span className="mu-knob" />
          </button>
        </div>
        <form className="sec-form" onSubmit={(e) => { e.preventDefault(); save({ alertEmails: emails }, 'Alert emails saved.'); }}>
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor="alert-emails">Send alerts to</label>
            <input id="alert-emails" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Leave blank to email every admin" />
          </div>
          <div className="sec-actions">
            <button type="submit" className="btn btn-accent btn-sm" disabled={saving || emails === (s.alerts.emails || '')}>Save</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={sendTest} disabled={testing}>{testing ? 'Sending…' : 'Send a test alert'}</button>
          </div>
        </form>
        <p className="tc-muted" style={{ marginTop: 10 }}>
          {s.alerts.enabled ? 'Going to: ' : 'Off. Would go to: '}{s.alerts.recipients.length ? s.alerts.recipients.join(', ') : 'nobody yet — add an email above'}
        </p>
      </section>

      <section className="panel sec-card">
        <div className="sec-head">
          <span className="sec-icon blue"><Activity size={18} /></span>
          <div className="sec-title">
            <h3>Uptime check</h3>
            <p>Error alerts can’t tell you if Work Desk is completely down. A free outside service can: it checks the address below every 5 minutes and emails or texts you if it stops answering.</p>
          </div>
        </div>
        <div className="sec-url">
          <code>{healthUrl}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={copyHealth}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button>
        </div>
        <ol className="sec-steps">
          <li>Sign up free at <a href="https://uptimerobot.com" target="_blank" rel="noreferrer">uptimerobot.com</a>.</li>
          <li>Click <b>New monitor</b>, choose <b>HTTP(s)</b>, and paste the address above.</li>
          <li>Set the interval to 5 minutes and tick who to alert (email, or the phone app for push notifications).</li>
        </ol>
        <p className="tc-muted">The check also tests the database, so it shows “down” if the server is up but the data can’t be read.</p>
      </section>
    </div>
  );
}

function fmt(iso) {
  if (!iso) return '';
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
