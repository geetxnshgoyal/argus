import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Dialog, ErrorNotice, Field, IconTile, Notice } from '../../components/ui.tsx';
import { apiGet, apiSend, type Schemas } from '../../lib/api.ts';

type Live = Schemas['AttendanceLive'];
type Student = Schemas['LiveStudent'];

const REJECTION_TEXT: Record<string, string> = {
  off_campus: 'looked off campus',
  epoch_expired: 'scanned an expired code',
  bad_tag: 'scanned an invalid code',
  round_closed: 'scanned after the round closed',
  attestation_failed: 'failed the app check',
  not_targeted: 'was not in the recheck',
};

const STATE_LABEL: Record<Student['state'], string> = {
  verified: 'Present',
  flagged: 'Flagged',
  flagged_high: 'Check',
  pending: 'Offline scan',
  confirmed: 'Confirmed',
  unmarked: 'Not marked',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

function useLiveEvents(sessionId: string, onChange: () => void) {
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`/v1/attendance/sessions/${sessionId}/events`);
    es.addEventListener('changed', onChange);
    es.addEventListener('ended', onChange);
    return () => es.close();
  }, [sessionId, onChange]);
}

export function AttendancePage({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const key = ['attendance', sessionId, 'live'];
  const live = useQuery({ queryKey: key, queryFn: () => apiGet<Live>(`/v1/attendance/sessions/${sessionId}/live`), refetchInterval: 15_000 });
  const [refresh] = useState(() => () => void qc.invalidateQueries({ queryKey: key }));
  useLiveEvents(sessionId, refresh);
  const setLive = (v: Live) => qc.setQueryData(key, v);

  const round = useMutation({
    mutationFn: (mode: 'targeted' | 'full') => apiSend('POST', `/v1/attendance/sessions/${sessionId}/rounds`, { mode }),
    onSuccess: refresh,
  });
  const spot = useMutation({ mutationFn: () => apiSend<Live>('POST', `/v1/attendance/sessions/${sessionId}/spot-checks/suggest`), onSuccess: setLive });
  const [confirmEnd, setConfirmEnd] = useState(false);
  const end = useMutation({
    mutationFn: () => apiSend('POST', `/v1/attendance/sessions/${sessionId}/end`),
    onSuccess: () => {
      setConfirmEnd(false);
      refresh();
      void qc.invalidateQueries({ queryKey: ['teacher'] });
    },
  });

  if (live.isPending) return <div className="content muted">Loading…</div>;
  if (live.error || !live.data) {
    return (
      <div className="content">
        <ErrorNotice error={live.error} />
        <Link to="/teacher">Back to today's classes</Link>
      </div>
    );
  }
  const v = live.data;
  const cls = v.session.class;
  const active = v.session.status === 'active';
  const attention = v.students.filter((s) => s.state === 'flagged_high' || s.state === 'flagged' || s.state === 'pending');
  const unmarked = v.students.filter((s) => s.state === 'unmarked');
  const present = v.students.filter((s) => ['verified', 'confirmed', 'late'].includes(s.state));
  const openSpots = v.spot_checks.filter((sp) => !sp.result);
  const roundLabel = v.round ? (v.round.no === 1 ? 'Round 1 · everyone scans' : v.round.mode === 'targeted' ? `Recheck ${v.round.no} · ${v.round.targets ?? 0} students` : `Recheck ${v.round.no} · everyone`) : '';

  return (
    <div className="content attendance">
      <div className="page-head">
        <div>
          <Link to="/teacher" className="muted small">
            ← Today's classes
          </Link>
          <h1 style={{ marginTop: '0.35rem' }}>{cls.subject.name}</h1>
          <p className="muted">
            {cls.start}–{cls.end} · {cls.section.name}
            {cls.batch ? `, ${cls.batch}` : ''} · {cls.room ?? 'No room'}
          </p>
        </div>
        <div className="btn-row">
          <span className={`badge ${active ? 'badge-good' : ''}`}>{active ? 'Attendance running' : 'Attendance ended'}</span>
          {active && v.round && <span className="badge">{roundLabel}</span>}
        </div>
      </div>

      <div className="stat-row">
        <div className="stat stat-main">
          <span className="stat-value">
            {v.counts.present}
            <span className="stat-of">/{v.counts.expected}</span>
          </span>
          <span className="stat-label">present</span>
        </div>
        <div className="stat">
          <span className={`stat-value ${v.counts.flagged_high + v.counts.flagged > 0 ? 'warn-text' : ''}`}>{v.counts.flagged_high + v.counts.flagged + v.counts.pending}</span>
          <span className="stat-label">need a look</span>
        </div>
        <div className="stat">
          <span className="stat-value">{v.counts.unmarked}</span>
          <span className="stat-label">not marked</span>
        </div>
        {!active && (
          <div className="stat">
            <span className="stat-value">{v.counts.absent}</span>
            <span className="stat-label">absent</span>
          </div>
        )}
      </div>

      {v.headcount_warning && (
        <Notice tone="warn">
          More students are marked present than you counted. Run a spot check to see who is really here.
        </Notice>
      )}

      {active && (
        <>
          <ScreenCard sessionId={sessionId} />
          <div className="card">
            <h3>Actions</h3>
            <p className="muted small">A recheck asks unmarked and flagged students (plus a few random ones) to scan again. Everyone else sees "nothing to do".</p>
            <ErrorNotice error={round.error ?? spot.error} />
            <div className="btn-row" style={{ marginTop: '0.75rem' }}>
              <button className="btn" disabled={round.isPending} onClick={() => round.mutate('targeted')}>
                Recheck
              </button>
              <button className="btn" disabled={round.isPending} onClick={() => round.mutate('full')}>
                Recheck everyone
              </button>
              <button className="btn" disabled={spot.isPending} onClick={() => spot.mutate()}>
                Spot check
              </button>
              <Headcount sessionId={sessionId} current={v.session.headcount} onSaved={setLive} />
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn btn-danger" onClick={() => setConfirmEnd(true)}>
                End attendance
              </button>
            </div>
          </div>
        </>
      )}

      {openSpots.length > 0 && (
        <div className="card">
          <h3>Spot check: call these students</h3>
          <p className="muted small">Ask each student to raise their hand or answer.</p>
          <ul className="student-list">
            {openSpots.map((sp) => (
              <SpotRow key={sp.id} sessionId={sessionId} spot={sp} student={v.students.find((s) => s.id === sp.student_id)} onSaved={setLive} />
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div className="card">
          <h3>Needs a look ({attention.length})</h3>
          <ul className="student-list">
            {attention
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .map((s) => (
                <StudentRow key={s.id} sessionId={sessionId} s={s} actions />
              ))}
          </ul>
        </div>
      )}

      {unmarked.length > 0 && (
        <div className="card">
          <h3>Not marked yet ({unmarked.length})</h3>
          <ul className="student-list">
            {unmarked.map((s) => (
              <StudentRow key={s.id} sessionId={sessionId} s={s} actions />
            ))}
          </ul>
        </div>
      )}

      <details className="card">
        <summary>
          <h3 style={{ display: 'inline' }}>Present ({present.length})</h3>
        </summary>
        <ul className="student-list" style={{ marginTop: '0.75rem' }}>
          {present.map((s) => (
            <StudentRow key={s.id} sessionId={sessionId} s={s} actions={active} />
          ))}
        </ul>
      </details>

      <Dialog
        open={confirmEnd}
        title="End attendance?"
        onClose={() => setConfirmEnd(false)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirmEnd(false)}>
              Keep running
            </button>
            <button className="btn btn-danger" disabled={end.isPending} onClick={() => end.mutate()}>
              End attendance
            </button>
          </>
        }
      >
        <p>
          {v.counts.unmarked > 0 ? `${v.counts.unmarked} student${v.counts.unmarked === 1 ? '' : 's'} not marked will be recorded absent. ` : ''}
          You can still confirm or change individual students until the class ends.
        </p>
        <ErrorNotice error={end.error} />
      </Dialog>
    </div>
  );
}

function ScreenCard({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState('');
  const link = useMutation({ mutationFn: () => apiSend('POST', `/v1/attendance/sessions/${sessionId}/display`, { code }), onSuccess: () => setCode('') });
  return (
    <div className="card">
      <div className="card-row">
        <IconTile name="phone" />
        <div style={{ flex: 1 }}>
          <h3>Classroom screen</h3>
          <p className="muted small">Show the rotating QR code on the projector. Students scan it with the Argus app.</p>
          <div className="screen-options">
            <div>
              <p className="small">
                <strong>This computer is connected to the projector</strong>
              </p>
              <button className="btn btn-primary" onClick={() => window.open(`/display?session=${sessionId}`, 'argus-display', 'noopener')}>
                Show QR on this screen
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                link.mutate();
              }}
            >
              <Field label="Or connect the classroom computer" hint="Open argus on it at /display and type the code it shows" error={link.error ? (link.error as Error).message : undefined}>
                <div className="btn-row">
                  <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC 123" aria-label="Screen code" style={{ maxWidth: '9rem', letterSpacing: '0.1em' }} />
                  <button className="btn" disabled={code.replace(/\s/g, '').length < 6 || link.isPending}>
                    Connect
                  </button>
                </div>
              </Field>
              {link.isSuccess && <p className="ok-text small">Screen connected.</p>}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function Headcount({ sessionId, current, onSaved }: { sessionId: string; current: number | null; onSaved: (v: Live) => void }) {
  const [value, setValue] = useState(current === null ? '' : String(current));
  const save = useMutation({ mutationFn: () => apiSend<Live>('POST', `/v1/attendance/sessions/${sessionId}/headcount`, { headcount: Number(value) }), onSuccess: onSaved });
  return (
    <form
      className="btn-row"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input type="number" min={0} max={1000} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Headcount" aria-label="Headcount" style={{ width: '7.5rem' }} />
      <button className="btn" disabled={value === '' || save.isPending}>
        Save count
      </button>
    </form>
  );
}

function StudentRow({ sessionId, s, actions }: { sessionId: string; s: Student; actions: boolean }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (status: 'present' | 'absent') => apiSend('POST', `/v1/attendance/sessions/${sessionId}/students/${s.id}/decision`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['attendance', sessionId, 'live'] }),
  });
  const tone = s.state === 'flagged_high' ? 'badge-bad' : s.state === 'flagged' || s.state === 'pending' ? 'badge-warn' : s.state === 'verified' || s.state === 'confirmed' ? 'badge-good' : '';
  const note = s.last_rejection ? `Tried: ${REJECTION_TEXT[s.last_rejection.code] ?? s.last_rejection.code.replace(/_/g, ' ')}` : s.reasons.join(' · ');
  return (
    <li>
      <span className="student-name">
        <strong>{s.name}</strong>
        <span className="muted small">
          {s.usn}
          {s.batch ? ` · ${s.batch}` : ''}
        </span>
      </span>
      <span className="student-note muted small">{note}</span>
      <span className={`badge ${tone}`}>{s.late ? 'Late' : STATE_LABEL[s.state]}</span>
      {actions && (
        <span className="btn-row">
          {s.state !== 'confirmed' && s.state !== 'verified' && (
            <button className="btn btn-ghost" disabled={decide.isPending} onClick={() => decide.mutate('present')}>
              Present
            </button>
          )}
          {s.state !== 'absent' && s.state !== 'unmarked' && (
            <button className="btn btn-ghost" disabled={decide.isPending} onClick={() => decide.mutate('absent')}>
              Absent
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function SpotRow({ sessionId, spot, student, onSaved }: { sessionId: string; spot: Live['spot_checks'][number]; student: Student | undefined; onSaved: (v: Live) => void }) {
  const record = useMutation({
    mutationFn: (result: 'confirmed' | 'absent' | 'no_response') => apiSend<Live>('POST', `/v1/attendance/sessions/${sessionId}/spot-checks`, { spot_check_id: spot.id, result }),
    onSuccess: onSaved,
  });
  return (
    <li>
      <span className="student-name">
        <strong>{spot.name}</strong>
        <span className="muted small">
          {student?.usn}
          {student?.batch ? ` · ${student.batch}` : ''}
        </span>
      </span>
      <span className="student-note muted small">{spot.reason === 'random' ? 'Random check' : 'Flagged'}</span>
      <span className="btn-row">
        <button className="btn btn-primary" disabled={record.isPending} onClick={() => record.mutate('confirmed')}>
          Here
        </button>
        <button className="btn btn-danger" disabled={record.isPending} onClick={() => record.mutate('absent')}>
          Not here
        </button>
        <button className="btn btn-ghost" disabled={record.isPending} onClick={() => record.mutate('no_response')}>
          No answer
        </button>
      </span>
    </li>
  );
}
