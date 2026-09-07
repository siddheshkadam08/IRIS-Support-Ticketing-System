import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { BRAND_FOOTER } from '../lib/labels';

export default function Login() {
  const { signIn, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <div className="side-logo" style={{ width: 40, height: 40 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="7" width="16" height="12" rx="3.2" stroke="#fff" strokeWidth="1.7" />
              <path d="M12 3.4v3.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
              <circle cx="12" cy="2.7" r="1.15" fill="#fff" />
              <circle cx="9.3" cy="12.6" r="1.35" fill="#fff" />
              <circle cx="14.7" cy="12.6" r="1.35" fill="#fff" />
              <path d="M9.6 15.9h4.8" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="login-title">IRIS Support</div>
            <div className="login-sub">Admin portal</div>
          </div>
        </div>

        {error ? <div className="banner banner-err">{error}</div> : null}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await signIn(email, password);
            } catch {
              /* surfaced via `error` */
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email" className="input" type="email" required autoFocus autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password" className="input" type="password" required autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="btn" style={{ width: '100%' }} type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="demo-hint">
          <strong>Demo accounts</strong> — password <code>Abc@1234</code>
          <br />
          <code>admin@irisregtech.com</code> — all four tenants
          <br />
          <code>ops.manager@irisregtech.com</code> — Carbon + ESG
          <br />
          <code>carbon.agent@irisregtech.com</code> — Carbon only
        </div>

        <div className="login-foot">{BRAND_FOOTER}</div>
      </div>
    </div>
  );
}
