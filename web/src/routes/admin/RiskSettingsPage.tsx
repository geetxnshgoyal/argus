import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend, type Schemas } from '../../lib/api.ts';
import { useMe } from '../../lib/auth.ts';

type Setting = Schemas['RiskSetting'];

const GROUPS: { kind: Setting['kind']; title: string; text: string }[] = [
  { kind: 'scorer', title: 'Signals', text: 'Each signal adds points to a scan. Points never refuse a scan on their own; they decide which scans are flagged for spot checks.' },
  { kind: 'threshold', title: 'Thresholds', text: 'Scores at which a scan is flagged, or flagged high.' },
  { kind: 'setting', title: 'Other settings', text: 'Spot-check sizes, headcount tolerance and lateness.' },
];

/**
 * Anti-proxy signal weights, kill switches and thresholds (ADR-0014, spec §14:
 * "misbehaving signal → disable without redeploy"). Admins edit; Acad Ops view.
 */
export function RiskSettingsPage() {
  const me = useMe();
  const canEdit = me.data?.user.role === 'admin';
  const list = useQuery({ queryKey: ['risk-settings'], queryFn: () => apiGet<{ items: Setting[] }>('/v1/admin/risk-settings') });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHead
        title="Anti-proxy checks"
        subtitle="How much each warning sign counts when a student scans. Changes apply within a few seconds and are recorded in the audit log."
      />
      {!canEdit && me.data && <Notice>Only an administrator can change these settings.</Notice>}
      <ErrorNotice error={list.error} />
      {list.isPending && <p className="muted">Loading…</p>}
      {GROUPS.map((g) => {
        const rows = items.filter((s) => s.kind === g.kind);
        if (!rows.length) return null;
        return (
          <section key={g.kind} style={{ marginBottom: '1.5rem' }}>
            <h2>{g.title}</h2>
            <p className="muted small">{g.text}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">{g.kind === 'scorer' ? 'Points' : 'Value'}</th>
                    {g.kind === 'scorer' && <th scope="col">On</th>}
                    <th scope="col">Last changed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <SettingRow key={s.key} s={s} canEdit={canEdit} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

function SettingRow({ s, canEdit }: { s: Setting; canEdit: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(s.value));
  const save = useMutation({
    mutationFn: (body: { value?: number; enabled?: boolean }) => apiSend('PATCH', `/v1/admin/risk-settings/${s.key}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['risk-settings'] }),
  });
  const n = Number(value);
  const changed = value !== String(s.value);
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 1000;
  const id = `risk-${s.key}`;
  return (
    <tr>
      <td>
        <label htmlFor={id}>
          <strong>{s.key.replace(/_/g, ' ')}</strong>
        </label>
        <br />
        <span className="muted small">{s.description}</span>
        {s.default_value != null && s.value !== s.default_value && <span className="muted small"> (default {s.default_value})</span>}
        <ErrorNotice error={save.error} />
      </td>
      <td>
        {canEdit ? (
          <form
            className="btn-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && changed) save.mutate({ value: n });
            }}
          >
            <input id={id} type="number" min={0} max={1000} step={1} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: '6rem' }} aria-invalid={!valid} />
            {changed && (
              <button className="btn btn-primary" type="submit" disabled={!valid || save.isPending}>
                Save
              </button>
            )}
          </form>
        ) : (
          <span id={id}>{s.value}</span>
        )}
      </td>
      {s.kind === 'scorer' && (
        <td>
          <input
            type="checkbox"
            aria-label={`${s.key.replace(/_/g, ' ')} on`}
            checked={s.enabled}
            disabled={!canEdit || save.isPending}
            onChange={(e) => {
              const on = e.target.checked;
              if (on || window.confirm(`Turn off "${s.key.replace(/_/g, ' ')}"? Scans will no longer be scored for it until it is turned back on.`)) save.mutate({ enabled: on });
            }}
          />
        </td>
      )}
      <td className="muted small">{s.updated_at && s.updated_by_name ? `${new Date(s.updated_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${s.updated_by_name}` : 'Never changed'}</td>
    </tr>
  );
}
