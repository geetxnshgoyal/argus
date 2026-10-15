import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { apiSend } from '../lib/api.ts';
import { ROLE_LABELS, useAuthMethods, useLogout, useMe, type Role } from '../lib/auth.ts';
import { HealthBadge } from './HealthBadge.tsx';
import { BrandMark } from './ui.tsx';

export function TopBar() {
  const me = useMe().data;
  const logout = useLogout();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <BrandMark />
        <span>Argus</span>
      </Link>
      <span className="spacer" />
      <HealthBadge />
      {me && (
        <span className="user-chip">
          <span>
            {me.user.name} · {ROLE_LABELS[me.user.role]}
          </span>
          <button className="btn btn-ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </span>
      )}
    </header>
  );
}

/** Renders children only for signed-in users with one of `roles`; otherwise sends them to sign in or home. */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const me = useMe();
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (me.isPending) return <div className="content muted">Loading…</div>;
  if (!me.data) {
    window.location.assign(`/login?next=${encodeURIComponent(path)}`);
    return null;
  }
  if (!roles.includes(me.data.user.role)) return <Navigate to={me.data.home} />;
  return <>{children}</>;
}

/** Demo admin: a fresh sample college now. Everyone is signed out, so back to the sign-in page. */
async function resetDemo() {
  if (!window.confirm('Replace all demo data with a fresh sample college? Everyone using the demo is signed out.')) return;
  await apiSend('POST', '/v1/demo/reset');
  window.location.assign('/login');
}

export function AppFrame() {
  const demo = useAuthMethods().data?.demo;
  const me = useMe();
  return (
    <>
      {demo && (
        <div className="demo-banner" role="note">
          Demo: a sample college with made-up people. It resets every night.
          {me.data?.user.role === 'admin' && (
            <>
              {' '}
              <button className="link-button" onClick={() => void resetDemo()}>
                Reset it now
              </button>
            </>
          )}
        </div>
      )}
      <TopBar />
      <Outlet />
    </>
  );
}

export function SideNavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} activeOptions={{ exact: true }} activeProps={{ className: 'active' }}>
      {children}
    </Link>
  );
}
