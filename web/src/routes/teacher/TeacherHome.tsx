import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ErrorNotice, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, type Schemas } from '../../lib/api.ts';
import { formatDate } from '../../lib/refs.ts';
import { useNow } from '../../lib/useNow.ts';

type Session = Schemas['ClassSession'];
type AttendanceSummary = Schemas['AttendanceSessionSummary'];

const EARLY_START_MS = 10 * 60_000;

export function TeacherHome() {
  const today = useQuery({ queryKey: ['teacher', 'today'], queryFn: () => apiGet<Schemas['TeacherToday']>('/v1/teacher/sessions/today'), refetchInterval: 60_000 });
  const week = useQuery({ queryKey: ['teacher', 'week'], queryFn: () => apiGet<Schemas['ClassSessionRange']>('/v1/teacher/timetable') });
  const attendance = useQuery({
    queryKey: ['teacher', 'attendance'],
    queryFn: () => apiGet<{ date: string; items: AttendanceSummary[] }>('/v1/teacher/attendance/sessions'),
    refetchInterval: 60_000,
  });
  const questions = useQuery({
    queryKey: ['teacher', 'questions', 'all'],
    queryFn: () => apiGet<{ items: Schemas['TeacherQuestion'][] }>('/v1/teacher/support-requests'),
    refetchInterval: 15_000,
  });
  const items = today.data?.items ?? [];
  const now = useNow();
  const byClass = new Map((attendance.data?.items ?? []).map((a) => [a.class_session_id, a]));
  // The class to act on: one with attendance running, else the one on now (or starting within 10 min), else the next.
  const running = items.find((s) => byClass.get(s.id)?.status === 'active');
  const current = items.find((s) => s.status !== 'cancelled' && Date.parse(s.starts_at) - EARLY_START_MS <= now && now < Date.parse(s.ends_at));
  const next = items.find((s) => s.status !== 'cancelled' && Date.parse(s.starts_at) > now);
  const focus = running ?? current ?? next;
  const upcoming = (week.data?.items ?? []).filter((s) => s.date !== today.data?.date);

  return (
    <div className="content">
      <PageHead title="Today's classes" subtitle={today.data ? formatDate(today.data.date) : undefined} />
      <ErrorNotice error={today.error ?? week.error} />
      {(questions.data?.items ?? []).length > 0 && (
        <Notice tone="warn">
          A verifier is asking whether {questions.data!.items.length === 1 ? `${questions.data!.items[0]!.name} is` : `${questions.data!.items.length} students are`} in your class.{' '}
          <a href={`/teacher/session/${questions.data!.items[0]!.attendance_session_id}`}>Answer now</a>
        </Notice>
      )}
      {today.isSuccess && items.length === 0 && <Notice>No classes today.</Notice>}
      {focus && <CurrentClass session={focus} attendance={byClass.get(focus.id)} canStart={focus === current || focus === running} now={now} />}
      {items.length > 0 && (
        <div className="card">
          <h3>All of today</h3>
          <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
            {items.map((s) => {
              const a = byClass.get(s.id);
              return (
                <li key={s.id}>
                  <strong style={{ minWidth: '7.5rem' }}>
                    {s.start}–{s.end}
                  </strong>
                  <span style={{ flex: 1 }}>
                    {s.subject.code} · {s.subject.name}
                    <span className="muted">
                      {' '}
                      · {s.section.name}
                      {s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'}
                    </span>
                  </span>
                  {s.status === 'cancelled' ? (
                    <span className="badge badge-bad">Cancelled</span>
                  ) : a ? (
                    <a className={`badge ${a.status === 'active' ? 'badge-good' : ''}`} href={`/teacher/session/${a.id}`}>
                      {a.status === 'active' ? 'Attendance running' : 'Attendance taken'}
                    </a>
                  ) : (
                    <span className="badge">{s.expected} students</span>
                  )}
                  {s.changed && s.status !== 'cancelled' && <span className="badge badge-warn">Changed</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="card">
          <h3>Coming up this week</h3>
          <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
            {upcoming.map((s) => (
              <li key={s.id}>
                <strong style={{ minWidth: '10rem' }}>
                  {formatDate(s.date)} {s.start}
                </strong>
                <span style={{ flex: 1 }}>
                  {s.subject.code}
                  <span className="muted">
                    {' '}
                    · {s.section.name}
                    {s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'}
                  </span>
                </span>
                {s.status === 'cancelled' && <span className="badge badge-bad">Cancelled</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CurrentClass({ session: s, attendance, canStart, now }: { session: Session; attendance: AttendanceSummary | undefined; canStart: boolean; now: number }) {
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => apiSend<Schemas['AttendanceStarted']>('POST', `/v1/teacher/class-sessions/${s.id}/attendance/start`),
    onSuccess: (r) => void navigate({ to: '/teacher/session/$sessionId', params: { sessionId: r.attendance_session_id } }),
  });
  const live = Date.parse(s.starts_at) <= now && now < Date.parse(s.ends_at);
  return (
    <div className="card">
      <div className="card-row">
        <IconTile name="clock" />
        <div style={{ flex: 1 }}>
          <span className={`badge ${live ? 'badge-good' : ''}`}>{live ? 'Now' : canStart ? 'Starting soon' : 'Next'}</span>
          <h2 style={{ marginTop: '0.5rem' }}>{s.subject.name}</h2>
          <p className="muted">
            {s.start}–{s.end} · {s.section.name}
            {s.batch ? `, ${s.batch}` : ''} · {s.room ?? 'No room'} · {s.expected} students expected
          </p>
          <ErrorNotice error={start.error} />
          {attendance ? (
            <a className="btn btn-primary btn-lg" href={`/teacher/session/${attendance.id}`}>
              {attendance.status === 'active' ? 'Open live attendance' : 'View attendance'}
            </a>
          ) : (
            <button className="btn btn-primary btn-lg" disabled={!canStart || start.isPending} onClick={() => start.mutate()} title={canStart ? undefined : 'You can start from 10 minutes before the class'}>
              {start.isPending ? 'Starting…' : 'Start attendance'}
            </button>
          )}
          {!attendance && !canStart && <p className="muted small" style={{ marginTop: '0.5rem' }}>You can start attendance from 10 minutes before the class.</p>}
        </div>
      </div>
    </div>
  );
}
