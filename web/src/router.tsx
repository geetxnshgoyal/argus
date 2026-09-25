import { createRootRoute, createRoute, createRouter, Navigate, Outlet } from '@tanstack/react-router';
import { AppFrame, RequireRole, SideNavLink } from './components/Layout.tsx';
import { ResourcePage } from './components/ResourcePage.tsx';
import { IconTile, PageHead } from './components/ui.tsx';
import { useMe } from './lib/auth.ts';
import { LoginPage } from './routes/LoginPage.tsx';
import { AuditPage } from './routes/admin/AuditPage.tsx';
import { AttendanceBrowserPage, AttendanceDetailPage } from './routes/admin/AttendanceBrowserPage.tsx';
import { PhonesPage } from './routes/admin/PhonesPage.tsx';
import { RESOURCE_CONFIGS } from './routes/admin/configs.ts';
import { StudentImportPage } from './routes/admin/StudentImportPage.tsx';
import { UsersPage } from './routes/admin/UsersPage.tsx';
import { CalendarPage } from './routes/admin/CalendarPage.tsx';
import { ConflictsPage } from './routes/admin/ConflictsPage.tsx';
import { TimetableImportPage } from './routes/admin/TimetableImportPage.tsx';
import { TimetablePage } from './routes/admin/TimetablePage.tsx';
import { AttendancePage } from './routes/teacher/AttendancePage.tsx';
import { PairPage } from './routes/teacher/PairPage.tsx';
import { TeacherHome } from './routes/teacher/TeacherHome.tsx';
import { VerifierPage } from './routes/verify/VerifierPage.tsx';

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => (
    <div className="content">
      <h1>Page not found</h1>
      <a href="/">Go to the home page</a>
    </div>
  ),
});

const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });

const frameRoute = createRoute({ getParentRoute: () => rootRoute, id: 'frame', component: AppFrame });

function Home() {
  const me = useMe();
  if (me.isPending) return <div className="content muted">Loading…</div>;
  return <Navigate to={me.data ? me.data.home : '/login'} />;
}
const indexRoute = createRoute({ getParentRoute: () => frameRoute, path: '/', component: Home });

const studentRoute = createRoute({
  getParentRoute: () => frameRoute,
  path: '/student',
  component: () => (
    <div className="content">
      <div className="card">
        <div className="card-row">
          <IconTile name="phone" />
          <div>
            <h2>Use the Argus app</h2>
            <p className="muted">Students mark attendance with the Argus app on their registered phone. Sign in there with your college account.</p>
          </div>
        </div>
      </div>
    </div>
  ),
});

const teacherRoute = createRoute({
  getParentRoute: () => frameRoute,
  path: '/teacher',
  component: () => (
    <RequireRole roles={['teacher']}>
      <TeacherHome />
    </RequireRole>
  ),
});

const teacherSessionRoute = createRoute({
  getParentRoute: () => frameRoute,
  path: '/teacher/session/$sessionId',
  component: function TeacherSession() {
    const { sessionId } = teacherSessionRoute.useParams();
    return (
      <RequireRole roles={['teacher']}>
        <AttendancePage key={sessionId} sessionId={sessionId} />
      </RequireRole>
    );
  },
});

const teacherPairRoute = createRoute({
  getParentRoute: () => frameRoute,
  path: '/teacher/pair',
  validateSearch: (s: Record<string, unknown>) => ({ code: typeof s.code === 'string' ? s.code.slice(0, 12) : '' }),
  component: function TeacherPair() {
    const { code } = teacherPairRoute.useSearch();
    return (
      <RequireRole roles={['teacher']}>
        <PairPage code={code} />
      </RequireRole>
    );
  },
});


const verifyRoute = createRoute({
  getParentRoute: () => frameRoute,
  path: '/verify',
  component: () => (
    <RequireRole roles={['verifier']}>
      <VerifierPage />
    </RequireRole>
  ),
});

