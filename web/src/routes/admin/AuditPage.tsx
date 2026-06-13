import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, qs, type Schemas } from '../../lib/api.ts';

type Page = Schemas['AuditPage'];
type Verify = Schemas['AuditVerifyResult'];

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const pages = useInfiniteQuery({
    queryKey: ['audit', entityType, action],
    initialPageParam: '',
    queryFn: ({ pageParam }) => apiGet<Page>(`/v1/admin/audit${qs({ entity_type: entityType, action, before_id: pageParam || undefined, limit: 100 })}`),
    getNextPageParam: (last) => last.next_before_id ?? undefined,
  });
  const verify = useMutation({ mutationFn: () => apiSend<Verify>('POST', '/v1/admin/audit/verify') });
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHead
        title="Audit log"
        subtitle="Every change made in Argus, who made it and when. Entries are chained together so any tampering is detected."
        actions={
          <button className="btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Checking…' : 'Check integrity'}
          </button>
        }
      />
      {verify.data &&
        (verify.data.ok ? (
          <Notice tone="good">Integrity check passed: all {verify.data.checked} entries are intact.</Notice>
        ) : (
          <Notice tone="bad">
            Integrity check FAILED at entry {verify.data.problem?.id}: {verify.data.problem?.reason}. Report this to the administrator immediately.
          </Notice>
        ))}
      <ErrorNotice error={verify.error ?? pages.error} />
      <div className="toolbar">
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {['user', 'section', 'section_group', 'department', 'program', 'term', 'subject', 'room', 'geofence', 'campus_network', 'offering', 'enrollment', 'teaching_assignment', 'audit_log'].map((t) => (
            <option key={t} value={t}>{t.replace('_', ' ')}</option>
          ))}
        </select>
        <input type="search" placeholder="Action starts with… (e.g. user.)" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action" />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Details</th></tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</td>
                <td>{e.actor_name ?? 'System'}</td>
                <td className="mono">{e.action}</td>
                <td className="muted">{e.entity_type}</td>
                <td>
                  <details>
                    <summary className="muted small">View</summary>
                    <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxWidth: '40rem' }}>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!pages.isPending && items.length === 0 && <div className="empty">No entries.</div>}
      </div>
      {pages.hasNextPage && (
        <div className="pager">
          <span />
          <button className="btn" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            Load older entries
          </button>
        </div>
      )}
    </>
  );
}
