import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScopePicker } from '../../components/ScopePicker.tsx';
import { ErrorNotice, Field, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, ApiRequestError, qs, type Schemas } from '../../lib/api.ts';
import { DAYS, formatDate, useScope } from '../../lib/refs.ts';

type Day = Schemas['CalendarDay'];
const KIND_LABEL: Record<Day['kind'], string> = { holiday: 'Holiday', exam: 'Exams (no classes)', no_classes: 'No classes', working: 'Working day' };

export function CalendarPage() {
  const scope = useScope();
  const qc = useQueryClient();
  const [v, setV] = useState({ date: '', kind: 'holiday' as Day['kind'], follows: '', note: '' });
  const days = useQuery({
    queryKey: ['calendar', scope.termId],
    queryFn: () => apiGet<{ items: Day[] }>(`/v1/admin/timetable/calendar${qs({ term_id: scope.termId })}`),
    enabled: Boolean(scope.termId),
  });
  const save = useMutation({
    mutationFn: () =>
      apiSend('PUT', `/v1/admin/timetable/calendar/${scope.termId}/${v.date}`, {
        kind: v.kind,
        follows_weekday: v.kind === 'working' && v.follows ? Number(v.follows) : null,
        note: v.note,
      }),
    onSuccess: () => {
      setV({ date: '', kind: 'holiday', follows: '', note: '' });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const remove = useMutation({
    mutationFn: (date: string) => apiSend('DELETE', `/v1/admin/timetable/calendar/${scope.termId}/${date}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['calendar'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const errs = save.error instanceof ApiRequestError ? save.error.fields : {};
  return (
    <>
      <PageHead title="Holidays & special days" subtitle='Declare holidays and exam days, or make a day follow another weekday (e.g. "Saturday follows Monday").' />
      <ScopePicker {...scope} needSection={false} />
      {!scope.termId ? (
        <Notice>Choose a term.</Notice>
      ) : (
        <>
          <div className="card">
            <h3>Add a special day</h3>
            <div className="form-grid" style={{ marginTop: '0.75rem' }}>
              <Field label="Date" error={errs.date}><input type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
              <Field label="What happens">
                <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as Day['kind'] })}>
                  <option value="holiday">Holiday: no classes</option>
                  <option value="exam">Exams: no classes</option>
                  <option value="no_classes">No classes (other reason)</option>
                  <option value="working">Classes follow another day's timetable</option>
                </select>
              </Field>
              {v.kind === 'working' && (
                <Field label="Follow the timetable of" error={errs.follows_weekday}>
                  <select value={v.follows} onChange={(e) => setV({ ...v, follows: e.target.value })}>
                    <option value="">Choose…</option>
                    {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Note"><input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. Ganesh Chaturthi" /></Field>
            </div>
            <div className="btn-row" style={{ marginTop: '1rem' }}>
              <button className="btn btn-primary" disabled={!v.date || save.isPending} onClick={() => save.mutate()}>Save</button>
            </div>
            {save.error && !Object.keys(errs).length ? <ErrorNotice error={save.error} /> : null}
          </div>
          <div className="card">
            <h3>Special days this term</h3>
            <ErrorNotice error={days.error ?? remove.error} />
            {(days.data?.items.length ?? 0) === 0 ? (
              <p className="muted">None yet. Every day follows the weekly timetable.</p>
            ) : (
              <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
                {days.data?.items.map((d) => (
                  <li key={d.date}>
                    <strong style={{ minWidth: '9rem' }}>{formatDate(d.date)}</strong>
                    <span style={{ flex: 1 }}>
                      {d.kind === 'working' && d.follows_weekday ? `Follows ${DAYS[d.follows_weekday - 1]}'s timetable` : KIND_LABEL[d.kind]}
                      {d.note ? <span className="muted"> · {d.note}</span> : null}
                    </span>
                    <button className="btn btn-ghost" onClick={() => remove.mutate(d.date)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}
