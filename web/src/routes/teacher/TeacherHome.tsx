import { useQuery } from '@tanstack/react-query';
import { ErrorNotice, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, type Schemas } from '../../lib/api.ts';
import { formatDate } from '../../lib/refs.ts';

type Session = Schemas['ClassSession'];

function nowHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TeacherHome() {
  const today = useQuery({ queryKey: ['teacher', 'today'], queryFn: () => apiGet<Schemas['TeacherToday']>('/v1/teacher/sessions/today'), refetchInterval: 60_000 });
  const week = useQuery({ queryKey: ['teacher', 'week'], queryFn: () => apiGet<Schemas['ClassSessionRange']>('/v1/teacher/timetable') });
  const items = today.data?.items ?? [];
  const now = nowHm();
  const current = items.find((s) => s.status !== 'cancelled' && s.start <= now && now < s.end);
  const next = items.find((s) => s.status !== 'cancelled' && s.start > now);
  const upcoming = (week.data?.items ?? []).filter((s) => s.date !== today.data?.date);

  return (
    <div className="content">
      <PageHead title="Today's classes" subtitle={today.data ? formatDate(today.data.date) : undefined} />
      <ErrorNotice error={today.error ?? week.error} />
      {today.isSuccess && items.length === 0 && <Notice>No classes today.</Notice>}
      {(current ?? next) && <CurrentClass session={(current ?? next) as Session} live={Boolean(current)} />}
      {items.length > 0 && (
        <div className="card">
          <h3>All of today</h3>
          <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
            {items.map((s) => (
              <li key={s.id}>
                <strong style={{ minWidth: '7.5rem' }}>{s.start}–{s.end}</strong>
                <span style={{ flex: 1 }}>
                  {s.subject.code} · {s.subject.name}
                  <span className="muted"> · {s.section.name}{s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'}</span>
                </span>
                {s.status === 'cancelled' ? <span className="badge badge-bad">Cancelled</span> : <span className="badge">{s.expected} students</span>}
                {s.changed && s.status !== 'cancelled' && <span className="badge badge-warn">Changed</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="card">
          <h3>Coming up this week</h3>
          <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
            {upcoming.map((s) => (
              <li key={s.id}>
                <strong style={{ minWidth: '10rem' }}>{formatDate(s.date)} {s.start}</strong>
                <span style={{ flex: 1 }}>{s.subject.code}<span className="muted"> · {s.section.name}{s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'}</span></span>
                {s.status === 'cancelled' && <span className="badge badge-bad">Cancelled</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CurrentClass({ session: s, live }: { session: Session; live: boolean }) {
  return (
    <div className="card">
      <div className="card-row">
        <IconTile name="clock" />
        <div style={{ flex: 1 }}>
          <span className={`badge ${live ? 'badge-good' : ''}`}>{live ? 'Now' : 'Next'}</span>
          <h2 style={{ marginTop: '0.5rem' }}>{s.subject.name}</h2>
          <p className="muted">
            {s.start}–{s.end} · {s.section.name}{s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'} · {s.expected} students expected
          </p>
          <button className="btn btn-primary btn-lg" disabled title="Arrives with the attendance milestone">
            Start attendance
          </button>
        </div>
      </div>
    </div>
  );
}
