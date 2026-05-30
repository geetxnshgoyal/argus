import { Link } from '@tanstack/react-router';
import { useHealth } from '../components/HealthBadge.tsx';

export function HomePage() {
  const { data } = useHealth();
  return (
    <section>
      <h1>Argus</h1>
      <p className="lead">College attendance that resists proxies.</p>
      <ul className="cards">
        <li>
          <Link to="/teacher">Teacher</Link>
          <span>Run attendance for your classes</span>
        </li>
        <li>
          <Link to="/admin">Academic Operations</Link>
          <span>Timetable, mappings, approvals</span>
        </li>
        <li>
          <Link to="/verify">Verifier</Link>
          <span>Review support requests</span>
        </li>
      </ul>
      {data && <p className="muted">Server version {data.version}</p>}
    </section>
  );
}
