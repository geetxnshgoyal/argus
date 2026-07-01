/** Calendar-date helpers on 'YYYY-MM-DD' strings (no time zones involved). */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function* eachDate(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/** Today's date in the college's time zone. */
export function localDate(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 'H:MM' / 'HH:MM' / 'HH:MM:SS' → 'HH:MM:SS'. */
export function normTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) throw new Error(`invalid time "${t}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid time "${t}"`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${m[3] ?? '00'}`;
}

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
