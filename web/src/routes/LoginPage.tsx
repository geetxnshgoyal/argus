import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BrandMark, IconTile, Notice } from '../components/ui.tsx';
import { apiGet, apiSend } from '../lib/api.ts';
import { loginUrl, ROLE_LABELS, type Role } from '../lib/auth.ts';

const ERRORS: Record<string, string> = {
  wrong_domain: 'Please sign in with your college Google account.',
  not_provisioned: 'Your account is not set up in Argus yet. Please contact Academic Operations.',
  account_disabled: 'Your Argus account is disabled. Please contact Academic Operations.',
  login_expired: 'The sign-in took too long. Please try again.',
  login_cancelled: 'Sign-in was cancelled.',
  reauth_failed: 'Please sign in again to confirm it is you.',
};

export function LoginPage() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const next = params.get('next') ?? undefined;
  const [devError, setDevError] = useState<string | null>(null);
  // The dev picker appears only when the server has dev login enabled (never in production).
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => apiGet<{ users: { email: string; name: string; role: Role }[] }>('/v1/auth/dev/users'),
    retry: false,
  });

  async function devLogin(email: string) {
    setDevError(null);
    try {
      const r = await apiSend<{ home: string }>('POST', '/v1/auth/dev/login', { email });
      window.location.assign(next ?? r.home);
    } catch (e) {
      setDevError(e instanceof Error ? e.message : 'Sign-in failed');
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">
          <BrandMark />
          <span>Argus</span>
        </div>
        <div className="card">
          <div className="card-row">
            <IconTile name="shield" />
            <div style={{ flex: 1 }}>
              <h2>Sign in</h2>
              <p className="muted">Teachers, Academic Operations and verifiers sign in with their college Google account.</p>
              {error && <Notice tone="bad">{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</Notice>}
              <a className="btn btn-primary btn-lg" style={{ width: '100%' }} href={loginUrl(next)}>
                Sign in with college account
              </a>
              <p className="muted small" style={{ marginTop: '1rem' }}>
                Students: mark attendance in the Argus app on your phone.
              </p>
            </div>
          </div>
          {devUsers.data && (
            <div className="card-row">
              <IconTile name="alert" tone="warn" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3>Developer sign-in</h3>
                <p className="muted small">Shown only when the server runs in development mode.</p>
                {devError && <Notice tone="bad">{devError}</Notice>}
                <div className="dev-users">
                  {devUsers.data.users.filter((u) => u.role !== 'student').map((u) => (
                    <button key={u.email} onClick={() => void devLogin(u.email)}>
                      <span>{u.name}</span>
                      <span className="muted small">{ROLE_LABELS[u.role]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
