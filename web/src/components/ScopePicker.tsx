import { useEffect } from 'react';
import { useAdminList } from '../lib/refs.ts';

/** Term + section selectors used across timetable pages. */
export function ScopePicker(props: {
  termId: string;
  sectionId: string;
  setTermId: (v: string) => void;
  setSectionId: (v: string) => void;
  needSection?: boolean;
}) {
  const terms = useAdminList('terms');
  const sections = useAdminList('sections', { term_id: props.termId || undefined }, Boolean(props.termId));
  const { termId, setTermId } = props;

  // Default to the latest term.
  useEffect(() => {
    if (!termId && terms.data?.length) setTermId(terms.data[terms.data.length - 1]!.id);
  }, [termId, terms.data, setTermId]);

  return (
    <div className="toolbar">
      <select value={props.termId} onChange={(e) => { props.setTermId(e.target.value); props.setSectionId(''); }} aria-label="Term">
        <option value="">Choose term…</option>
        {(terms.data ?? []).map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      {props.needSection !== false && (
        <select value={props.sectionId} onChange={(e) => props.setSectionId(e.target.value)} aria-label="Section" disabled={!props.termId}>
          <option value="">Choose section…</option>
          {(sections.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
