import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-logo-badge"><img src="/logo.jpg" alt="IT Factory" /></span>
          <strong style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>Work Desk</strong>
        </div>

        {sent ? (
          <>
            <h1>Check your email</h1>
            <p className="subtitle">If an account exists for {email}, a password reset link is on its way. It expires in 1 hour.</p>
          </>
        ) : (
          <>
            <h1>Forgot your password?</h1>
            <p className="subtitle">Enter your email and we'll send you a reset link.</p>
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
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
