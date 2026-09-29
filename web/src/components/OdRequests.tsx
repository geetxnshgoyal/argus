import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiGet, apiSend, qs, type Schemas } from '../lib/api.ts';
import { formatDate } from '../lib/refs.ts';
import { ErrorNotice, Notice } from './ui.tsx';

type Od = Schemas['OdRequest'];

export const OD_STATUS_LABEL: Record<Od['status'], string> = {
  pending_cm: 'Waiting for community manager',
  pending_ops: 'Waiting for Academic Operations',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};

function scope(r: Od): string {
  if (r.kind === 'days') return r.dates.map(formatDate).join(', ');
  return r.classes.map((c) => `${c.code} ${formatDate(c.date)} ${c.start}`).join(' · ');
}

/**
 * OD request queue (ADR-0027). `step` is who is looking: the community manager
 * confirms the duty, Acad Ops gives the final approval (a different person).
 */
export function OdQueue({ step }: { step: 'community' | 'admin' }) {
  const waiting = step === 'community' ? 'pending_cm' : 'pending_ops';
  const [status, setStatus] = useState<string>(waiting);
  const base = step === 'community' ? '/v1/community/od-requests' : '/v1/admin/od-requests';
  const list = useQuery({ queryKey: ['od', step, status], queryFn: () => apiGet<{ items: Od[] }>(`${base}${qs({ status })}`), refetchInterval: 30_000 });
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show">
          <option value={waiting}>Waiting for me</option>
          {step === 'admin' && <option value="pending_cm">Waiting for community manager</option>}
          {step === 'community' && <option value="pending_ops">Sent to Academic Operations</option>}
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <span className="muted small">{items.length} shown</span>
      </div>
      <ErrorNotice error={list.error} />
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isSuccess && items.length === 0 && <Notice>{status === waiting ? 'Nothing is waiting for you.' : 'No requests.'}</Notice>}
      <ul className="issue-list" style={{ display: 'grid', gap: '0.75rem' }}>
        {items.map((r) => (
          <OdItem key={r.id} r={r} base={base} canDecide={r.status === waiting} step={step} />
        ))}
      </ul>
    </>
  );
}

function OdItem({ r, base, canDecide, step }: { r: Od; base: string; canDecide: boolean; step: 'community' | 'admin' }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => apiSend('POST', `${base}/${r.id}/decision`, { decision, note: note.trim() || null }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['od'] }),
  });
  const id = `od-note-${r.id}`;
  return (
    <li className="card" style={{ display: 'block' }}>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <strong>
          {r.student.name} <span className="muted">· {r.student.usn ?? ''}{r.student.section ? ` · ${r.student.section}` : ''}</span>
        </strong>
        <span className={`badge ${r.status === 'approved' ? 'badge-good' : r.status === 'rejected' ? 'badge-bad' : 'badge-warn'}`}>{OD_STATUS_LABEL[r.status]}</span>
      </div>
      <p style={{ margin: '0.5rem 0 0.25rem' }}>
        <strong>{r.event}</strong> — {r.reason}
      </p>
      <p className="muted small">
        {r.kind === 'days' ? 'Whole days: ' : 'Classes: '}
        {scope(r)} · asked {new Date(r.created_at).toLocaleDateString('en-IN', { dateStyle: 'medium' })}
      </p>
      {r.attachments.length > 0 ? (
        <p className="small">
          Proof:{' '}
          {r.attachments.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ' · '}
              <a href={`/v1/od-requests/${r.id}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">
                {a.filename}
              </a>{' '}
              <span className="muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
            </span>
          ))}
        </p>
      ) : (
        <p className="small muted">No proof attached.</p>
      )}
      {r.community_manager && (
        <p className="small">
          Community manager: {r.community_manager.name}
          {r.community_manager.note ? ` — “${r.community_manager.note}”` : ''}
        </p>
      )}
      {r.acadops && (
        <p className="small">
          Academic Operations: {r.acadops.name}
          {r.acadops.note ? ` — “${r.acadops.note}”` : ''}
        </p>
      )}
      {canDecide && (
        <div style={{ marginTop: '0.75rem' }}>
          <label htmlFor={id} className="small muted">
            Note {step === 'community' ? '(e.g. "On the event list")' : ''} — required to reject
          </label>
          <div className="btn-row" style={{ marginTop: '0.35rem' }}>
            <input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} style={{ flex: 1, minWidth: '12rem' }} />
            <button className="btn btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              {step === 'community' ? 'Confirm duty' : 'Approve OD'}
            </button>
            <button className="btn btn-danger" disabled={decide.isPending || note.trim().length < 3} onClick={() => decide.mutate('reject')}>
              Reject
            </button>
          </div>
          <ErrorNotice error={decide.error} />
        </div>
      )}
    </li>
  );
}
