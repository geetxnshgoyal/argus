import { describe, expect, it } from 'vitest';
import { evaluateWifi, routerId } from '../src/geo/wifi.ts';

// Real layout from a scan on 2026-09-29: each router broadcasts five networks on two
// bands, so BSSIDs differ only in the last octet. Lab L2 has one router, Classroom 8 two.
const L2 = new Set(['e0:c2:50:76:e0']);
const C8 = new Set(['e0:c2:50:78:0e', 'e0:c2:50:78:3b']);
const CAMPUS = new Set([...L2, ...C8]);
const ap = (bssid: string, rssi: number, ssid = 'SVYASA_STUDENTS') => ({ bssid, rssi, ssid });

describe('classroom Wi-Fi (ADR-0030)', () => {
  it('router id = first five octets; placeholders and junk are ignored', () => {
    expect(routerId('E0:C2:50:76:E0:A8')).toBe('e0:c2:50:76:e0');
    expect(routerId('e0-c2-50-78-3b-a5')).toBe('e0:c2:50:78:3b');
    expect(routerId('02:00:00:00:00:00')).toBeNull(); // Android without permission
    expect(routerId('not a mac')).toBeNull();
  });

  it('in Classroom 8 (Android sees everything nearby, including L2 faintly) → room', () => {
    const seen = [ap('e0:c2:50:78:0e:a8', -44), ap('e0:c2:50:78:3b:a8', -52), ap('e0:c2:50:76:e0:a8', -72), ap('e0:c2:50:77:91:68', -57)];
    expect(evaluateWifi({ seen }, C8, CAMPUS, 'SVYASA')).toEqual({ result: 'room', strongest: 'e0:c2:50:78:0e' });
  });

  it('iPhone connected to one of the room\'s routers → room', () => {
    expect(evaluateWifi({ connected: { bssid: 'e0:c2:50:78:3b:a8', ssid: 'SVYASA_STUDENTS' } }, C8, CAMPUS, 'SVYASA').result).toBe('room');
  });

  it('class is in L2 but the phone only hears Classroom 8 → other_room (a flag, not a refusal)', () => {
    const seen = [ap('e0:c2:50:78:0e:a8', -44), ap('e0:c2:50:78:3b:a8', -52)];
    expect(evaluateWifi({ seen }, L2, CAMPUS, 'SVYASA').result).toBe('other_room');
  });

  it('college Wi-Fi from a router nobody has assigned yet → campus; room routers unknown → campus', () => {
    expect(evaluateWifi({ seen: [ap('e0:c2:50:77:91:68', -57)] }, C8, CAMPUS, 'SVYASA').result).toBe('campus');
    expect(evaluateWifi({ seen: [ap('e0:c2:50:78:0e:a8', -44)] }, new Set(), CAMPUS, 'SVYASA').result).toBe('campus');
  });

  it('only home Wi-Fi or a hotspot → not_campus; no Wi-Fi data → unknown', () => {
    expect(evaluateWifi({ seen: [ap('22:f5:ee:d6:b7:64', -63, 'Harshit Galaxy A14 5G')] }, C8, CAMPUS, 'SVYASA').result).toBe('not_campus');
    expect(evaluateWifi({ connected: null, seen: [] }, C8, CAMPUS, 'SVYASA').result).toBe('unknown');
    expect(evaluateWifi(null, C8, CAMPUS, 'SVYASA').result).toBe('unknown');
  });

  it('a hotspot renamed "SVYASA_STUDENTS" with its own MAC is only "campus", never this room', () => {
    expect(evaluateWifi({ connected: { bssid: '46:11:fb:76:f9:10', ssid: 'SVYASA_STUDENTS' } }, C8, CAMPUS, 'SVYASA').result).toBe('campus');
  });
});
