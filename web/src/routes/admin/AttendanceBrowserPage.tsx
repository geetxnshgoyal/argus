import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { CorrectionDialog } from '../../components/CorrectionDialog.tsx';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, qs, type Schemas } from '../../lib/api.ts';
import { formatDate } from '../../lib/refs.ts';

type Row = Schemas['AdminAttendanceSession'];
type Detail = Schemas['AdminAttendanceDetail'];

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Attendance sessions on a day (spec §11 "sessions browser"). */
export function AttendanceBrowserPage() {
  const [date, setDate] = useState(todayLocal);
  const list = useQuery({ queryKey: ['admin', 'attendance', date], queryFn: () => apiGet<{ date: string; items: Row[] }>(`/v1/admin/attendance/sessions${qs({ date })}`) });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHead title="Attendance" subtitle="Classes where attendance was taken, and who was marked how." actions={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />} />
      <ErrorNotice error={list.error} />
      {list.isSuccess && items.length === 0 && <Notice>No attendance was taken on {formatDate(date)}.</Notice>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Class</th>
                <th>Teacher</th>
                <th>Present</th>
                <th>Late</th>
                <th>Absent</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.class.start}–{r.class.end}
                  </td>
                  <td>
                    <Link to="/admin/attendance/$sessionId" params={{ sessionId: r.id }}>
                      {r.class.subject.code} · {r.class.subject.name}
                    </Link>
                    <div className="muted small">
                      {r.class.section.name}
                      {r.class.batch ? `, ${r.class.batch}` : ''} · {r.class.room ?? 'No room'}
                    </div>
                  </td>
                  <td>{r.started_by ?? r.class.teacher ?? '—'}</td>
                  <td>{r.counts.present}</td>
                  <td>{r.counts.late}</td>
                  <td>{r.counts.absent}</td>
                  <td>
                    <span className={`badge ${r.status === 'active' ? 'badge-good' : ''}`}>{r.status === 'active' ? 'Running' : 'Ended'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const BASIS: Record<string, string> = { system: 'scan', teacher: 'teacher', verifier: 'verifier', correction: 'correction' };

export function AttendanceDetailPage({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['admin', 'attendance', 'detail', sessionId], queryFn: () => apiGet<Detail>(`/v1/admin/attendance/sessions/${sessionId}`) });
  const [correcting, setCorrecting] = useState<{ id: string; name: string; status: string | null } | null>(null);
  if (detail.isPending) return <div className="muted">Loading…</div>;
  if (!detail.data) return <ErrorNotice error={detail.error} />;
  const d = detail.data;
  const c = d.session.class;
  return (
    <>
      <Link to="/admin/attendance" className="muted small">
        ← Attendance
      </Link>
      <PageHead
        title={`${c.subject.code} · ${c.subject.name}`}
        subtitle={`${formatDate(c.date)} ${c.start}–${c.end} · ${c.section.name}${c.batch ? `, ${c.batch}` : ''} · ${c.room ?? 'No room'} · started by ${d.session.started_by ?? '—'}${d.session.ended_automatically ? ' · ended automatically' : ''}`}
      />
      <p className="muted small">
        Rounds: {d.rounds.map((r) => `${r.no} (${r.mode}${r.targets !== null ? `, ${r.targets} students` : ''})`).join(' · ')}
        {d.session.headcount !== null ? ` · Teacher's headcount: ${d.session.headcount}` : ''}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Record</th>
              <th>Scans</th>
              <th>Flags and checks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.students.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  <div className="muted small">
                    {s.usn}
                    {s.batch ? ` · ${s.batch}` : ''}
                  </div>
                </td>
                <td>
                  {s.record ? (
                    <>
                      <span className={`badge ${s.record.status === 'present' ? 'badge-good' : s.record.status === 'absent' ? 'badge-bad' : 'badge-warn'}`}>{s.record.status}</span>
                      <div className="muted small">
                        by {BASIS[s.record.basis] ?? s.record.basis}
                        {s.record.updated_by ? ` (${s.record.updated_by})` : ''}
                        {s.record.note ? `: ${s.record.note}` : ''}
                      </div>
                    </>
                  ) : (
                    <span className="muted">Not marked</span>
                  )}
                </td>
                <td className="small">
                  {s.attempts === 0 ? <span className="muted">None</span> : `${s.attempts} · last ${s.last_attempt?.decision ?? ''}`}
                  {s.last_attempt && s.last_attempt.reasons.length > 0 && <div className="muted small">{s.last_attempt.reasons.join(', ')}</div>}
                </td>
                <td className="small">
                  {s.flags.map((f, i) => (
                    <div key={i}>
                      <span className={f.resolution ? 'muted' : f.severity === 'high' ? 'bad-text' : 'warn-text'}>{f.text}</span>
                      {f.resolution ? <span className="muted"> ({f.resolution.replace(/_/g, ' ')})</span> : null}
                    </div>
                  ))}
                  {s.spot_checks.map((sp, i) => (
                    <div key={`sp${i}`}>Spot check: {sp.result?.replace(/_/g, ' ') ?? 'pending'}</div>
                  ))}
                  {s.support.map((sr) => (
                    <div key={sr.id}>Support request: {sr.status.replace(/_/g, ' ')}</div>
                  ))}
                  {s.corrections.map((cr) => (
                    <div key={cr.id}>
                      Correction to {cr.new_status}: {cr.status}
                    </div>
                  ))}
                </td>
                <td className="actions">
                  <button className="btn btn-ghost" onClick={() => setCorrecting({ id: s.id, name: s.name, status: s.record?.status ?? null })}>
                    Correct
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CorrectionDialog
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['admin', 'attendance', 'detail', sessionId] })}
        as="admin"
        student={correcting}
        classSessionId={d.session.class.id}
      />
    </>
  );
}
