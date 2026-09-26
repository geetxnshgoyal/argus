import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScopePicker } from '../../components/ScopePicker.tsx';
import { ErrorNotice, Field, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, ApiRequestError, type Schemas } from '../../lib/api.ts';
import { formatDate, useAdminList, useScope } from '../../lib/refs.ts';

type OpsNotice = Schemas['OpsNotice'];
type Audience = Schemas['NoticeAudience'];
type Who = 'everyone' | 'students' | 'teachers' | 'section' | 'offering';

const WHO_LABEL: Record<Who, string> = {
  everyone: 'Everyone (students and teachers)',
  students: 'All students',
  teachers: 'All teachers',
  section: 'One section',
  offering: 'One subject’s class',
};

/** Announcements from Academic Operations, and the class-change notices sent automatically (ADR-0023). */
export function NoticesPage() {
  const scope = useScope();
  const qc = useQueryClient();
  const [v, setV] = useState({ title: '', body: '', who: 'students' as Who, offering: '', group: '' });
  const [sent, setSent] = useState<string | null>(null);
  const offerings = useAdminList('offerings', { term_id: scope.termId, section_id: scope.sectionId }, v.who === 'offering' && Boolean(scope.sectionId));
  const groups = useAdminList('groups', { section_id: scope.sectionId }, Boolean(scope.sectionId));

  const audience: Audience | null =
    v.who === 'section'
      ? scope.sectionId
        ? { kind: 'section', section_id: scope.sectionId, group_id: v.group || null }
        : null
      : v.who === 'offering'
        ? v.offering
          ? { kind: 'offering', offering_id: v.offering, group_id: v.group || null }
          : null
        : { kind: v.who };

  const reach = useQuery({
    queryKey: ['notice-audience', audience],
    queryFn: () => apiSend<{ label: string; students: number; teachers: number }>('POST', '/v1/admin/notices/audience', { audience }),
    enabled: audience !== null,
  });
  const list = useQuery({ queryKey: ['notices'], queryFn: () => apiGet<{ items: OpsNotice[] }>('/v1/admin/notices'), refetchInterval: 30_000 });
  const post = useMutation({
    mutationFn: () => apiSend<{ recipients: number; students: number; teachers: number }>('POST', '/v1/admin/notices', { title: v.title, body: v.body, audience }),
    onSuccess: (r) => {
      setSent(`Sent to ${people(r.students, r.teachers)}.`);
      setV({ ...v, title: '', body: '' });
      void qc.invalidateQueries({ queryKey: ['notices'] });
    },
  });
  const errs = post.error instanceof ApiRequestError ? post.error.fields : {};
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setSent(null);
    setV({ ...v, [k]: e.target.value, ...(k === 'who' ? { offering: '', group: '' } : {}) });
  };

  return (
    <>
      <PageHead
        title="Notices"
        subtitle="Tell students and teachers about changes. They see notices in the Argus app and on the teacher home page. Class cancellations and moves made in the timetable are announced automatically."
      />
      <div className="card">
        <h3>New notice</h3>
        <div className="form" style={{ marginTop: '0.75rem' }}>
          <Field label="Who should see it">
            <select value={v.who} onChange={set('who')}>
              {(Object.keys(WHO_LABEL) as Who[]).map((w) => (
                <option key={w} value={w}>{WHO_LABEL[w]}</option>
              ))}
            </select>
          </Field>
          {(v.who === 'section' || v.who === 'offering') && (
            <>
              <ScopePicker {...scope} setSectionId={(id) => { scope.setSectionId(id); setV({ ...v, offering: '', group: '' }); }} />
              <div className="form-grid">
                {v.who === 'offering' && (
                  <Field label="Subject">
                    <select value={v.offering} onChange={set('offering')} disabled={!scope.sectionId}>
                      <option value="">Choose…</option>
                      {(offerings.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.subject_code} · {o.subject_name}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Lab batch">
                  <select value={v.group} onChange={set('group')} disabled={!scope.sectionId}>
                    <option value="">Whole section</option>
                    {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} only</option>)}
                  </select>
                </Field>
              </div>
            </>
          )}
          <Field label="Title" error={errs.title}>
            <input value={v.title} onChange={set('title')} maxLength={120} placeholder="e.g. AP lab moves to Classroom 4 from Monday" />
          </Field>
          <Field label="Message" hint="Optional" error={errs.body}>
            <textarea value={v.body} onChange={set('body')} rows={4} maxLength={2000} placeholder="Anything students or teachers need to know." />
          </Field>
          {reach.data && (
            <p className="muted">
              {reach.data.label}: reaches {people(reach.data.students, reach.data.teachers)}.
            </p>
          )}
          <ErrorNotice error={reach.error} />
          {post.error && !Object.keys(errs).length ? <ErrorNotice error={post.error} /> : null}
          {sent && <Notice tone="good">{sent}</Notice>}
          <div className="btn-row">
            <button
              className="btn btn-primary"
              disabled={!audience || v.title.trim().length < 3 || post.isPending || (reach.data !== undefined && reach.data.students + reach.data.teachers === 0)}
              onClick={() => post.mutate()}
            >
              {post.isPending ? 'Sending…' : 'Send notice'}
            </button>
          </div>
        </div>
      </div>
      <div className="card">
        <h3>Recent notices</h3>
        <ErrorNotice error={list.error} />
        {list.isSuccess && list.data.items.length === 0 && <p className="muted">Nothing sent yet.</p>}
        <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
          {(list.data?.items ?? []).map((n) => <SentNotice key={n.id} n={n} />)}
        </ul>
      </div>
    </>
  );
}

function SentNotice({ n }: { n: OpsNotice }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const withdraw = useMutation({
    mutationFn: () => apiSend('DELETE', `/v1/admin/notices/${n.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notices'] }),
  });
  return (
    <li style={{ alignItems: 'flex-start', opacity: n.withdrawn_at ? 0.6 : 1 }}>
      <div style={{ flex: 1 }}>
        <div>
          <span className={`badge ${n.kind === 'class_change' ? 'badge-warn' : ''}`}>{n.kind === 'class_change' ? 'Class change' : 'Announcement'}</span>{' '}
          <strong>{n.title}</strong>
        </div>
        {n.body && <p style={{ whiteSpace: 'pre-wrap', margin: '0.35rem 0' }}>{n.body}</p>}
        <p className="muted small">
          {n.audience_label} · {new Date(n.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          {n.created_by_name ? ` · ${n.created_by_name}` : ''}
          {n.class_date ? ` · for ${formatDate(n.class_date)}` : ''} · read by {n.read} of {n.recipients}
        </p>
        <ErrorNotice error={withdraw.error} />
      </div>
      {n.withdrawn_at ? (
        <span className="badge">Withdrawn</span>
      ) : confirming ? (
        <span className="btn-row">
          <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Keep</button>
          <button className="btn btn-danger" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw for everyone</button>
        </span>
      ) : (
        <button className="btn btn-ghost" onClick={() => setConfirming(true)}>Withdraw</button>
      )}
    </li>
  );
}

function people(students: number, teachers: number): string {
  const part = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!teachers) return part(students, 'student', 'students');
  if (!students) return part(teachers, 'teacher', 'teachers');
  return `${part(students, 'student', 'students')} and ${part(teachers, 'teacher', 'teachers')}`;
}
