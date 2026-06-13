import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, Field, Icon, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, type Schemas } from '../../lib/api.ts';
import { parseRoster, type ParseResult } from '../../lib/importParse.ts';

type Report = Schemas['StudentImportReport'];
type Ref = { id: string; name: string; program_id?: string };

const ACTION_LABEL: Record<Report['rows'][number]['action'], string> = {
  create: 'New',
  update: 'Update',
  unchanged: 'No change',
  error: 'Needs fixing',
};

export function StudentImportPage() {
  const qc = useQueryClient();
  const programs = useQuery({ queryKey: ['refs', 'programs'], queryFn: async () => (await apiGet<{ items: Ref[] }>('/v1/admin/programs?limit=1000')).items });
  const sections = useQuery({ queryKey: ['refs', 'sections'], queryFn: async () => (await apiGet<{ items: Ref[] }>('/v1/admin/sections?limit=1000')).items });
  const [programId, setProgramId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [file, setFile] = useState<{ name: string; parsed: ParseResult } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [done, setDone] = useState<Report | null>(null);

  const body = () => ({ program_id: programId, section_id: sectionId, admission_year: Number(year), rows: file?.parsed.rows ?? [] });
  const check = useMutation({ mutationFn: () => apiSend<Report>('POST', '/v1/admin/students/import?dry_run=true', body()), onSuccess: setReport });
  const commit = useMutation({
    mutationFn: () => apiSend<Report>('POST', '/v1/admin/students/import?dry_run=false', body()),
    onSuccess: (r) => {
      setDone(r);
      setReport(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      void qc.invalidateQueries({ queryKey: ['refs'] });
    },
  });

  async function onFile(f: File | undefined) {
    setReport(null);
    setDone(null);
    setParseError(null);
    setFile(null);
    if (!f) return;
    try {
      setFile({ name: f.name, parsed: parseRoster(f.name, await f.text()) });
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'This file could not be read.');
    }
  }

  const sectionOptions = (sections.data ?? []).filter((s) => !programId || s.program_id === programId);
  const ready = Boolean(programId && sectionId && file && Number(year) > 1990);
  const s = report?.summary;

  return (
    <>
      <PageHead title="Import students" subtitle="Upload the student list as CSV or the existing system's JSON export. You'll see exactly what will change before anything is saved." />

      <div className="card">
        <div className="card-row">
          <IconTile name="upload" />
          <div style={{ flex: 1 }}>
            <h3>1. Choose the class and the file</h3>
            <div className="form-grid" style={{ marginTop: '1rem' }}>
              <Field label="Program">
                <select value={programId} onChange={(e) => { setProgramId(e.target.value); setSectionId(''); setReport(null); }}>
                  <option value="">Choose…</option>
                  {(programs.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Section">
                <select value={sectionId} onChange={(e) => { setSectionId(e.target.value); setReport(null); }}>
                  <option value="">Choose…</option>
                  {sectionOptions.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Admission year" hint="Year these students joined">
                <input type="number" value={year} onChange={(e) => { setYear(e.target.value); setReport(null); }} />
              </Field>
            </div>
            <div style={{ marginTop: '1rem' }}>
              <Field label="Student file (.csv or .json)" hint="CSV columns: USN, Name, Email, Batch, Status. Batches are created automatically.">
                <input type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
              </Field>
            </div>
            {parseError && <Notice tone="bad">{parseError}</Notice>}
            {file && (
              <Notice tone="good">
                <strong>{file.parsed.rows.length} students</strong> found in {file.name}. Only USN, name, college email, batch and status are
                sent to Argus.
                {file.parsed.ignored.length > 0 && (
                  <span className="muted"> Other fields stay on this computer and are not uploaded ({file.parsed.ignored.length} ignored, e.g. {file.parsed.ignored.slice(0, 4).join(', ')}).</span>
                )}
              </Notice>
            )}
            <div className="btn-row" style={{ marginTop: '0.5rem' }}>
              <button className="btn btn-primary" disabled={!ready || check.isPending} onClick={() => check.mutate()}>
                {check.isPending ? 'Checking…' : 'Check file'}
              </button>
            </div>
            <ErrorNotice error={check.error} />
          </div>
        </div>
      </div>

      {done && (
        <div className="card">
          <div className="card-row">
            <IconTile name="check" />
            <div>
              <h3 className="ok-text">Import complete</h3>
              <p className="muted">
                {done.summary.create} added, {done.summary.update} updated, {done.summary.unchanged} unchanged
                {done.summary.disabled ? `, ${done.summary.disabled} marked as left (disabled)` : ''}.
              </p>
            </div>
          </div>
        </div>
      )}

      {report && s && (
        <div className="card">
          <div className="card-row">
            <IconTile name={s.error ? 'alert' : 'check'} tone={s.error ? 'bad' : undefined} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3>2. Review</h3>
              <div className="btn-row" style={{ margin: '0.5rem 0 1rem' }}>
                <span className="badge badge-good">{s.create} new</span>
                <span className="badge">{s.update} to update</span>
                <span className="badge">{s.unchanged} unchanged</span>
                {s.disabled > 0 && <span className="badge badge-warn">{s.disabled} left (will be disabled)</span>}
                {s.error > 0 && <span className="badge badge-bad">{s.error} need fixing</span>}
              </div>
              {report.groups_to_create.length > 0 && <p className="muted">New batches will be created: {report.groups_to_create.join(', ')}.</p>}
              {s.error > 0 && <Notice tone="bad">Fix the rows marked "Needs fixing" in your file, then choose the file again.</Notice>}
              <div className="table-wrap" style={{ maxHeight: '28rem' }}>
                <table>
                  <thead>
                    <tr><th>Line</th><th>USN</th><th>Name</th><th>Result</th><th>Details</th></tr>
                  </thead>
                  <tbody>
                    {[...report.rows]
                      .sort((a, b) => Number(b.action === 'error') - Number(a.action === 'error'))
                      .map((r) => (
                        <tr key={r.line}>
                          <td>{r.line}</td>
                          <td className="mono">{r.usn || '—'}</td>
                          <td>{r.name || '—'}</td>
                          <td>
                            <span className={`badge ${r.action === 'error' ? 'badge-bad' : r.action === 'create' ? 'badge-good' : ''}`}>{ACTION_LABEL[r.action]}</span>
                            {r.status === 'disabled' && r.action !== 'error' && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Left</span>}
                          </td>
                          <td className={r.errors ? 'bad-text' : 'muted'}>{r.errors?.join('; ') ?? (r.changes ? `Changes: ${r.changes.join(', ')}` : '')}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="btn-row" style={{ marginTop: '1rem' }}>
                <button className="btn btn-primary" disabled={s.error > 0 || commit.isPending || s.create + s.update === 0} onClick={() => commit.mutate()}>
                  <Icon name="upload" size={18} />
                  {commit.isPending ? 'Importing…' : `Import ${s.create + s.update} students`}
                </button>
              </div>
              <ErrorNotice error={commit.error} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
