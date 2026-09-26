import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, type Schemas } from '../lib/api.ts';
import { ErrorNotice } from './ui.tsx';

/** Notices from Academic Operations for the signed-in teacher (ADR-0023). Hidden when there are none. */
export function NoticesCard() {
  const qc = useQueryClient();
  const notices = useQuery({ queryKey: ['me', 'notices'], queryFn: () => apiGet<Schemas['MyNotices']>('/v1/me/notices'), refetchInterval: 60_000 });
  const read = useMutation({
    mutationFn: () => apiSend('POST', '/v1/me/notices/read', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me', 'notices'] }),
  });
  const items = notices.data?.items ?? [];
  if (!items.length) return null;
  const unread = notices.data?.unread ?? 0;
  return (
    <div className={`card ${unread ? 'card-attention' : ''}`}>
      <div className="card-row" style={{ justifyContent: 'space-between' }}>
        <h3>Notices{unread ? ` · ${unread} new` : ''}</h3>
        {unread > 0 && (
          <button className="btn btn-ghost" disabled={read.isPending} onClick={() => read.mutate()}>
            Mark all as read
          </button>
        )}
      </div>
      <ErrorNotice error={read.error} />
      <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
        {items.slice(0, 6).map((n) => (
          <li key={n.id} style={{ alignItems: 'flex-start', opacity: n.read ? 0.7 : 1 }}>
            <div style={{ flex: 1 }}>
              <div>
                {!n.read && <span className="badge badge-good">New</span>} {n.kind === 'class_change' && <span className="badge badge-warn">Class change</span>}{' '}
                <strong>{n.title}</strong>
              </div>
              {n.body && <p style={{ whiteSpace: 'pre-wrap', margin: '0.35rem 0 0' }}>{n.body}</p>}
              <p className="muted small">From Academic Operations · {new Date(n.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
