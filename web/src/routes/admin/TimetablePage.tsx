import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScopePicker } from '../../components/ScopePicker.tsx';
import { Dialog, ErrorNotice, Field, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, ApiRequestError, qs, type Schemas } from '../../lib/api.ts';
import { addDaysIso, DAYS, formatDate, isoToday, mondayOf, useAdminList, useScope, type Row } from '../../lib/refs.ts';

type Entry = Schemas['TimetableEntry'];
type Session = Schemas['ClassSession'];

export function TimetablePage() {
  const scope = useScope();
  const [tab, setTab] = useState<'week' | 'dates'>('dates');
  return (
    <>
      <PageHead
        title="Timetable"
        subtitle="The weekly timetable repeats every week. Changes for a single day never alter it."
        actions={<a className="btn" href="/admin/timetable/import">Import timetable</a>}
      />
      <ScopePicker {...scope} />
      <div className="btn-row" role="tablist" style={{ marginBottom: '1rem' }}>
        <button role="tab" aria-selected={tab === 'dates'} className={`btn ${tab === 'dates' ? 'btn-primary' : ''}`} onClick={() => setTab('dates')}>
          Classes by date
        </button>
        <button role="tab" aria-selected={tab === 'week'} className={`btn ${tab === 'week' ? 'btn-primary' : ''}`} onClick={() => setTab('week')}>
          Weekly timetable
        </button>
      </div>
      {!scope.termId || !scope.sectionId ? (
        <Notice>Choose a term and section.</Notice>
      ) : tab === 'week' ? (
        <WeeklyView termId={scope.termId} sectionId={scope.sectionId} />
      ) : (
        <DatesView termId={scope.termId} sectionId={scope.sectionId} />
      )}
    </>
  );
}

function ClassCard(props: { title: string; lines: (string | null | undefined)[]; badges?: { text: string; tone?: string }[]; onClick?: () => void }) {
  return (
    <button className="class-card" onClick={props.onClick} disabled={!props.onClick}>
      <strong>{props.title}</strong>
      {props.lines.filter(Boolean).map((l) => (
        <span key={l} className="muted small">{l}</span>
      ))}
      {props.badges && props.badges.length > 0 && (
        <span className="btn-row" style={{ gap: 4 }}>
          {props.badges.map((b) => (
            <span key={b.text} className={`badge ${b.tone ?? ''}`}>{b.text}</span>
          ))}
        </span>
      )}
    </button>
  );
}

