import { useQuery } from '@tanstack/react-query';
import { api, type AuthMode } from '../api';
import { toast } from '../ui';

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z" />
      <path fill="#34A853" d="M9 18a8.6 8.6 0 0 0 5.96-2.18l-2.92-2.26a5.4 5.4 0 0 1-8.09-2.85H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.96l2.99 2.33A5.36 5.36 0 0 1 9 3.58z" />
    </svg>
  );
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const modeQ = useQuery<AuthMode>({ queryKey: ['authMode'], queryFn: () => api('/auth/mode') });
  const m = modeQ.data;

  const devLogin = async (email: string) => {
    try {
      await api('/auth/dev', { method: 'POST', body: { email } });
      onSignedIn();
    } catch (e) { toast(String((e as Error).message)); }
  };

  return (
    <div className="authbody">
      <div>
        <div className="wordmark">FORGE<i>.</i></div>
        <div className="tagline">Coached by an agent.<br />Evidence from your own body.</div>
      </div>
      {m?.google && (
        <a className="gbtn press" href="/auth/login" style={{ textDecoration: 'none' }}>
          <GoogleLogo /> Continue with Google
        </a>
      )}
      {m?.dev && (m.users || []).map((u) => (
        <button key={u.email} className="acct press" onClick={() => devLogin(u.email)}>
          <span className="avatar">{u.name[0]}</span>
          <span><b>{u.name}</b><div className="em">{u.email}</div></span>
        </button>
      ))}
      {m?.demo && (
        <button className="acct press" onClick={async () => {
          try { await api('/auth/demo', { method: 'POST' }); onSignedIn(); }
          catch (e) { toast(String((e as Error).message)); }
        }}>
          <span className="avatar neutral">B</span>
          <span><b>Try the demo</b><div className="em">Bruce Willis · a year of training, live coach</div></span>
        </button>
      )}
      <div className="fine">
        Private instance — allowlisted accounts only
        {m?.dev && <><br />Dev sign-in is enabled (no Google configured)</>}
      </div>
    </div>
  );
}

export function DeniedScreen({ email }: { email: string }) {
  return (
    <div className="authbody">
      <div>
        <div className="kick">Signed in as {email}</div>
        <h2 className="title" style={{ marginTop: 6 }}>Not on the list</h2>
      </div>
      <div className="card" style={{ textAlign: 'left' }}>
        <p style={{ fontSize: 14, lineHeight: 1.5 }}>
          This Forge is private — your Google account verified fine, it just isn't allowed here.
          Ask the admin to add you to ALLOWED_USERS.
        </p>
      </div>
      <button className="ghost press" onClick={() => { history.replaceState({}, '', '/'); location.reload(); }}>
        Back
      </button>
    </div>
  );
}