// ── Acad Ops / admin ─────────────────────────────────────────────────────────
function AdminShell() {
  return (
    <RequireRole roles={['acadops', 'admin']}>
      <div className="shell">
        <nav className="sidenav" aria-label="Admin">
          <SideNavLink to="/admin">Overview</SideNavLink>
          <div className="section-label">People</div>
          <SideNavLink to="/admin/students">Students</SideNavLink>
          <SideNavLink to="/admin/students/import">Import students</SideNavLink>
          <SideNavLink to="/admin/teachers">Teachers</SideNavLink>
          <SideNavLink to="/admin/staff">Staff</SideNavLink>
          <div className="section-label">Timetable</div>
          <SideNavLink to="/admin/timetable">Timetable</SideNavLink>
          <SideNavLink to="/admin/timetable/import">Import timetable</SideNavLink>
          <SideNavLink to="/admin/teaching-assignments">Teaching assignments</SideNavLink>
          <SideNavLink to="/admin/calendar">Holidays</SideNavLink>
          <SideNavLink to="/admin/conflicts">Timetable check</SideNavLink>
          <div className="section-label">Academic</div>
          <SideNavLink to="/admin/terms">Terms</SideNavLink>
          <SideNavLink to="/admin/sections">Sections</SideNavLink>
          <SideNavLink to="/admin/groups">Lab batches</SideNavLink>
          <SideNavLink to="/admin/subjects">Subjects</SideNavLink>
          <SideNavLink to="/admin/programs">Programs</SideNavLink>
          <SideNavLink to="/admin/departments">Departments</SideNavLink>
          <div className="section-label">Campus</div>
          <SideNavLink to="/admin/rooms">Rooms</SideNavLink>
          <SideNavLink to="/admin/geofences">Campus areas</SideNavLink>
          <SideNavLink to="/admin/campus-networks">Campus networks</SideNavLink>
          <div className="section-label">Attendance</div>
          <SideNavLink to="/admin/attendance">Attendance</SideNavLink>
          <SideNavLink to="/admin/phones">Phones</SideNavLink>
          <div className="section-label">Records</div>
          <SideNavLink to="/admin/audit">Audit log</SideNavLink>
        </nav>
        <main>
          <Outlet />
        </main>
      </div>
    </RequireRole>
  );
}
const adminRoute = createRoute({ getParentRoute: () => frameRoute, path: '/admin', component: AdminShell });

const OVERVIEW = [
  { to: '/admin/students/import', icon: 'upload', title: 'Import students', text: 'Add or update the student list from a file.' },
  { to: '/admin/students', icon: 'users', title: 'Students', text: 'Search students, fix details, move batches.' },
  { to: '/admin/teachers', icon: 'book', title: 'Teachers', text: 'Add teachers and their departments.' },
  { to: '/admin/rooms', icon: 'building', title: 'Rooms', text: 'Classrooms and labs used in the timetable.' },
  { to: '/admin/geofences', icon: 'map', title: 'Campus areas', text: 'Where scans count as on campus.' },
  { to: '/admin/audit', icon: 'shield', title: 'Audit log', text: 'Every change, who made it, and an integrity check.' },
];
const adminIndex = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: () => (
    <>
      <PageHead title="Academic Operations" subtitle="Set up students, teachers, rooms and the timetable." />
      <ul className="grid-cards">
        {OVERVIEW.map((c) => (
          <li key={c.to}>
            <a href={c.to}>
              <IconTile name={c.icon} />
              <span>
                <strong>{c.title}</strong>
                <br />
                <span className="muted small">{c.text}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  ),
});

const attendanceDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/attendance/$sessionId',
  component: function AdminAttendanceDetail() {
    const { sessionId } = attendanceDetailRoute.useParams();
    return <AttendanceDetailPage key={sessionId} sessionId={sessionId} />;
  },
});

const adminChildren = [
  attendanceDetailRoute,
  adminIndex,
  createRoute({ getParentRoute: () => adminRoute, path: '/students', component: () => <UsersPage kind="students" /> }),
  createRoute({ getParentRoute: () => adminRoute, path: '/students/import', component: StudentImportPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/teachers', component: () => <UsersPage kind="teachers" /> }),
  createRoute({ getParentRoute: () => adminRoute, path: '/staff', component: () => <UsersPage kind="staff" /> }),
  createRoute({ getParentRoute: () => adminRoute, path: '/audit', component: AuditPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/attendance', component: AttendanceBrowserPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/phones', component: PhonesPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/timetable', component: TimetablePage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/timetable/import', component: TimetableImportPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/calendar', component: CalendarPage }),
  createRoute({ getParentRoute: () => adminRoute, path: '/conflicts', component: ConflictsPage }),
  ...Object.entries(RESOURCE_CONFIGS).map(([path, config]) =>
    createRoute({ getParentRoute: () => adminRoute, path: `/${path}`, component: () => <ResourcePage key={path} config={config} /> }),
  ),
];

const routeTree = rootRoute.addChildren([
  loginRoute,
  frameRoute.addChildren([indexRoute, studentRoute, teacherRoute, teacherSessionRoute, teacherPairRoute, verifyRoute, adminRoute.addChildren(adminChildren)]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
