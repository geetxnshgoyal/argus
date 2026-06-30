import { useEffect, useRef, type ReactNode } from 'react';
import { ApiRequestError } from '../lib/api.ts';

/** Line icons in the Heimdall style (stroke, rounded caps). */
const PATHS: Record<string, string> = {
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15 5.1a3 3 0 0 1 0 5.8',
  calendar: 'M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM4 10h16M8 4v4M16 4v4',
  building: 'M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M15 9h3a1 1 0 0 1 1 1v10M3 20h18M8 8h3M8 12h3M8 16h3',
  shield: 'M12 3l7 3v5c0 4.4-3 8.3-7 9.5-4-1.2-7-5.1-7-9.5V6l7-3zM9 12l2 2 4-4',
  upload: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 16V8M8.5 11.5L12 8l3.5 3.5',
  book: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14H6.5A1.5 1.5 0 0 0 5 19.5M5 5.5v14M9 8h6',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12l2.5 2.5 4.5-5',
  alert: 'M12 9v4M12 16.5v.5M10.3 4.3L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  map: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01M2 9.5a14 14 0 0 1 20 0',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
};

export function Icon({ name, size = 22 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.list} />
    </svg>
  );
}

export function IconTile({ name, tone }: { name: string; tone?: 'warn' | 'bad' | undefined }) {
  return (
    <span className={`icon-tile${tone ? ` ${tone}` : ''}`}>
      <Icon name={name} />
    </span>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      A
    </span>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div className={`notice${tone === 'info' ? '' : ` notice-${tone}`}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Shows an API error in plain language (never a stack trace). */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof ApiRequestError ? error.message : 'Something went wrong. Please try again.';
  return <Notice tone="bad">{message}</Notice>;
}

export function Field(props: { label: string; hint?: string | undefined; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.error ? <span className="error">{props.error}</span> : props.hint ? <span className="hint">{props.hint}</span> : null}
    </label>
  );
}

/** Native <dialog> modal: focus trapping and Escape handling come from the browser. */
export function Dialog(props: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} onClose={props.onClose} aria-labelledby="dialog-title">
      <div className="dialog-head">
        <h2 id="dialog-title">{props.title}</h2>
      </div>
      <div className="dialog-body">{props.children}</div>
      {props.footer && <div className="dialog-foot">{props.footer}</div>}
    </dialog>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="btn-row">{actions}</div>}
    </div>
  );
}
