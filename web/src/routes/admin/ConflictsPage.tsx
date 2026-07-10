import { useQuery } from '@tanstack/react-query';
import { ScopePicker } from '../../components/ScopePicker.tsx';
import { ErrorNotice, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, qs, type Schemas } from '../../lib/api.ts';
import { useScope } from '../../lib/refs.ts';

export function ConflictsPage() {
  const scope = useScope();
  const r = useQuery({
    queryKey: ['conflicts', scope.termId],
    queryFn: () => apiGet<Schemas['Conflicts']>(`/v1/admin/conflicts${qs({ term_id: scope.termId })}`),
    enabled: Boolean(scope.termId),
  });
  return (
    <>
      <PageHead title="Timetable check" subtitle="Double-bookings, and things that will stop attendance from working (like classes without a teacher)." />
      <ScopePicker {...scope} needSection={false} />
      <ErrorNotice error={r.error} />
      {!scope.termId && <Notice>Choose a term.</Notice>}
      {r.data && (
        <>
          <div className="card">
            <div className="card-row">
              <IconTile name={r.data.conflicts.length ? 'alert' : 'check'} tone={r.data.conflicts.length ? 'bad' : undefined} />
              <div style={{ flex: 1 }}>
                <h3>{r.data.conflicts.length ? `${r.data.conflicts.length} double-bookings` : 'No double-bookings'}</h3>
                <ul className="issue-list">
                  {r.data.conflicts.map((c, i) => <li key={i}><span className="badge badge-bad">Conflict</span>{c.message}</li>)}
                </ul>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-row">
              <IconTile name={r.data.warnings.length ? 'alert' : 'check'} tone={r.data.warnings.length ? 'warn' : undefined} />
              <div style={{ flex: 1 }}>
                <h3>{r.data.warnings.length ? `${r.data.warnings.length} things to check` : 'Nothing else to check'}</h3>
                <ul className="issue-list">
                  {r.data.warnings.map((w, i) => <li key={i}><span className="badge badge-warn">Check</span>{w.message}</li>)}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
