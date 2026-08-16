/**
 * Campus geofence checks (spec §6 step 8). Pure functions; the attempt
 * pipeline stores only the derived result, never coordinates.
 */

export interface Geofence {
  center_lat: number;
  center_lon: number;
  radius_m: number;
  /** Optional polygon as [lat, lon] pairs; when present it replaces the circle. */
  polygon: [number, number][] | null;
}

const EARTH_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Local equirectangular projection around `lat0` (metres); accurate at campus scale. */
function project(lat: number, lon: number, lat0: number): [number, number] {
  return [rad(lon) * EARTH_M * Math.cos(rad(lat0)), rad(lat) * EARTH_M];
}

function pointInPolygon(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] as [number, number];
    const [xj, yj] = pts[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Metres outside the geofence (0 when inside). */
export function distanceOutside(g: Geofence, lat: number, lon: number): number {
  if (g.polygon && g.polygon.length >= 3) {
    const lat0 = g.polygon[0]?.[0] ?? lat;
    const pts = g.polygon.map(([a, b]) => project(a, b, lat0));
    const [px, py] = project(lat, lon, lat0);
    if (pointInPolygon(px, py, pts)) return 0;
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) best = Math.min(best, distToSegment(px, py, pts[i] as [number, number], pts[(i + 1) % pts.length] as [number, number]));
    return best;
  }
  return Math.max(0, haversineM(g.center_lat, g.center_lon, lat, lon) - g.radius_m);
}

export interface LocationFix {
  lat: number;
  lon: number;
  accuracy_m: number;
  fix_age_ms: number;
  is_mock: boolean;
}

export interface LocationResult {
  result: 'inside' | 'outside' | 'unknown';
  /** Distance outside the nearest geofence, rounded to 50 m (spec §6 storage rule). */
  distance_m: number | null;
  accuracy_m: number | null;
  is_mock: boolean;
  /** Hard reject: clearly off campus (spec §6 step 8). */
  clearlyOff: boolean;
}

export const MAX_FIX_AGE_MS = 30_000;
export const GOOD_ACCURACY_M = 100;

/**
 * Evaluates a fix against the relevant geofences. A stale or missing fix is
 * "unknown". Clearly off campus = outside by more than the accuracy radius,
 * with accuracy ≤ 100 m and not a mock location.
 */
export function evaluateLocation(fix: LocationFix | null, fences: Geofence[]): LocationResult {
  if (!fix || fix.fix_age_ms > MAX_FIX_AGE_MS || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) {
    // A stale or invalid fix counts as no fix at all.
    return { result: 'unknown', distance_m: null, accuracy_m: null, is_mock: Boolean(fix?.is_mock), clearlyOff: false };
  }
  const accuracy = Math.max(0, fix.accuracy_m);
  if (fences.length === 0) return { result: 'unknown', distance_m: null, accuracy_m: Math.round(accuracy), is_mock: fix.is_mock, clearlyOff: false };
  const d = Math.min(...fences.map((g) => distanceOutside(g, fix.lat, fix.lon)));
  const clearlyOff = d - accuracy > 0 && accuracy <= GOOD_ACCURACY_M && !fix.is_mock;
  return {
    result: d === 0 ? 'inside' : 'outside',
    distance_m: Math.round(d / 50) * 50,
    accuracy_m: Math.round(accuracy),
    is_mock: fix.is_mock,
    clearlyOff,
  };
}
