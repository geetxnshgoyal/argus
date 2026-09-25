import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog, ErrorNotice, Field, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, qs, type Schemas } from '../../lib/api.ts';

type Rebind = Schemas['RebindRequest'];
type Device = Schemas['Device'];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const LEVEL: Record<string, string> = { strongbox: 'Secure chip (StrongBox)', tee: 'Secure hardware', app_attest: 'Apple App Attest', dev_bypass: 'Development build' };

/** Phone changes (ADR-0007) and a student's registered phones. */
export function PhonesPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'pending' | ''>('pending');
  const list = useQuery({ queryKey: ['admin', 'rebinds', status], queryFn: () => apiGet<{ items: Rebind[] }>(`/v1/admin/rebind-requests${qs({ status })}`), refetchInterval: 30_000 });
  const [deciding, setDeciding] = useState<{ r: Rebind; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: () => apiSend('POST', `/v1/admin/rebind-requests/${deciding!.r.id}/${deciding!.action}`, { note }),
    onSuccess: () => {
      setDeciding(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['admin', 'rebinds'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'devices'] });
    },
  });
  const items = list.data?.items ?? [];

  return (
    <>
      <PageHead
        title="Phones"
        subtitle="Students mark attendance only on their registered phone. A new phone waits 48 hours unless you activate it after checking the student's ID."
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value as 'pending' | '')} aria-label="Show">
            <option value="pending">Waiting phone changes</option>
            <option value="">All phone changes</option>
          </select>
        }
      />
      <ErrorNotice error={list.error} />
      {list.isSuccess && items.length === 0 && <Notice>{status === 'pending' ? 'No phone changes are waiting.' : 'No phone changes yet.'}</Notice>}
      {items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>New phone</th>
                <th>Old phone</th>
                <th>Requested</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.student_name}</strong>
                    <br />
                    <span className="muted small">{r.usn}</span>
                  </td>
                  <td>
                    {r.new_model} <span className="muted small">({r.new_platform})</span>
                  </td>
                  <td>{r.old_model ?? <span className="muted">None</span>}</td>
                  <td>{when(r.created_at)}</td>
                  <td>
                    {r.status === 'pending' ? (
                      r.needs_approval ? (
                        <span className="badge badge-warn" title={r.approval_reason ?? ''}>
                          Needs your approval
                        </span>
                      ) : (
                        <span className="badge">Active from {when(r.eligible_at)}</span>
                      )
                    ) : (
                      <span className={`badge ${r.status === 'approved' || r.status === 'completed' ? 'badge-good' : ''}`}>
                        {r.status}
                        {r.decided_by_name ? ` by ${r.decided_by_name}` : ''}
                      </span>
                    )}
                    {r.approval_reason && <div className="muted small">{r.approval_reason}</div>}
                    {r.decision_note && <div className="muted small">{r.decision_note}</div>}
                  </td>
                  <td className="actions">
                    {r.status === 'pending' && (
                      <span className="btn-row">
                        <button className="btn btn-primary" onClick={() => setDeciding({ r, action: 'approve' })}>
                          Activate now
                        </button>
                        <button className="btn btn-danger" onClick={() => setDeciding({ r, action: 'reject' })}>
                          Reject
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <StudentPhones />

      <Dialog
        open={deciding !== null}
        title={deciding?.action === 'approve' ? 'Activate the new phone now?' : 'Reject the new phone?'}
        onClose={() => setDeciding(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setDeciding(null)}>
              Cancel
            </button>
            <button className={`btn ${deciding?.action === 'approve' ? 'btn-primary' : 'btn-danger'}`} disabled={note.trim().length < 3 || decide.isPending} onClick={() => decide.mutate()}>
              {deciding?.action === 'approve' ? 'Activate' : 'Reject'}
            </button>
          </>
        }
      >
        {deciding && (
          <div className="form">
            <p>
              {deciding.action === 'approve'
                ? `Only do this after checking ${deciding.r.student_name}'s college ID in person. Their old phone stops working for attendance.`
                : `${deciding.r.student_name}'s new phone will not be used for attendance. Their old phone keeps working.`}
            </p>
            <Field label="Note" hint='For example "ID card checked at the office"'>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus />
            </Field>
            <ErrorNotice error={decide.error} />
          </div>
        )}
      </Dialog>
    </>
  );
}

function StudentPhones() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [student, setStudent] = useState<{ id: string; name: string } | null>(null);
  const search = useQuery({
    queryKey: ['admin', 'users', 'phones-search', q],
    queryFn: () => apiGet<Schemas['UserList']>(`/v1/admin/users${qs({ role: 'student', q, limit: 10 })}`),
    enabled: q.trim().length >= 2,
  });
  const devices = useQuery({
    queryKey: ['admin', 'devices', student?.id],
    queryFn: () => apiGet<{ items: Device[] }>(`/v1/admin/devices?user_id=${student!.id}`),
    enabled: Boolean(student),
  });
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: () => apiSend('POST', `/v1/admin/devices/${revoking!.id}/revoke`, { reason }),
    onSuccess: () => {
      setRevoking(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['admin', 'devices'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'rebinds'] });
    },
  });

  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <h3>A student's phones</h3>
      <p className="muted small">Look up a student to see their phones, or to remove a lost or stolen one.</p>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <input type="search" placeholder="Name, email or USN" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find student" />
      </div>
      {!student && (search.data?.items ?? []).length > 0 && (
        <ul className="issue-list">
          {search.data!.items.map((u) => (
            <li key={u.id}>
              <button className="btn btn-ghost" onClick={() => setStudent({ id: u.id, name: u.name })}>
                {u.name} <span className="muted small">{u.usn}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {student && (
        <>
          <p>
            <strong>{student.name}</strong>{' '}
            <button className="btn btn-ghost" onClick={() => setStudent(null)}>
              Change
            </button>
          </p>
          <ErrorNotice error={devices.error} />
          {devices.data && devices.data.items.length === 0 && <Notice>No phone registered yet.</Notice>}
          <ul className="issue-list">
            {devices.data?.items.map((d) => (
              <li key={d.id}>
                <span className={`badge ${d.state === 'active' ? 'badge-good' : d.state === 'pending' ? 'badge-warn' : ''}`}>{d.state}</span>
                <span style={{ flex: 1 }}>
                  {d.model} <span className="muted small">({d.platform} {d.os_version}) · {LEVEL[d.attestation_level] ?? d.attestation_level} · registered {when(d.bound_at)}</span>
                  {d.revoked_at && <span className="muted small"> · removed {when(d.revoked_at)} ({d.revoke_reason?.replace(/_/g, ' ')})</span>}
                </span>
                {d.state !== 'revoked' && (
                  <button className="btn btn-danger" onClick={() => setRevoking(d)}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Dialog
        open={revoking !== null}
        title="Remove this phone?"
        onClose={() => setRevoking(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRevoking(null)}>
              Cancel
            </button>
            <button className="btn btn-danger" disabled={reason.trim().length < 3 || revoke.isPending} onClick={() => revoke.mutate()}>
              Remove phone
            </button>
          </>
        }
      >
        <div className="form">
          <p>It can no longer be used for attendance. The student must register a phone again.</p>
          <Field label="Reason" hint='For example "Phone lost, reported by student"'>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
          </Field>
          <ErrorNotice error={revoke.error} />
        </div>
      </Dialog>
    </div>
  );
}
