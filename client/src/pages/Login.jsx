import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { takeLogoutReason } from '../session';

export default function Login() {
  const { login, verifyCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Only same-site paths (never "//other.site").
  const from = typeof location.state?.from === 'string' && /^\/(?!\/)/.test(location.state.from) ? location.state.from : '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Two-step login (admins): the emailed-code step.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const codeRef = useRef(null);
  const signedOut = new URLSearchParams(location.search).get('signedOut') === '1';
  // Logged out after 30 minutes with no activity (shown once).
  const [idleOut] = useState(() => takeLogoutReason() === 'idle');

  useEffect(() => { if (challenge) codeRef.current?.focus(); }, [challenge]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await login(email, password);
      if (r?.twoStep) { setChallenge(r); setCode(''); return; }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await verifyCode(challenge.challengeId, code, remember);
      navigate(from, { replace: true });
    } catch (err) {
      const data = err.response?.data || {};
      setError(data.error || 'That code didn’t work');
      // Expired or too many tries: back to the password step for a new code.
      if (err.response?.status === 429 || /expired|Log in again/i.test(data.error || '')) { setChallenge(null); setPassword(''); }
      setCode('');
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError('');
    setLoading(true);
    try {
      const r = await login(email, password);
      if (r?.twoStep) { setChallenge(r); setCode(''); } else navigate(from, { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send a new code');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo.png" alt="IT Factory" className="brand-logo" />
          <strong style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Work Desk</strong>
        </div>

        {challenge ? (
          <>
            <div className="twostep-icon"><ShieldCheck size={22} /></div>
            <h1>Check your email</h1>
            <p className="subtitle">We sent a 6-digit login code to <strong>{challenge.sentTo}</strong>. It expires in {challenge.expiresInMinutes} minutes.</p>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleCode}>
              <div className="field">
                <label htmlFor="code">Login code</label>
                <input
                  id="code" ref={codeRef} className="twostep-code"
                  inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000000"
                  value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required
                />
              </div>
              <label className="twostep-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span>Remember this device for 30 days</span>
              </label>
              <button className="btn btn-accent" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading || code.length !== 6}>
                {loading ? 'Checking…' : 'Verify and log in'}
              </button>
            </form>
            <div className="auth-switch">
              Didn’t get it? <button type="button" onClick={resend} disabled={loading}>Send a new code</button>
            </div>
            <div className="auth-switch">
              <button type="button" onClick={() => { setChallenge(null); setError(''); setPassword(''); }}>Use a different account</button>
            </div>
          </>
        ) : (
          <>
            <h1>Welcome back</h1>
            <p className="subtitle">Log in to your Work Desk account.</p>
            {idleOut && !signedOut && !error && (
              <div className="error-banner" style={{ marginBottom: 14 }}>You were logged out after 30 minutes with no activity. Please log in again.</div>
            )}
            {signedOut && !error && (
              <div className="error-banner" style={{ marginBottom: 14 }}>You were logged out by an admin. Please log in again.</div>
            )}

            {error && <div className="error-banner">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <div className="password-field-wrap">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <button className="btn btn-accent" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
                {loading ? 'Logging in…' : 'Log in'}
              </button>
            </form>

            <div className="auth-switch">
              <Link to="/forgot-password"><button type="button">Forgot password?</button></Link>
            </div>

            <p className="auth-switch" style={{ color: 'var(--muted)' }}>New to Work Desk? Ask an admin to add you.</p>
          </>
        )}
      </div>
    </div>
  );
}
