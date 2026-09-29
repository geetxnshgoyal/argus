/**
 * Classroom Wi-Fi check (ADR-0030). The phone reports the Wi-Fi access points it
 * can see (Android: all nearby; iPhone: the one it is connected to) inside the
 * signed attempt. A physical router broadcasts several networks and bands whose
 * BSSIDs differ only in the last octet, so a router is identified by the first
 * five octets ("e0:c2:50:76:e0"). Only the verdict is stored, never the list.
 */

export interface WifiAp {
  bssid: string;
  ssid?: string | null | undefined;
  rssi?: number | null | undefined;
}

export interface WifiSnapshot {
  connected?: WifiAp | null | undefined;
  seen?: WifiAp[] | undefined;
}

/** room: this class's router · campus: a college network, room unknown · other_room: another classroom's router · not_campus: no college Wi-Fi · unknown: no Wi-Fi data */
export type WifiResult = 'room' | 'campus' | 'other_room' | 'not_campus' | 'unknown';

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** "E0:C2:50:76:E0:A8" → "e0:c2:50:76:e0"; null for anything that isn't a MAC address. */
export function routerId(bssid: string | null | undefined): string | null {
  if (!bssid || !MAC.test(bssid.trim())) return null;
  const parts = bssid.trim().toLowerCase().replace(/-/g, ':').split(':');
  if (parts.join(':') === '00:00:00:00:00:00' || parts.join(':') === '02:00:00:00:00:00') return null; // Android's "hidden" placeholder
  return parts.slice(0, 5).join(':');
}

export function isRouterId(s: string): boolean {
  return /^([0-9a-f]{2}:){4}[0-9a-f]{2}$/.test(s);
}

export interface WifiVerdict {
  result: WifiResult;
  /** Strongest college router seen, for learning which routers belong to the room. */
  strongest: string | null;
}

export function evaluateWifi(
  snap: WifiSnapshot | null | undefined,
  roomRouters: ReadonlySet<string>,
  campusRouters: ReadonlySet<string>,
  ssidPrefix: string,
): WifiVerdict {
  const aps = [...(snap?.connected ? [snap.connected] : []), ...(snap?.seen ?? [])];
  if (aps.length === 0) return { result: 'unknown', strongest: null };
  const college = (ap: WifiAp) => Boolean(ssidPrefix) && (ap.ssid ?? '').toLowerCase().startsWith(ssidPrefix.toLowerCase());
  const ids = new Set(aps.map((a) => routerId(a.bssid)).filter((x): x is string => x !== null));

  let strongest: string | null = null;
  let best = -Infinity;
  for (const ap of aps) {
    const id = routerId(ap.bssid);
    if (!id || !(college(ap) || campusRouters.has(id))) continue;
    // The connected router counts as strongest when no signal level is given (iPhone).
    const rssi = ap.rssi ?? (ap === snap?.connected ? 0 : -200);
    if (rssi > best) {
      best = rssi;
      strongest = id;
    }
  }

  if (roomRouters.size > 0 && [...ids].some((id) => roomRouters.has(id))) return { result: 'room', strongest };
  const onCampus = [...ids].some((id) => campusRouters.has(id)) || aps.some(college);
  if (!onCampus) return { result: 'not_campus', strongest };
  // Seeing only other classrooms' routers means little if this room's routers aren't known yet.
  if (roomRouters.size > 0 && [...ids].some((id) => campusRouters.has(id))) return { result: 'other_room', strongest };
  return { result: 'campus', strongest };
}
