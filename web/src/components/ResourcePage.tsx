import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState, type ReactNode } from 'react';
import { apiGet, apiSend, ApiRequestError, qs } from '../lib/api.ts';
import { DataTable } from './DataTable.tsx';
import { Dialog, ErrorNotice, Field, PageHead } from './ui.tsx';

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are generic JSON */
type Row = Record<string, any> & { id: string };

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'ref';
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  /** For type 'ref': admin resource to pick from and how to label it. */
  ref?: { path: string; label: (r: Row) => string; filter?: Record<string, string> };
  /** Shown only when creating (e.g. parent ids that can't change later). */
  createOnly?: boolean;
  nullable?: boolean;
}

export interface ResourceConfig {
  path: string;
  title: string;
  subtitle: string;
  singular: string;
  columns: { key: string; label: string; render?: (r: Row, refs: RefMaps) => ReactNode }[];
  fields: FieldDef[];
  /** Fixed filters (e.g. section_id) applied to list and create. */
  fixed?: Record<string, string>;
}

type RefMaps = Record<string, Map<string, Row>>;

function useRefs(fields: FieldDef[]): RefMaps {
  const refFields = fields.filter((f) => f.type === 'ref' && f.ref);
  const results = useQuery({
    queryKey: ['refs', refFields.map((f) => f.ref!.path + JSON.stringify(f.ref!.filter ?? {}))],
    queryFn: async () => {
      const out: RefMaps = {};
      for (const f of refFields) {
        const list = await apiGet<{ items: Row[] }>(`/v1/admin/${f.ref!.path}${qs({ limit: 1000, ...(f.ref!.filter ?? {}) })}`);
        out[f.key] = new Map(list.items.map((r) => [r.id, r]));
      }
      return out;
    },
    enabled: refFields.length > 0,
  });
  return results.data ?? {};
}

export function refLabel(refs: RefMaps, field: FieldDef | undefined, id: unknown): string {
  if (!id || !field?.ref) return '—';
  const r = refs[field.key]?.get(String(id));
  return r ? field.ref.label(r) : '…';
}

export function ResourcePage({ config }: { config: ResourceConfig }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const refs = useRefs(config.fields);
  const listKey = ['admin', config.path, q, config.fixed];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => apiGet<{ items: Row[]; total: number }>(`/v1/admin/${config.path}${qs({ q, limit: 500, ...(config.fixed ?? {}) })}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/v1/admin/${config.path}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', config.path] }),
  });

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () => [
      ...config.columns.map(
        (c): ColumnDef<Row, unknown> => ({
          id: c.key,
          header: c.label,
          accessorFn: (r) => r[c.key],
          cell: (ctx) => {
            const r = ctx.row.original;
            if (c.render) return c.render(r, refs);
            const f = config.fields.find((x) => x.key === c.key);
            if (f?.type === 'ref') return refLabel(refs, f, r[c.key]);
            if (f?.type === 'select') return f.options?.find((o) => o.value === r[c.key])?.label ?? r[c.key];
            return r[c.key] ?? '—';
          },
        }),
      ),
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: (ctx) => (
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setEditing(ctx.row.original)}>
              Edit
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                if (window.confirm(`Delete this ${config.singular.toLowerCase()}? This cannot be undone.`)) remove.mutate(ctx.row.original.id);
              }}
            >
              Delete
            </button>
          </div>
        ),
      },
    ],
    [config, refs, remove],
  );

  return (
    <>
      <PageHead
        title={config.title}
        subtitle={config.subtitle}
        actions={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            Add {config.singular.toLowerCase()}
          </button>
        }
      />
      <div className="toolbar">
        <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {list.data && <span className="muted small">{list.data.total} total</span>}
      </div>
      <ErrorNotice error={list.error ?? remove.error} />
      <DataTable data={list.data?.items ?? []} columns={columns} loading={list.isPending} empty={`No ${config.title.toLowerCase()} yet.`} />
      {editing && (
        <ResourceForm
          config={config}
          refs={refs}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['admin', config.path] });
            void qc.invalidateQueries({ queryKey: ['refs'] });
          }}
        />
      )}
    </>
  );
}

function ResourceForm(props: { config: ResourceConfig; refs: RefMaps; row: Row | null; onClose: () => void; onSaved: () => void }) {
  const { config, refs, row } = props;
  const fields = config.fields.filter((f) => !(row && f.createOnly));
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, row?.[f.key] === null || row?.[f.key] === undefined ? '' : String(row[f.key])])),
  );
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...(row ? {} : (config.fixed ?? {})) };
      for (const f of fields) {
        const v = values[f.key] ?? '';
        if (v === '') {
          if (row && (f.nullable || !f.required)) body[f.key] = f.type === 'text' ? '' : null;
          if (!row && f.nullable) body[f.key] = null;
          continue;
        }
        body[f.key] = f.type === 'number' ? Number(v) : v;
      }
      return row ? apiSend('PATCH', `/v1/admin/${config.path}/${row.id}`, body) : apiSend('POST', `/v1/admin/${config.path}`, body);
    },
    onSuccess: props.onSaved,
  });
  const fieldErrors = save.error instanceof ApiRequestError ? save.error.fields : {};

  return (
    <Dialog
      open
      title={row ? `Edit ${config.singular.toLowerCase()}` : `Add ${config.singular.toLowerCase()}`}
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
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.error && !Object.keys(fieldErrors).length ? <ErrorNotice error={save.error} /> : null}
        {fields.map((f) => (
          <Field key={f.key} label={f.label + (f.required ? '' : ' (optional)')} hint={f.hint} error={fieldErrors[f.key]}>
            {f.type === 'select' || f.type === 'ref' ? (
              <select
                value={values[f.key]}
                aria-invalid={Boolean(fieldErrors[f.key])}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              >
                <option value="">{f.required ? 'Choose…' : 'None'}</option>
                {(f.type === 'select'
                  ? (f.options ?? [])
                  : [...(refs[f.key]?.values() ?? [])].map((r) => ({ value: r.id, label: f.ref!.label(r) }))
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                value={values[f.key]}
                aria-invalid={Boolean(fieldErrors[f.key])}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
