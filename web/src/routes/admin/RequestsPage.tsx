import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OdQueue } from '../../components/OdRequests.tsx';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, qs, type Schemas } from '../../lib/api.ts';
import { formatDate } from '../../lib/refs.ts';

type Correction = Schemas['Correction'];
type Issue = Schemas['AttendanceIssue'];
type Tab = 'od' | 'issues' | 'corrections';

export const ISSUE_REASON: Record<Issue['reason'], string> = {
  marked_absent_but_present: 'Marked absent but was there',
  marked_late_but_on_time: 'Marked late but was on time',
  wrong_record: 'Wrong record',
  other: 'Other',
};

const STATUS_LABEL: Record<string, string> = { present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused', pending: 'Offline scan', od: 'On duty (OD)' };

/** Everything waiting for Academic Operations (ADR-0027): OD requests, student issues, corrections. */
export function RequestsPage() {
  const [tab, setTab] = useState<Tab>('od');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'od', label: 'OD requests' },
    { key: 'issues', label: 'Student issues' },
    { key: 'corrections', label: 'Corrections' },
  ];
  return (
    <>
      <PageHead title="Requests" subtitle="On-duty requests, students' attendance issues and corrections waiting for approval. Final approvals need a second person." />
      <div className="btn-row" role="tablist" style={{ marginBottom: '1rem' }}>
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`btn ${tab === t.key ? 'btn-primary' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'od' && <OdQueue step="admin" />}
      {tab === 'issues' && <IssuesTab />}
      {tab === 'corrections' && <CorrectionsTab />}
    </>
  );
}

function IssuesTab() {
  const [status, setStatus] = useState('pending_ops');
  const list = useQuery({ queryKey: ['issues', 'ops', status], queryFn: () => apiGet<{ items: Issue[] }>(`/v1/admin/attendance-issues${qs({ status })}`) });
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show">
          <option value="pending_ops">Waiting for Academic Operations</option>
          <option value="pending_teacher">Waiting for the teacher</option>
          <option value="resolved">Resolved</option>
          <option value="declined">Declined</option>
          <option value="all">All</option>
        </select>
      </div>
      <p className="muted small">Issues go to the class's teacher first. Once the teacher confirms, the fix appears under Corrections for approval.</p>
      <ErrorNotice error={list.error} />
      {list.isSuccess && items.length === 0 && <Notice>No issues here.</Notice>}
      <ul className="issue-list" style={{ display: 'grid', gap: '0.75rem' }}>
        {items.map((i) => (
          <IssueItem key={i.id} i={i} />
        ))}
      </ul>
    </>
  );
}

function IssueItem({ i }: { i: Issue }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'correct' | 'decline') => apiSend('POST', `/v1/admin/attendance-issues/${i.id}/decision`, { decision, note: note.trim() || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['issues'] }),
  });
  // Only issues without a teacher (and no correction yet) are decided here.
  const canDecide = i.status === 'pending_ops' && !i.correction_id;
  return (
    <li className="card" style={{ display: 'block' }}>
      <strong>
        {i.student.name} <span className="muted">· {i.student.usn ?? ''}</span>
      </strong>
      <p style={{ margin: '0.4rem 0' }}>
        {i.class.code} · {formatDate(i.class.date)} {i.class.start} — recorded {i.record_status ? STATUS_LABEL[i.record_status] ?? i.record_status : 'nothing'}
      </p>
      <p className="small">
        <strong>{ISSUE_REASON[i.reason]}:</strong> {i.note}
      </p>
      {i.teacher_note && <p className="small muted">Teacher ({i.teacher ?? '—'}): {i.teacher_note}</p>}
      {i.correction_id && i.status === 'pending_ops' && <p className="small">A correction is waiting under Corrections.</p>}
      {canDecide && (
        <div className="btn-row" style={{ marginTop: '0.5rem' }}>
          <input aria-label="Note" placeholder="Note (required to decline)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: '12rem' }} />
          <button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('correct')}>Mark present (needs a second approval)</button>
          <button className="btn btn-danger" disabled={decide.isPending || note.trim().length < 3} onClick={() => decide.mutate('decline')}>Decline</button>
        </div>
      )}
      <ErrorNotice error={decide.error} />
    </li>
  );
}

function CorrectionsTab() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const list = useQuery({ queryKey: ['corrections', status], queryFn: () => apiGet<{ items: Correction[] }>(`/v1/admin/attendance/corrections${qs({ status })}`) });
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Show">
          <option value="pending">Waiting for approval</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>
      <ErrorNotice error={list.error} />
      {list.isSuccess && items.length === 0 && <Notice>No corrections here.</Notice>}
      <ul className="issue-list" style={{ display: 'grid', gap: '0.75rem' }}>
        {items.map((c) => (
          <CorrectionItem key={c.id} c={c} />
        ))}
      </ul>
    </>
  );
}

function CorrectionItem({ c }: { c: Correction }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (d: 'approve' | 'reject') => apiSend('POST', `/v1/admin/attendance/corrections/${c.id}/${d}`, { note: note.trim() || (d === 'approve' ? null : '') }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['corrections'] });
      void qc.invalidateQueries({ queryKey: ['issues'] });
    },
  });
  return (
    <li className="card" style={{ display: 'block' }}>
      <strong>
        {c.student_name} <span className="muted">· {c.usn ?? ''}</span>
      </strong>
      <p style={{ margin: '0.4rem 0' }}>
        {c.subject_code} · {formatDate(c.date)} {c.start}: {c.old_status ? STATUS_LABEL[c.old_status] ?? c.old_status : 'no record'} → <strong>{STATUS_LABEL[c.new_status] ?? c.new_status}</strong>
      </p>
      <p className="small">
        Asked by {c.requested_by_name} ({c.requested_by_role}): {c.reason}
      </p>
      {c.status !== 'pending' && (
        <p className="small muted">
          {c.status === 'approved' ? 'Approved' : 'Rejected'}
          {c.approved_by_name ? ` by ${c.approved_by_name}` : ''}
          {c.decision_note ? ` — ${c.decision_note}` : ''}
        </p>
      )}
      {c.status === 'pending' &&
        (c.mine ? (
          <p className="small muted">You asked for this correction, so someone else must approve it.</p>
        ) : (
          <div className="btn-row" style={{ marginTop: '0.5rem' }}>
            <input aria-label="Note" placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: '12rem' }} />
            <button className="btn btn-primary" disabled={act.isPending} onClick={() => act.mutate('approve')}>Approve</button>
            <button className="btn btn-danger" disabled={act.isPending || note.trim().length < 3} onClick={() => act.mutate('reject')}>Reject</button>
          </div>
        ))}
      <ErrorNotice error={act.error} />
    </li>
  );
}
