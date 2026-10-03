import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import portalApi, { savePortalSession } from '../portal/portalApi';

export default function PortalLogin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(params.get('expired') ? 'Your session has ended — please sign in again.' : '');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await portalApi.post('/login', { username, password });
      savePortalSession(data.token, data.client);
      navigate('/portal', { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/logo.png" alt="IT Factory" className="brand-logo" />
          <strong style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Storage Centre</strong>
        </div>
        <h1>Client portal</h1>
        <p className="subtitle">Sign in to see your stock, orders and deliveries.</p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="portal-username">Username</label>
            <input id="portal-username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="portal-password">Password</label>
            <div className="password-field-wrap">
              <input
                id="portal-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="password-toggle" onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'} tabIndex={-1}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="auth-switch">Forgotten your password? Contact IT Factory on 1300 589 579 and we'll reset it.</div>
      </div>
    </div>
  );
}
