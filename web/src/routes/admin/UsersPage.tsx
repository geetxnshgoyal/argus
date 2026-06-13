import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, type ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable } from '../../components/DataTable.tsx';
import { Dialog, ErrorNotice, Field, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, ApiRequestError, qs, type Schemas } from '../../lib/api.ts';
import { ROLE_LABELS, useMe, type Role } from '../../lib/auth.ts';

type User = Schemas['User'];
 
type Ref = { id: string; code?: string; name: string; section_id?: string };

type Kind = 'students' | 'teachers' | 'staff';
const KIND_ROLES: Record<Kind, Role[]> = { students: ['student'], teachers: ['teacher'], staff: ['acadops', 'verifier', 'admin'] };

function useRefList(path: string) {
  return useQuery({
    queryKey: ['refs', path],
    queryFn: async () => (await apiGet<{ items: Ref[] }>(`/v1/admin/${path}?limit=1000`)).items,
  });
}

export function UsersPage({ kind }: { kind: Kind }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'disabled'>('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const role = kind === 'staff' ? undefined : KIND_ROLES[kind][0];
  const sections = useRefList('sections');
  const groups = useRefList('groups');
  const departments = useRefList('departments');
  const list = useQuery({
    queryKey: ['admin', 'users', kind, q, status],
    queryFn: () => apiGet<Schemas['UserList']>(`/v1/admin/users${qs({ role, q, status, limit: 1000 })}`),
  });
  const items = (list.data?.items ?? []).filter((u) => KIND_ROLES[kind].includes(u.role));
  const nameOf = (rows: Ref[] | undefined, id: string | null | undefined) => rows?.find((r) => r.id === id)?.name ?? '—';

  const columns = useMemo(() => {
    const h = createColumnHelper<User>();
    const text = (id: string, header: string, fn: (u: User) => string | null | undefined) => h.accessor((u) => fn(u) ?? '—', { id, header });
    const cols = [];
    if (kind === 'students') cols.push(text('usn', 'USN', (u) => u.usn));
    if (kind === 'teachers') cols.push(text('faculty_id', 'Faculty ID', (u) => u.faculty_id));
    cols.push(text('name', 'Name', (u) => u.name), text('email', 'Email', (u) => u.email));
    if (kind === 'students') {
      cols.push(text('section', 'Section', (u) => nameOf(sections.data, u.section_id)), text('batch', 'Batch', (u) => nameOf(groups.data, u.group_id)));
    }
    if (kind === 'teachers') cols.push(text('dept', 'Department', (u) => nameOf(departments.data, u.department_id)));
    if (kind === 'staff') cols.push(text('role', 'Role', (u) => ROLE_LABELS[u.role]));
    cols.push(
      h.accessor('status', {
        header: 'Status',
        cell: (c) => {
          const u = c.row.original;
          return (
            <span className="btn-row">
              <span className={`badge ${u.status === 'active' ? 'badge-good' : 'badge-bad'}`}>{u.status === 'active' ? 'Active' : 'Disabled'}</span>
              {u.sso_linked ? <span className="badge">Signed in before</span> : null}
            </span>
          );
        },
      }),
      h.display({
        id: 'actions',
        header: '',
        cell: (c) => (
          <button className="btn btn-ghost" onClick={() => setEditing(c.row.original)}>
            Edit
          </button>
        ),
      }),
    );
    return cols as ColumnDef<User, unknown>[];
  }, [kind, sections.data, groups.data, departments.data]);

  const title = kind === 'students' ? 'Students' : kind === 'teachers' ? 'Teachers' : 'Staff';
  const canEditStaff = me?.user.role === 'admin';
  return (
    <>
      <PageHead
        title={title}
        subtitle={
          kind === 'students'
            ? 'Students sign in to the Argus app with their college Google account.'
            : kind === 'teachers'
              ? 'Teachers run attendance from the Argus website.'
              : 'Academic Operations, verifiers and administrators. Only administrators can change staff roles.'
        }
        actions={
          kind !== 'staff' || canEditStaff ? (
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              Add {kind === 'students' ? 'student' : kind === 'teachers' ? 'teacher' : 'staff member'}
            </button>
          ) : null
        }
      />
      <div className="toolbar">
        <input type="search" placeholder={kind === 'students' ? 'Search name, email or USN' : 'Search name or email'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <span className="muted small">{items.length} shown</span>
      </div>
      <ErrorNotice error={list.error} />
      <DataTable data={items} columns={columns} loading={list.isPending} empty={`No ${title.toLowerCase()} yet.`} />
      {editing && (
        <UserForm
          kind={kind}
          user={editing === 'new' ? null : editing}
          refs={{ sections: sections.data ?? [], groups: groups.data ?? [], departments: departments.data ?? [] }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
          }}
        />
      )}
    </>
  );
}

function UserForm(props: {
  kind: Kind;
  user: User | null;
  refs: { sections: Ref[]; groups: Ref[]; departments: Ref[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { kind, user, refs } = props;
  const programs = useRefList('programs');
  const [v, setV] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    status: user?.status ?? 'active',
    role: (user?.role ?? (kind === 'staff' ? 'acadops' : KIND_ROLES[kind][0])) as Role,
    usn: user?.usn ?? '',
    program_id: user?.program_id ?? '',
    section_id: user?.section_id ?? '',
    group_id: user?.group_id ?? '',
    admission_year: String(user?.admission_year ?? new Date().getFullYear()),
    faculty_id: user?.faculty_id ?? '',
    department_id: user?.department_id ?? '',
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: v.name, email: v.email, status: v.status };
      if (!user || user.role !== v.role) body.role = v.role;
      if (kind === 'students') {
        body.student = {
          usn: v.usn,
          program_id: v.program_id,
          section_id: v.section_id || null,
          group_id: v.group_id || null,
          admission_year: Number(v.admission_year),
        };
      }
      if (kind === 'teachers') body.teacher = { faculty_id: v.faculty_id, department_id: v.department_id };
      return user ? apiSend('PATCH', `/v1/admin/users/${user.id}`, body) : apiSend('POST', '/v1/admin/users', body);
    },
    onSuccess: props.onSaved,
    onError: (e) => {
      if (e instanceof ApiRequestError && e.code === 'reauth_required') {
        window.location.assign(`/v1/auth/oidc/login?reauth=1&next=${encodeURIComponent(window.location.pathname)}`);
      }
    },
  });
  const errs = save.error instanceof ApiRequestError ? save.error.fields : {};
  const sectionGroups = refs.groups.filter((g) => g.section_id === v.section_id);

  return (
    <Dialog
      open
      title={user ? `Edit ${user.name}` : 'Add person'}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form">
        {save.error && !Object.keys(errs).length ? <ErrorNotice error={save.error} /> : null}
        <div className="form-grid">
          <Field label="Full name" error={errs.name}>
            <input value={v.name} onChange={set('name')} />
          </Field>
          <Field label="College email" error={errs.email} hint="Their college Google account">
            <input type="email" value={v.email} onChange={set('email')} />
          </Field>
        </div>
        {kind === 'students' && (
          <>
            <div className="form-grid">
              <Field label="USN" error={errs['student.usn']}>
                <input value={v.usn} onChange={set('usn')} />
              </Field>
              <Field label="Admission year" error={errs['student.admission_year']}>
                <input type="number" value={v.admission_year} onChange={set('admission_year')} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Program" error={errs['student.program_id']}>
                <select value={v.program_id} onChange={set('program_id')}>
                  <option value="">Choose…</option>
                  {(programs.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Section">
                <select value={v.section_id} onChange={(e) => setV({ ...v, section_id: e.target.value, group_id: '' })}>
                  <option value="">None</option>
                  {refs.sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lab batch">
                <select value={v.group_id} onChange={set('group_id')} disabled={!v.section_id}>
                  <option value="">None</option>
                  {sectionGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </>
        )}
        {kind === 'teachers' && (
          <div className="form-grid">
            <Field label="Faculty ID" error={errs['teacher.faculty_id']}>
              <input value={v.faculty_id} onChange={set('faculty_id')} />
            </Field>
            <Field label="Department" error={errs['teacher.department_id']}>
              <select value={v.department_id} onChange={set('department_id')}>
                <option value="">Choose…</option>
                {refs.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        <div className="form-grid">
          {kind === 'staff' && (
            <Field label="Role">
              <select value={v.role} onChange={set('role')}>
                {(['acadops', 'verifier', 'admin'] as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Status" hint={v.status === 'disabled' ? 'Disabled accounts are signed out everywhere and cannot sign in.' : undefined}>
            <select value={v.status} onChange={set('status')}>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
