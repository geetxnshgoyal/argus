import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiGet, qs } from './api.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- admin lists are generic JSON */
export type Row = Record<string, any> & { id: string };

/** Cached admin reference list, e.g. useAdminList('rooms'). */
export function useAdminList(path: string, params: Record<string, string | undefined> = {}, enabled = true) {
  return useQuery({
    queryKey: ['refs', path, params],
    queryFn: async () => (await apiGet<{ items: Row[] }>(`/v1/admin/${path}${qs({ limit: 1000, ...params })}`)).items,
    enabled,
  });
}

/** Remembers the chosen term/section across admin pages (per browser tab). */
export function useScope() {
  const read = (k: string) => {
    try {
      return sessionStorage.getItem(`argus.${k}`) ?? '';
    } catch {
      return '';
    }
  };
  const [termId, setTermId] = useState(() => read('term'));
  const [sectionId, setSectionId] = useState(() => read('section'));
  useEffect(() => {
    try {
      sessionStorage.setItem('argus.term', termId);
      sessionStorage.setItem('argus.section', sectionId);
    } catch {
      // storage unavailable: selection just isn't remembered
    }
  }, [termId, sectionId]);
  return { termId, setTermId, sectionId, setSectionId };
}

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDaysIso(date, dow === 0 ? -6 : 1 - dow);
}

export function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
