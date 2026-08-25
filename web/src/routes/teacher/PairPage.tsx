import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ErrorNotice, Field, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, type Schemas } from '../../lib/api.ts';

/**
 * Opened by scanning the pairing QR on a classroom screen with the teacher's
 * phone camera (/teacher/pair?code=ABC123). Links that screen to the teacher's
 * running attendance (ADR-0004).
 */
export function PairPage({ code: initial }: { code: string }) {
  const [code, setCode] = useState(initial.toUpperCase());
  const sessions = useQuery({
    queryKey: ['teacher', 'attendance'],
    queryFn: () => apiGet<{ date: string; items: Schemas['AttendanceSessionSummary'][] }>('/v1/teacher/attendance/sessions'),
  });
  const today = useQuery({ queryKey: ['teacher', 'today'], queryFn: () => apiGet<Schemas['TeacherToday']>('/v1/teacher/sessions/today') });
  const active = (sessions.data?.items ?? []).filter((s) => s.status === 'active');
  const [chosen, setChosen] = useState<string | null>(null);
  const target = chosen ?? (active.length === 1 ? active[0]!.id : null);
  const link = useMutation({ mutationFn: () => apiSend('POST', `/v1/attendance/sessions/${target}/display`, { code }) });
  const label = (classId: string) => {
    const c = today.data?.items.find((i) => i.id === classId);
    return c ? `${c.subject.name} · ${c.start}–${c.end} · ${c.room ?? 'No room'}` : 'Class';
  };

  return (
    <div className="content" style={{ maxWidth: '36rem' }}>
      <PageHead title="Connect classroom screen" subtitle="Show your class's attendance QR on this screen." />
      {sessions.isSuccess && active.length === 0 && (
        <Notice tone="warn">
          Start attendance for your class first, then scan the screen again. <Link to="/teacher">Go to today's classes</Link>
        </Notice>
      )}
      {link.isSuccess ? (
        <div className="card">
          <div className="card-row">
            <IconTile name="check" />
            <div>
              <h2>Screen connected</h2>
              <p className="muted">The classroom screen now shows the QR code for {target ? label(active.find((a) => a.id === target)?.class_session_id ?? '') : 'your class'}.</p>
              {target && (
                <a className="btn btn-primary" href={`/teacher/session/${target}`} style={{ marginTop: '0.75rem' }}>
                  Open live attendance
                </a>
              )}
            </div>
          </div>
        </div>
      ) : (
        active.length > 0 && (
          <form
            className="card form"
            onSubmit={(e) => {
              e.preventDefault();
              link.mutate();
            }}
          >
            {active.length > 1 && (
              <Field label="Class">
                <select value={target ?? ''} onChange={(e) => setChosen(e.target.value)}>
                  <option value="">Choose…</option>
                  {active.map((a) => (
                    <option key={a.id} value={a.id}>
                      {label(a.class_session_id)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {active.length === 1 && <p>{label(active[0]!.class_session_id)}</p>}
            <Field label="Code on the screen">
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '0.15em', fontSize: '1.3rem' }} />
            </Field>
            <ErrorNotice error={link.error} />
            <button className="btn btn-primary btn-lg" disabled={!target || code.replace(/\s/g, '').length < 6 || link.isPending}>
              Connect screen
            </button>
          </form>
        )
      )}
    </div>
  );
}
