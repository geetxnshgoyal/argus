import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScopePicker } from '../../components/ScopePicker.tsx';
import { ErrorNotice, Field, IconTile, Notice, PageHead } from '../../components/ui.tsx';
import { apiSend, type Schemas } from '../../lib/api.ts';
import { fileToBase64, useScope } from '../../lib/refs.ts';

type Report = Schemas['TimetableImportReport'];

export function TimetableImportPage() {
  const qc = useQueryClient();
  const scope = useScope();
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [done, setDone] = useState<Report | null>(null);
  const body = () => ({
    term_id: scope.termId,
    section_id: scope.sectionId,
    xlsx_base64: file?.b64,
    ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
  });
  const check = useMutation({ mutationFn: () => apiSend<Report>('POST', '/v1/admin/timetable/import?dry_run=true', body()), onSuccess: (r) => { setReport(r); setDone(null); } });
  const commit = useMutation({
    mutationFn: () => apiSend<Report>('POST', '/v1/admin/timetable/import?dry_run=false', body()),
    onSuccess: (r) => {
      setDone(r);
      setReport(null);
      void qc.invalidateQueries();
    },
  });
  const s = report?.summary;
  const errors = report?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = report?.issues.filter((i) => i.level === 'warning') ?? [];

  return (
    <>
      <PageHead
        title="Import timetable"
        subtitle="Upload the timetable sheet exactly as it is (download it from Google Sheets as .xlsx). You'll see every change before it is saved."
        actions={<a className="btn" href="/samples/timetable-example.xlsx" download>Download an example</a>}
      />
      <div className="card">
        <div className="card-row">
          <IconTile name="calendar" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3>1. Choose the section and the file</h3>
            <ScopePicker {...scope} />
            <div className="form-grid">
              <Field label="Timetable file (.xlsx)" hint="Day headings (MONDAY…), a time row, and one row per batch. Merge a cell across all batches for whole-class lectures.">
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    setReport(null);
                    setDone(null);
                    setFile(f ? { name: f.name, b64: await fileToBase64(f) } : null);
                  }}
                />
              </Field>
              <Field label="Starts from (optional)" hint="Defaults to today. Earlier weeks keep the old timetable.">
                <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
              </Field>
            </div>
            <div className="btn-row" style={{ marginTop: '1rem' }}>
              <button className="btn btn-primary" disabled={!scope.termId || !scope.sectionId || !file || check.isPending} onClick={() => check.mutate()}>
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
              <h3 className="ok-text">Timetable imported</h3>
              <p className="muted">
                {done.summary.new} classes added, {done.summary.unchanged} unchanged, {done.summary.ended} removed from {done.effective_from}.{' '}
                {done.summary.sessions_scheduled} upcoming classes scheduled.
              </p>
              {done.teacherless.length > 0 && (
                <Notice tone="warn">
                  Next step: assign teachers for {done.teacherless.join(', ')} under <a href="/admin/teaching-assignments">Teaching assignments</a>.
                </Notice>
              )}
            </div>
          </div>
        </div>
      )}

      {report && s && (
        <div className="card">
          <div className="card-row">
            <IconTile name={s.errors ? 'alert' : 'check'} tone={s.errors ? 'bad' : undefined} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3>2. Review</h3>
              <div className="btn-row" style={{ margin: '0.5rem 0 1rem' }}>
                <span className="badge">{s.classes} classes in the file</span>
                <span className="badge badge-good">{s.new} new</span>
                <span className="badge">{s.unchanged} unchanged</span>
                {s.ended > 0 && <span className="badge badge-warn">{s.ended} removed</span>}
                {s.errors > 0 && <span className="badge badge-bad">{s.errors} problems</span>}
                {s.warnings > 0 && <span className="badge badge-warn">{s.warnings} warnings</span>}
              </div>
              {errors.length > 0 && (
                <>
                  <Notice tone="bad">Fix these in the sheet, then choose the file again.</Notice>
                  <ul className="issue-list">
                    {errors.map((i, n) => (
                      <li key={n}><span className="badge badge-bad">{i.ref}</span><span>{i.message}</span></li>
                    ))}
                  </ul>
                </>
              )}
              {(report.create.subjects.length > 0 || report.create.rooms.length > 0 || report.create.batches.length > 0) && (
                <div style={{ margin: '1rem 0' }}>
                  <h3>Will be created</h3>
                  {report.create.subjects.length > 0 && (
                    <p className="muted">Subjects: {report.create.subjects.map((x) => x.code).join(', ')} <span className="small">(rename them later under Subjects)</span></p>
                  )}
                  {report.create.rooms.length > 0 && <p className="muted">Rooms: {report.create.rooms.join(', ')}</p>}
                  {report.create.batches.length > 0 && <p className="muted">Batches: {report.create.batches.join(', ')}</p>}
                </div>
              )}
              {warnings.length > 0 && (
                <details style={{ margin: '1rem 0' }}>
                  <summary>{warnings.length} warnings (import can go ahead)</summary>
                  <ul className="issue-list" style={{ marginTop: '0.75rem' }}>
                    {warnings.map((i, n) => (
                      <li key={n}><span className="badge badge-warn">{i.ref}</span><span>{i.message}</span></li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>All classes found ({report.classes.length})</summary>
                <div className="table-wrap" style={{ marginTop: '0.75rem', maxHeight: '26rem' }}>
                  <table>
                    <thead><tr><th>Day</th><th>Time</th><th>Subject</th><th>Who</th><th>Room</th><th>Change</th></tr></thead>
                    <tbody>
                      {report.classes.map((c, n) => (
                        <tr key={n}>
                          <td>{c.day}</td>
                          <td>{c.start}–{c.end}</td>
                          <td>{c.subject}</td>
                          <td>{c.batch ?? 'Whole section'}</td>
                          <td>{c.room ?? '—'}</td>
                          <td><span className={`badge ${c.status === 'new' ? 'badge-good' : ''}`}>{c.status === 'new' ? 'New' : 'Same'}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <div className="btn-row" style={{ marginTop: '1rem' }}>
                <button className="btn btn-primary" disabled={s.errors > 0 || commit.isPending || (s.new === 0 && s.ended === 0)} onClick={() => commit.mutate()}>
                  {commit.isPending ? 'Importing…' : 'Import timetable'}
                </button>
                {s.new === 0 && s.ended === 0 && s.errors === 0 && <span className="muted">Nothing to change: the timetable is already up to date.</span>}
              </div>
              <ErrorNotice error={commit.error} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
