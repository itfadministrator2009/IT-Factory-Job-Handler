import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import api from '../api';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not reset password');
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

        {!token ? (
          <>
            <h1>Invalid link</h1>
            <p className="subtitle">This reset link is missing its token. Request a new one.</p>
          </>
        ) : done ? (
          <>
            <h1>Password updated</h1>
            <p className="subtitle">Taking you to log in…</p>
          </>
        ) : (
          <>
            <h1>Set a new password</h1>
            <p className="subtitle">Choose a new password for your account.</p>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="password">New password</label>
                <div className="password-field-wrap">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    minLength={8}
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
              <div className="field">
                <label htmlFor="confirm">Confirm password</label>
                <div className="password-field-wrap">
                  <input
                    id="confirm"
                    type={showPassword ? 'text' : 'password'}
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
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
              <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
                {loading ? 'Saving…' : 'Reset password'}
              </button>
            </form>
          </>
        )}

        <div className="auth-switch">
          <Link to="/login"><button type="button">Back to log in</button></Link>
        </div>
      </div>
    </div>
  );
}
