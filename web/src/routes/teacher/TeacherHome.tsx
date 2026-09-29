import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { NoticesCard } from '../../components/NoticesCard.tsx';
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
          Academic Operations is asking whether {questions.data!.items.length === 1 ? `${questions.data!.items[0]!.name} is` : `${questions.data!.items.length} students are`} in your class.{' '}
          <a href={`/teacher/session/${questions.data!.items[0]!.attendance_session_id}`}>Answer now</a>
        </Notice>
      )}
      <NoticesCard />
      <StudentIssues />
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
          <TopicEditor session={s} />
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

type Issue = Schemas['AttendanceIssue'];
const ISSUE_REASON: Record<Issue['reason'], string> = {
  marked_absent_but_present: 'Marked absent but was there',
  marked_late_but_on_time: 'Marked late but was on time',
  wrong_record: 'Wrong record',
  other: 'Other',
};

/** Students disputing a past class of yours (ADR-0027): confirm sends a correction to Acad Ops. */
function StudentIssues() {
  const list = useQuery({ queryKey: ['teacher', 'issues'], queryFn: () => apiGet<{ items: Issue[] }>('/v1/teacher/attendance-issues'), refetchInterval: 60_000 });
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="card">
      <h3>Students asking about their attendance</h3>
      <p className="muted small">Confirm if the student was in your class; Academic Operations then approves the fix.</p>
      <ul className="issue-list" style={{ marginTop: '0.75rem', display: 'grid', gap: '0.75rem' }}>
        {items.map((i) => (
          <IssueRow key={i.id} i={i} />
        ))}
      </ul>
    </div>
  );
}

function IssueRow({ i }: { i: Issue }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const answer = useMutation({
    mutationFn: (decision: 'confirm' | 'decline') => apiSend('POST', `/v1/teacher/attendance-issues/${i.id}/answer`, { decision, note: note.trim() || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['teacher', 'issues'] }),
  });
  return (
    <li style={{ display: 'block' }}>
      <strong>{i.student.name}</strong> <span className="muted">· {i.student.usn ?? ''}</span>
      <div className="small">
        {i.class.code} · {formatDate(i.class.date)} {i.class.start} · recorded {i.record_status ?? 'nothing'}
      </div>
      <div className="small">
        <strong>{ISSUE_REASON[i.reason]}:</strong> {i.note}
      </div>
      <div className="btn-row" style={{ marginTop: '0.4rem' }}>
        <input aria-label={`Note for ${i.student.name}`} placeholder="Note (required to decline)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: '10rem' }} />
        <button className="btn btn-primary" disabled={answer.isPending} onClick={() => answer.mutate('confirm')}>Yes, was in class</button>
        <button className="btn btn-danger" disabled={answer.isPending || note.trim().length < 3} onClick={() => answer.mutate('decline')}>Decline</button>
      </div>
      <ErrorNotice error={answer.error} />
    </li>
  );
}

/** What this class covers today; students see it on their Home and Timetable. */
function TopicEditor({ session: s }: { session: Session }) {
  const qc = useQueryClient();
  const [topic, setTopic] = useState(s.topic ?? '');
  const save = useMutation({
    mutationFn: () => apiSend('PUT', `/v1/teacher/class-sessions/${s.id}/topic`, { topic: topic.trim() || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['teacher'] }),
  });
  const changed = topic.trim() !== (s.topic ?? '');
  const id = `topic-${s.id}`;
  return (
    <form
      className="btn-row"
      style={{ margin: '0.25rem 0 1rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) save.mutate();
      }}
    >
      <label htmlFor={id} className="muted small" style={{ width: '100%' }}>
        Today's topic (students see it)
      </label>
      <input id={id} value={topic} maxLength={200} placeholder="e.g. Dijkstra's algorithm" onChange={(e) => setTopic(e.target.value)} style={{ flex: 1, minWidth: '12rem' }} />
      {changed && (
        <button className="btn" type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save topic'}
        </button>
      )}
      {save.isSuccess && !changed && <span className="muted small">Saved</span>}
      <ErrorNotice error={save.error} />
    </form>
  );
}
