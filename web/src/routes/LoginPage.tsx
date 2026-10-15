import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BrandMark, IconTile, Notice } from '../components/ui.tsx';
import { apiGet, apiSend } from '../lib/api.ts';
import { loginUrl, ROLE_LABELS, useAuthMethods, type Role } from '../lib/auth.ts';

const DEMO_ROLES: { role: Exclude<Role, 'student'>; text: string }[] = [
  { role: 'teacher', text: 'Take attendance in a class, see flagged scans' },
  { role: 'acadops', text: 'Timetable, students, phones, OD and corrections' },
  { role: 'admin', text: 'Everything, plus anti-proxy settings and audit log' },
  { role: 'community_manager', text: 'First check of on-duty (OD) requests' },
];

const ERRORS: Record<string, string> = {
  wrong_domain: 'Please sign in with your college Google account.',
  sso_not_configured: 'College Google sign-in is not set up on this server yet. Academic Operations: see deploy/README.md.',
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
  const methods = useAuthMethods();
  const ssoOff = methods.data?.sso === false;
  // The dev picker appears only when the server has dev login enabled (never in production).
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => apiGet<{ users: { email: string; name: string; role: Role }[] }>('/v1/auth/dev/users'),
    retry: false,
  });

  async function demoLogin(role: Exclude<Role, 'student'>) {
    setDevError(null);
    try {
      const r = await apiSend<{ home: string }>('POST', '/v1/auth/demo/login', { role });
      window.location.assign(r.home);
    } catch (e) {
      setDevError(e instanceof Error ? e.message : 'Sign-in failed');
    }
  }

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
          {methods.data?.demo && (
            <div className="card-row">
              <IconTile name="shield" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2>Try the demo</h2>
                <p className="muted">
                  A sample college with two weeks of attendance, flagged scans and OD requests. Pick a role to look around; nothing you do affects a real college, and the
                  sample data resets every night.
                </p>
                {devError && <Notice tone="bad">{devError}</Notice>}
                <div className="dev-users">
                  {DEMO_ROLES.map((r) => (
                    <button key={r.role} onClick={() => void demoLogin(r.role)}>
                      <span>{ROLE_LABELS[r.role]}</span>
                      <span className="muted small">{r.text}</span>
                    </button>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: '0.75rem' }}>
                  Students use the Argus phone app, which isn't part of this web demo.
                </p>
              </div>
            </div>
          )}
          {methods.isPending && <p className="muted">Loading…</p>}
          {!methods.isPending && !methods.data?.demo && (
          <div className="card-row">
            <IconTile name="shield" />
            <div style={{ flex: 1 }}>
              <h2>Sign in</h2>
              <p className="muted">Teachers, Academic Operations and community managers sign in with their college Google account.</p>
              {error && (
                <Notice tone="bad">
                  {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
                  {error === 'wrong_domain' && methods.data && methods.data.domains.length > 0 && ` Use an ${methods.data.domains.map((d) => `@${d}`).join(' or ')} address.`}
                </Notice>
              )}
              {ssoOff && !error && <Notice tone="warn">{ERRORS.sso_not_configured}</Notice>}
              {ssoOff ? (
                <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled>
                  Sign in with college account
                </button>
              ) : (
                <a className="btn btn-primary btn-lg" style={{ width: '100%' }} href={loginUrl(next)}>
                  Sign in with college account
                </a>
              )}
              <p className="muted small" style={{ marginTop: '1rem' }}>
                Students: mark attendance in the Argus app on your phone.
              </p>
            </div>
          </div>
          )}
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
        <p className="muted small" style={{ textAlign: 'center', marginTop: '1rem' }}>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms of use</a>
        </p>
      </div>
    </div>
  );
}