// ── Weekly (default) timetable ───────────────────────────────────────────────
function WeeklyView({ termId, sectionId }: { termId: string; sectionId: string }) {
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const entries = useQuery({
    queryKey: ['entries', termId, sectionId],
    queryFn: () => apiGet<{ items: Entry[] }>(`/v1/admin/timetable/entries${qs({ term_id: termId, section_id: sectionId })}`),
  });
  const items = entries.data?.items ?? [];
  const days = [1, 2, 3, 4, 5, 6].filter((d) => d <= 5 || items.some((e) => e.weekday === d));
  return (
    <>
      <div className="btn-row" style={{ marginBottom: '1rem' }}>
        <button className="btn" onClick={() => setEditing('new')}>Add weekly class</button>
      </div>
      <ErrorNotice error={entries.error} />
      <div className="week-grid">
        {days.map((d) => (
          <section key={d} className="day-col" aria-label={DAYS[d - 1]}>
            <h3>{DAYS[d - 1]}</h3>
            {items.filter((e) => e.weekday === d).map((e) => (
              <ClassCard
                key={e.id}
                title={`${e.start_time}–${e.end_time} · ${e.subject_code}`}
                lines={[e.group_name ?? 'Whole section', e.room ?? 'No room', e.teacher_name ?? null]}
                badges={e.teacher_name ? [] : [{ text: 'Teacher from assignments' }]}
                onClick={() => setEditing(e)}
              />
            ))}
            {!items.some((e) => e.weekday === d) && <p className="muted small">No classes</p>}
          </section>
        ))}
      </div>
      {editing && <EntryDialog termId={termId} sectionId={sectionId} entry={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EntryDialog(props: { termId: string; sectionId: string; entry: Entry | null; onClose: () => void }) {
  const qc = useQueryClient();
  const e = props.entry;
  const offerings = useAdminList('offerings', { term_id: props.termId, section_id: props.sectionId });
  const groups = useAdminList('groups', { section_id: props.sectionId });
  const rooms = useAdminList('rooms');
  const teachers = useAdminList('users', { role: 'teacher', status: 'active' });
  const [v, setV] = useState({
    offering_id: e?.offering_id ?? '',
    group_id: e?.group_id ?? '',
    weekday: String(e?.weekday ?? 1),
    start_time: e?.start_time ?? '09:30',
    end_time: e?.end_time ?? '10:30',
    room_id: e?.room_id ?? '',
    teacher_id: e?.teacher_id ?? '',
  });
  const set = (k: keyof typeof v) => (ev: { target: { value: string } }) => setV({ ...v, [k]: ev.target.value });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['entries'] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    props.onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        group_id: v.group_id || null,
        weekday: Number(v.weekday),
        start_time: v.start_time,
        end_time: v.end_time,
        room_id: v.room_id || null,
        teacher_id: v.teacher_id || null,
      };
      return e ? apiSend('PATCH', `/v1/admin/timetable/entries/${e.id}`, body) : apiSend('POST', '/v1/admin/timetable/entries', { ...body, offering_id: v.offering_id });
    },
    onSuccess: done,
  });
  const end = useMutation({ mutationFn: () => apiSend('DELETE', `/v1/admin/timetable/entries/${e!.id}`), onSuccess: done });
  const errs = save.error instanceof ApiRequestError ? save.error.fields : {};
  return (
    <Dialog
      open
      title={e ? `${e.subject_code} · ${DAYS[e.weekday - 1]}` : 'Add weekly class'}
      onClose={props.onClose}
      footer={
        <>
          {e && (
            <button className="btn btn-danger" style={{ marginRight: 'auto' }} disabled={end.isPending} onClick={() => window.confirm('Remove this class from the weekly timetable from today? Past classes are kept.') && end.mutate()}>
              Remove from timetable
            </button>
          )}
          <button className="btn btn-ghost" onClick={props.onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <div className="form">
        <ErrorNotice error={(save.error && !Object.keys(errs).length ? save.error : null) ?? end.error} />
        {e && <Notice>Changes apply to every week from today. To change a single day, use "Classes by date".</Notice>}
        {!e && (
          <Field label="Subject" error={errs.offering_id}>
            <select value={v.offering_id} onChange={set('offering_id')}>
              <option value="">Choose…</option>
              {(offerings.data ?? []).map((o: Row) => (
                <option key={o.id} value={o.id}>{o.subject_code} · {o.subject_name}</option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-grid">
          <Field label="Day">
            <select value={v.weekday} onChange={set('weekday')}>
              {DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </select>
          </Field>
          <Field label="Starts" error={errs.start_time}><input type="time" value={v.start_time} onChange={set('start_time')} /></Field>
          <Field label="Ends" error={errs.end_time}><input type="time" value={v.end_time} onChange={set('end_time')} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Who attends">
            <select value={v.group_id} onChange={set('group_id')}>
              <option value="">Whole section</option>
              {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} only</option>)}
            </select>
          </Field>
          <Field label="Room">
            <select value={v.room_id} onChange={set('room_id')}>
              <option value="">No room</option>
              {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
            </select>
          </Field>
          <Field label="Teacher" hint="Leave empty to use Teaching assignments">
            <select value={v.teacher_id} onChange={set('teacher_id')}>
              <option value="">From teaching assignments</option>
              {(teachers.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

// ── Classes by date (with one-day changes) ───────────────────────────────────
function DatesView({ termId, sectionId }: { termId: string; sectionId: string }) {
  const [monday, setMonday] = useState(() => mondayOf(isoToday()));
  const [changing, setChanging] = useState<Session | 'add' | null>(null);
  const to = addDaysIso(monday, 6);
  const sessions = useQuery({
    queryKey: ['sessions', sectionId, monday],
    queryFn: () => apiGet<{ items: Session[] }>(`/v1/admin/class-sessions${qs({ section_id: sectionId, from: monday, to })}`),
  });
  const items = sessions.data?.items ?? [];
  const dates = Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i)).filter((d, i) => i < 5 || items.some((s) => s.date === d));
  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={() => setMonday(addDaysIso(monday, -7))} aria-label="Previous week">←</button>
        <strong>{formatDate(monday)} – {formatDate(to)}</strong>
        <button className="btn" onClick={() => setMonday(addDaysIso(monday, 7))} aria-label="Next week">→</button>
        <button className="btn btn-ghost" onClick={() => setMonday(mondayOf(isoToday()))}>This week</button>
        <span className="spacer" />
        <button className="btn" onClick={() => setChanging('add')}>Add a one-off class</button>
      </div>
      <p className="muted small">Classes are scheduled 14 days ahead. Click a class to move or cancel it for that day only.</p>
      <ErrorNotice error={sessions.error} />
      <div className="week-grid">
        {dates.map((d) => (
          <section key={d} className="day-col" aria-label={d}>
            <h3>{formatDate(d)}</h3>
            {items.filter((s) => s.date === d).map((s) => (
              <ClassCard
                key={s.id}
                title={`${s.start}–${s.end} · ${s.subject.code}`}
                lines={[s.batch ?? 'Whole section', s.room ?? 'No room', s.teacher ?? 'No teacher']}
                badges={[
                  ...(s.status === 'cancelled' ? [{ text: 'Cancelled', tone: 'badge-bad' }] : []),
                  ...(s.changed && s.status !== 'cancelled' ? [{ text: 'Changed today', tone: 'badge-warn' }] : []),
                  ...(!s.teacher && s.status !== 'cancelled' ? [{ text: 'No teacher', tone: 'badge-warn' }] : []),
                ]}
                onClick={() => setChanging(s)}
              />
            ))}
            {!items.some((s) => s.date === d) && <p className="muted small">No classes</p>}
          </section>
        ))}
      </div>
      {changing && <OverrideDialog termId={termId} sectionId={sectionId} session={changing === 'add' ? null : changing} defaultDate={monday < isoToday() ? isoToday() : monday} onClose={() => setChanging(null)} />}
    </>
  );
}

function OverrideDialog(props: { termId: string; sectionId: string; session: Session | null; defaultDate: string; onClose: () => void }) {
  const qc = useQueryClient();
  const s = props.session;
  const rooms = useAdminList('rooms');
  const teachers = useAdminList('users', { role: 'teacher', status: 'active' });
  const offerings = useAdminList('offerings', { term_id: props.termId, section_id: props.sectionId });
  const groups = useAdminList('groups', { section_id: props.sectionId });
  const [v, setV] = useState({
    action: s ? 'modify' : 'add',
    date: s?.date ?? props.defaultDate,
    room_id: '',
    teacher_id: '',
    start: s?.start ?? '09:30',
    end: s?.end ?? '10:30',
    offering_id: '',
    group_id: '',
    reason: '',
    notify: true,
    notice: '',
  });
  const [needConfirm, setNeedConfirm] = useState(false);
  const set = (k: keyof typeof v) => (ev: { target: { value: string } }) => setV({ ...v, [k]: ev.target.value });
  // The weekly entry behind this session (null for one-off classes).
  const entry = s?.entry_id ? { id: s.entry_id } : undefined;
  const save = useMutation({
    mutationFn: (confirm: boolean) => {
      const body: Record<string, unknown> = { date: v.date, action: v.action, reason: v.reason, confirm, notify: v.notify, notice: v.notify && v.notice.trim() ? v.notice.trim() : null };
      if (v.action === 'add') Object.assign(body, { new_offering_id: v.offering_id, new_group_id: v.group_id || null, new_start: v.start, new_end: v.end, new_room_id: v.room_id || null, new_teacher_id: v.teacher_id || null });
      else {
        body.entry_id = entry?.id;
        if (v.action === 'modify') {
          if (v.room_id) body.new_room_id = v.room_id;
          if (v.teacher_id) body.new_teacher_id = v.teacher_id;
          if (v.start !== s?.start || v.end !== s?.end) Object.assign(body, { new_start: v.start, new_end: v.end });
        }
      }
      return apiSend('POST', '/v1/admin/timetable/overrides', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      props.onClose();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.code === 'session_has_attendance') setNeedConfirm(true);
    },
  });
  const errs = save.error instanceof ApiRequestError ? save.error.fields : {};
  return (
    <Dialog
      open
      title={s ? `${s.subject.code} on ${formatDate(s.date)}` : 'Add a one-off class'}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={props.onClose}>Close</button>
          {needConfirm ? (
            <button className="btn btn-danger" onClick={() => save.mutate(true)}>Change anyway</button>
          ) : (
            <button className="btn btn-primary" disabled={save.isPending || (Boolean(s) && !entry)} onClick={() => save.mutate(false)}>
              {v.action === 'cancel' ? 'Cancel this class' : 'Save change'}
            </button>
          )}
        </>
      }
    >
      <div className="form">
        {needConfirm && <Notice tone="warn">This class already has attendance. Changing it is recorded in the audit log.</Notice>}
        {save.error && !needConfirm && !Object.keys(errs).length ? <ErrorNotice error={save.error} /> : null}
        {s && (
          <p className="muted">
            {s.start}–{s.end} · {s.batch ?? 'Whole section'} · {s.room ?? 'No room'} · {s.teacher ?? 'No teacher'}
          </p>
        )}
        {s && (
          <Field label="What changes on this day?">
            <select value={v.action} onChange={set('action')}>
              <option value="modify">Move it (room, time or teacher)</option>
              <option value="cancel">Cancel it</option>
            </select>
          </Field>
        )}
        {!s && (
          <>
            <div className="form-grid">
              <Field label="Date" error={errs.date}><input type="date" value={v.date} onChange={set('date')} /></Field>
              <Field label="Subject" error={errs.new_offering_id}>
                <select value={v.offering_id} onChange={set('offering_id')}>
                  <option value="">Choose…</option>
                  {(offerings.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.subject_code} · {o.subject_name}</option>)}
                </select>
              </Field>
              <Field label="Who attends">
                <select value={v.group_id} onChange={set('group_id')}>
                  <option value="">Whole section</option>
                  {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} only</option>)}
                </select>
              </Field>
            </div>
          </>
        )}
        {v.action !== 'cancel' && (
          <div className="form-grid">
            <Field label="Starts" error={errs.new_start}><input type="time" value={v.start} onChange={set('start')} /></Field>
            <Field label="Ends" error={errs.new_end}><input type="time" value={v.end} onChange={set('end')} /></Field>
            <Field label="Room">
              <select value={v.room_id} onChange={set('room_id')}>
                <option value="">{s ? 'Same room' : 'No room'}</option>
                {(rooms.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
              </select>
            </Field>
            <Field label="Teacher">
              <select value={v.teacher_id} onChange={set('teacher_id')}>
                <option value="">{s ? 'Same teacher' : 'From teaching assignments'}</option>
                {(teachers.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          </div>
        )}
        <Field label="Reason (audit log only, not shown to students)" error={errs.reason}>
          <input value={v.reason} onChange={set('reason')} placeholder="e.g. Projector not working" />
        </Field>
        <label className="check">
          <input type="checkbox" checked={v.notify} onChange={(e) => setV({ ...v, notify: e.target.checked })} /> Tell the students and teachers of this class
        </label>
        {v.notify && (
          <Field label="Extra line for the notice" hint="Optional. The notice already says what changed.">
            <input value={v.notice} onChange={set('notice')} maxLength={300} placeholder="e.g. Bring your laptops" />
          </Field>
        )}
        {s && !entry && <Notice tone="warn">This is a one-off class; to remove it, undo the change that added it.</Notice>}
      </div>
    </Dialog>
  );
}
