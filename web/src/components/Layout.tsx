import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ROLE_LABELS, useLogout, useMe, type Role } from '../lib/auth.ts';
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

export function AppFrame() {
  return (
    <>
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
