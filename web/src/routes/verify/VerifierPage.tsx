import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, Field, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, qs, type Schemas } from '../../lib/api.ts';
import { formatDate } from '../../lib/refs.ts';

type Item = Schemas['VerifierQueueItem'];
type Detail = Schemas['SupportDetail'];

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Waiting for you', tone: 'badge-warn' },
  asked_teacher: { label: 'Asked teacher', tone: '' },
  approved: { label: 'Approved', tone: 'badge-good' },
  rejected: { label: 'Rejected', tone: 'badge-bad' },
  expired: { label: 'Expired', tone: '' },
};

/** Verifier console (spec §7, §11): queue, evidence card, decisions with enforced rules (ADR-0006). */
export function VerifierPage() {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const queue = useQuery({
    queryKey: ['verifier', 'queue', filter],
    queryFn: () => apiGet<{ items: Item[] }>(`/v1/verifier/support-requests${qs({ status: filter })}`),
    refetchInterval: 5000,
  });
  const items = queue.data?.items ?? [];
  const current = selected ?? items.find((i) => i.status === 'pending')?.id ?? null;

  return (
    <div className="content verifier">
      <PageHead
        title="Support requests"
        subtitle="Students who could not mark attendance in class. Approve only with good evidence; otherwise ask the teacher."
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')} aria-label="Show">
            <option value="open">Open requests</option>
            <option value="all">All recent</option>
          </select>
        }
      />
      <ErrorNotice error={queue.error} />
      {queue.isSuccess && items.length === 0 && <Notice>No {filter === 'open' ? 'open ' : ''}support requests right now. This page refreshes by itself.</Notice>}
      {items.length > 0 && (
        <div className="split">
          <ul className="queue" aria-label="Requests">
            {items.map((i) => (
              <li key={i.id}>
                <button className={`queue-item${current === i.id ? ' active' : ''}`} onClick={() => setSelected(i.id)}>
                  <span className="queue-top">
                    <strong>{i.student_name}</strong>
                    <span className={`badge ${STATUS[i.status]?.tone ?? ''}`}>{STATUS[i.status]?.label ?? i.status}</span>
                  </span>
                  <span className="muted small">
                    {i.usn} · {i.subject_code} {i.start}–{i.end} · {i.room ?? 'No room'}
                  </span>
                  <span className="muted small">
                    {i.reason_text} · score {i.evidence_score} · {i.valid_tag_seen ? 'scanned a valid code' : 'no valid scan'}
                    {i.teacher_answer === 'not_sure' ? ' · teacher not sure' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {current ? <EvidenceCard key={current} id={current} /> : <div className="card muted">Choose a request.</div>}
        </div>
      )}
    </div>
  );
}

function EvidenceCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['verifier', 'detail', id], queryFn: () => apiGet<Detail>(`/v1/verifier/support-requests/${id}`), refetchInterval: 8000 });
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (action: 'approve' | 'ask_teacher' | 'reject') => apiSend<Detail>('POST', `/v1/verifier/support-requests/${id}/decision`, { action, reason: reason.trim() || null }),
    onSuccess: (d) => {
      qc.setQueryData(['verifier', 'detail', id], d);
      void qc.invalidateQueries({ queryKey: ['verifier', 'queue'] });
      setReason('');
    },
  });
  if (detail.isPending) return <div className="card muted">Loading evidence…</div>;
  if (!detail.data) return <ErrorNotice error={detail.error} />;
  const d = detail.data;
  const e = d.evidence as Evidence;
  const open = d.status === 'pending' || d.status === 'asked_teacher';

  return (
    <div className="card evidence">
      <div className="card-row">
        <IconTile name="shield" tone={d.can_approve ? undefined : 'warn'} />
        <div style={{ flex: 1 }}>
          <h2>{e.student?.name}</h2>
          <p className="muted">
            {e.student?.usn} · {e.student?.batch ?? 'No batch'} · {e.student?.email}
          </p>
          <p>
            <strong>{e.class?.subject?.name}</strong>{' '}
            <span className="muted">
              {e.class ? `${formatDate(e.class.date)} ${e.class.start}–${e.class.end} · ${e.class.room ?? 'No room'} · ${e.class.teacher ?? 'No teacher'}` : ''}
            </span>
          </p>
          <p>
            <span className="badge">{d.reason_text}</span> {d.note && <span className="muted">“{d.note}”</span>}
          </p>
        </div>
      </div>

      <div className="evidence-grid">
        <Fact label="Evidence score" value={`${d.evidence_score}`} tone={d.evidence_score < d.threshold ? 'good' : 'bad'} hint={`Approve needs below ${d.threshold}`} />
        <Fact label="Valid QR scan this class" value={d.valid_tag_seen ? 'Yes' : 'No'} tone={d.valid_tag_seen ? 'good' : 'bad'} hint="Proves the phone saw the code in the room" />
        <Fact label="Location at request" value={locationText(e.request)} tone={e.request?.location === 'inside' ? 'good' : e.request?.location === 'outside' ? 'bad' : 'warn'} />
        <Fact label="Campus network" value={e.request?.campus_network === null ? 'Not configured' : e.request?.campus_network ? 'Yes' : 'No'} tone={e.request?.campus_network === false ? 'warn' : 'good'} />
        <Fact label="Phone" value={`${e.device?.model ?? ''} (${e.device?.platform ?? ''})`} hint={`Check: ${e.device?.attestation_level ?? '?'} · registered ${e.device?.activated_at ? new Date(e.device.activated_at).toLocaleDateString() : '?'}`} />
        <Fact label="Last 30 days" value={e.history_30d?.percent === null || e.history_30d?.percent === undefined ? 'No classes' : `${e.history_30d.percent}% attended`} hint={`${e.history_30d?.attended ?? 0} of ${e.history_30d?.total ?? 0} classes`} />
      </div>

      {e.score_factors && e.score_factors.length > 0 && (
        <p className="small">
          <strong>Why this score: </strong>
          {e.score_factors.map((f) => f.text).join(' · ')}
        </p>
      )}

      <h3>Scans in this class</h3>
      {e.attempts && e.attempts.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Round</th>
                <th>Result</th>
                <th>Valid code</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {e.attempts.map((a, i) => (
                <tr key={i}>
                  <td>{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                  <td>{a.round}</td>
                  <td>
                    {a.decision === 'rejected' ? <span className="bad-text">Rejected</span> : a.decision}
                    <span className="muted small"> {a.reasons.map((r) => r.replace(/_/g, ' ')).join(', ')}</span>
                    {a.other_device && <span className="badge badge-bad">other phone</span>}
                  </td>
                  <td>{a.tag_valid ? 'Yes' : 'No'}</td>
                  <td className="small">{locationText(a.signals ?? undefined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No scans from this student in this class.</p>
      )}

      {e.flags_30d && e.flags_30d.length > 0 && (
        <>
          <h3>Flags in the last 30 days</h3>
          <ul className="issue-list">
            {e.flags_30d.slice(0, 8).map((f, i) => (
              <li key={i}>
                <span className={`badge ${f.severity === 'high' ? 'badge-bad' : 'badge-warn'}`}>{f.severity}</span>
                <span style={{ flex: 1 }}>{f.text}</span>
                <span className="muted small">
                  {new Date(f.at).toLocaleDateString()} {f.resolution ? `· ${f.resolution.replace(/_/g, ' ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {d.teacher.answer && (
        <Notice tone={d.teacher.answer === 'present' ? 'good' : d.teacher.answer === 'absent' ? 'bad' : 'warn'}>
          {d.teacher.name ?? 'The teacher'} answered: {d.teacher.answer === 'present' ? 'in the room' : d.teacher.answer === 'absent' ? 'not in the room' : 'not sure'}.
        </Notice>
      )}
      {d.status === 'asked_teacher' && <Notice>Waiting for {d.teacher.name ?? 'the teacher'} to answer. You can still reject.</Notice>}

      {open ? (
        d.can_decide ? (
          <div className="form" style={{ marginTop: '1rem' }}>
            {d.approve_blocked_reason && <Notice tone="warn">{d.approve_blocked_reason}</Notice>}
            <Field label="Reason (required to reject)">
              <input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Location off campus, teacher did not confirm" maxLength={300} />
            </Field>
            <ErrorNotice error={decide.error} />
            <div className="btn-row">
              <button className="btn btn-primary" disabled={!d.can_approve || d.status !== 'pending' || decide.isPending} onClick={() => decide.mutate('approve')} title={d.approve_blocked_reason ?? undefined}>
                Approve
              </button>
              <button className="btn" disabled={d.status !== 'pending' || decide.isPending} onClick={() => decide.mutate('ask_teacher')}>
                Ask teacher
              </button>
              <button className="btn btn-danger" disabled={reason.trim().length < 3 || decide.isPending} onClick={() => decide.mutate('reject')}>
                Reject
              </button>
            </div>
            <p className="muted small">Decide before {new Date(d.decision_deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; after that only a correction can change the record.</p>
          </div>
        ) : (
          <Notice tone="warn">The class is over. Changes now need a correction by the teacher and Academic Operations.</Notice>
        )
      ) : (
        <Notice tone={d.status === 'approved' ? 'good' : 'info'}>
          {STATUS[d.status]?.label ?? d.status}
          {d.decided_by ? ` by ${d.decided_by}` : ''}
          {d.decision_reason ? `: ${d.decision_reason}` : '.'}
        </Notice>
      )}
    </div>
  );
}

function Fact({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; hint?: string }) {
  return (
    <div className="fact">
      <span className="muted small">{label}</span>
      <strong className={tone === 'good' ? 'ok-text' : tone === 'bad' ? 'bad-text' : tone === 'warn' ? 'warn-text' : ''}>{value}</strong>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

interface Signals {
  location?: string;
  accuracy_m?: number | null;
  distance_m?: number | null;
  is_mock?: boolean;
  campus_network?: boolean | null;
}

function locationText(s: Signals | undefined): string {
  if (!s || !s.location) return 'Unknown';
  if (s.is_mock) return 'Fake location reported';
  if (s.location === 'inside') return `On campus${s.accuracy_m ? ` (±${s.accuracy_m} m)` : ''}`;
  if (s.location === 'outside') return `${s.distance_m ?? '?'} m outside campus${s.accuracy_m ? ` (±${s.accuracy_m} m)` : ''}`;
  return s.accuracy_m === null || s.accuracy_m === undefined ? 'No location' : `Unclear (±${s.accuracy_m} m)`;
}

interface Evidence {
  student?: { name: string; email: string; usn: string | null; batch: string | null };
  class?: Schemas['ClassSession'];
  attempts?: { at: string; round: number; decision: string; reasons: string[]; tag_valid: boolean; score: number; other_device: boolean; signals: Signals | null }[];
  device?: { model: string; platform: string; attestation_level: string; activated_at: string | null };
  request?: Signals;
  score_factors?: { code: string; text: string }[];
  flags_30d?: { type: string; text: string; severity: string; at: string; resolution: string | null }[];
  history_30d?: { total: number; attended: number; absent: number; percent: number | null };
}
