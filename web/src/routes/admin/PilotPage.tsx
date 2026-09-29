import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, qs, type Schemas } from '../../lib/api.ts';
import { useMe } from '../../lib/auth.ts';
import { addDaysIso, formatDate, isoToday, useAdminList, useScope } from '../../lib/refs.ts';

type Metrics = Schemas['PilotMetrics'];
type Shadow = Schemas['ShadowMode'];

const VERDICT: Record<string, { text: string; tone: string }> = {
  pass: { text: 'On target', tone: 'badge-good' },
  fail: { text: 'Off target', tone: 'badge-bad' },
  no_data: { text: 'No data yet', tone: '' },
};

const label = (code: string) => code.replace(/_/g, ' ');

/** Pilot support (spec M8, §17; ADR-0026): the shadow-mode switch and the pilot metrics. */
export function PilotPage() {
  const scope = useScope();
  const sections = useAdminList('sections', { term_id: scope.termId || undefined }, Boolean(scope.termId));
  const [from, setFrom] = useState(() => addDaysIso(isoToday(), -13));
  const [to, setTo] = useState(isoToday);
  const [sectionId, setSectionId] = useState('');
  const metrics = useQuery({
    queryKey: ['pilot-metrics', from, to, sectionId],
    queryFn: () => apiGet<Metrics>(`/v1/admin/pilot/metrics${qs({ from, to, section_id: sectionId || undefined })}`),
    enabled: Boolean(from && to && from <= to),
  });
  const m = metrics.data;

  return (
    <>
      <PageHead title="Pilot" subtitle="Run Argus alongside the usual roll call, and check it against the pilot targets before making it official." />
      <ShadowSwitch />

      <h2 style={{ marginTop: '2rem' }}>How the pilot is going</h2>
      <div className="toolbar">
        <label className="small">
          From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="small">
          To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} aria-label="Section">
          <option value="">All sections</option>
          {(sections.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <ErrorNotice error={metrics.error} />
      {metrics.isPending && <p className="muted">Loading…</p>}
      {m && (
        <>
          <p className="muted small">
            {m.totals.sessions} classes with attendance ({m.totals.shadow_sessions} in pilot mode) · {m.totals.expected_students} expected students · {m.totals.marked_present} marked present
          </p>
          <ul className="grid-cards" aria-label="Pilot targets">
            {m.targets.map((t) => {
              const v = VERDICT[t.verdict] ?? VERDICT.no_data!;
              return (
                <li key={t.key} className="stat">
                  <span className="muted small">{t.label}</span>
                  <span className="stat-value">{t.value === null ? '–' : `${t.value}${t.unit === '%' ? '%' : ` ${t.unit}`}`}</span>
                  <span className="small">
                    <span className={`badge ${v.tone}`}>{v.text}</span> target under {t.target}
                    {t.unit === '%' ? '%' : ` ${t.unit}`}
                  </span>
                  <span className="muted small">{t.detail}</span>
                </li>
              );
            })}
          </ul>

          <div className="pilot-grid">
            <CountTable title="Scan results" rows={Object.entries(m.decisions).map(([code, n]) => ({ code, n }))} empty="No scans yet." />
            <CountTable title="Why scans were refused" rows={m.reject_reasons} empty="No refused scans." />
            <CountTable title="Warning signs on flagged scans" rows={m.flag_reasons} empty="No flagged scans." />
            <section className="card">
              <h3>Spot checks</h3>
              <p className="muted small">When the teacher called a name Argus suggested.</p>
              <table>
                <tbody>
                  <tr><th scope="row">Recorded</th><td>{m.spot_checks.recorded}</td></tr>
                  <tr><th scope="row">Student was there</th><td>{m.spot_checks.confirmed}</td></tr>
                  <tr><th scope="row">Not there</th><td>{m.spot_checks.absent}</td></tr>
                  <tr><th scope="row">No answer</th><td>{m.spot_checks.no_response}</td></tr>
                  <tr><th scope="row">Suggested but not recorded</th><td>{m.spot_checks.not_recorded}</td></tr>
                  <tr><th scope="row">Miss rate</th><td>{m.spot_checks.miss_rate === null ? '–' : `${m.spot_checks.miss_rate}%`}</td></tr>
                </tbody>
              </table>
            </section>
          </div>

          <section style={{ marginTop: '1.5rem' }}>
            <h3>Day by day</h3>
            {m.days.length === 0 ? (
              <p className="muted">No attendance in this range.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Classes</th>
                      <th scope="col">Scans</th>
                      <th scope="col">Refused</th>
                      <th scope="col">Support requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.days.map((d) => (
                      <tr key={d.date}>
                        <td>{formatDate(d.date)}</td>
                        <td>{d.sessions}</td>
                        <td>{d.attempts}</td>
                        <td>{d.rejected}</td>
                        <td>{d.support}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function ShadowSwitch() {
  const qc = useQueryClient();
  const me = useMe();
  const canEdit = me.data?.user.role === 'admin';
  const state = useQuery({ queryKey: ['shadow-mode'], queryFn: () => apiGet<Shadow>('/v1/admin/pilot/shadow-mode') });
  const set = useMutation({
    mutationFn: (on: boolean) => apiSend<Shadow>('PUT', '/v1/admin/pilot/shadow-mode', { on }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shadow-mode'] });
      void qc.invalidateQueries({ queryKey: ['pilot-metrics'] });
    },
  });
  const on = state.data?.on ?? false;
  const change = (next: boolean) => {
    const msg = next
      ? 'Turn pilot mode on? Attendance taken from now on is marked "not official" for teachers, students and Acad Ops.'
      : 'Turn pilot mode off? Attendance taken from now on is official. Classes already taken in pilot mode stay "not official".';
    if (window.confirm(msg)) set.mutate(next);
  };
  return (
    <section className="card">
      <h2>Pilot mode (shadow mode)</h2>
      <p>
        {on ? (
          <>
            <span className="badge badge-warn">On</span> Attendance is computed as usual but marked <strong>not official</strong>. Keep the usual roll call running.
          </>
        ) : (
          <>
            <span className="badge badge-good">Off</span> Attendance taken in Argus is official.
          </>
        )}
      </p>
      {state.data?.updated_by_name && state.data.updated_at && (
        <p className="muted small">
          Last changed by {state.data.updated_by_name}, {new Date(state.data.updated_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      )}
      <ErrorNotice error={state.error ?? set.error} />
      {canEdit ? (
        <button className={`btn ${on ? 'btn-primary' : ''}`} disabled={set.isPending || state.isPending} onClick={() => change(!on)}>
          {on ? 'Make attendance official (turn pilot mode off)' : 'Turn pilot mode on'}
        </button>
      ) : (
        me.data && <Notice>Only an administrator can switch pilot mode.</Notice>
      )}
      <p className="muted small" style={{ marginTop: '0.75rem' }}>The switch applies to attendance started after the change; classes already taken keep their mode.</p>
    </section>
  );
}

function CountTable({ title, rows, empty }: { title: string; rows: { code: string; n: number }[]; empty: string }) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  return (
    <section className="card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <th scope="row" style={{ textTransform: 'capitalize' }}>{label(r.code)}</th>
                <td>{r.n}</td>
                <td className="muted small">{total ? `${Math.round((r.n / total) * 100)}%` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
