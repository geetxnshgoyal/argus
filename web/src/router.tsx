import { createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router';
import { HealthBadge } from './components/HealthBadge.tsx';
import { HomePage } from './routes/HomePage.tsx';
import { ShellPage } from './routes/ShellPage.tsx';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          Argus
        </Link>
        <nav aria-label="Main">
          <Link to="/teacher">Teacher</Link>
          <Link to="/admin">Acad Ops</Link>
          <Link to="/verify">Verifier</Link>
        </nav>
        <HealthBadge />
      </header>
      <main className="content">
        <Outlet />
      </main>
    </>
  ),
  notFoundComponent: () => (
    <section>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </section>
  ),
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });

const teacherRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/teacher',
  component: () => (
    <ShellPage
      title="Teacher"
      summary="Today's classes, starting attendance, live results, rechecks, spot checks and support confirmations."
      milestone="M4–M6"
    />
  ),
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: () => (
    <ShellPage
      title="Academic Operations"
      summary="Timetable and overrides, rooms, subjects, sections, mappings, device rebinds, corrections and audit."
      milestone="M1–M2"
    />
  ),
});

const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify',
  component: () => (
    <ShellPage
      title="Verifier"
      summary="Support-request queue with evidence; low-evidence requests go to the teacher."
      milestone="M6"
    />
  ),
});

const routeTree = rootRoute.addChildren([indexRoute, teacherRoute, adminRoute, verifyRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
