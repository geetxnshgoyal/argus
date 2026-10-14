import { describe, expect, it } from 'vitest';
import { evaluateWifi, routerId } from '../src/geo/wifi.ts';

// A typical layout: each router broadcasts several networks on two bands, so BSSIDs
// differ only in the last octet. Lab L2 has one router, Classroom 8 two.
const L2 = new Set(['0a:1b:2c:76:e0']);
const C8 = new Set(['0a:1b:2c:78:0e', '0a:1b:2c:78:3b']);
const CAMPUS = new Set([...L2, ...C8]);
const ap = (bssid: string, rssi: number, ssid = 'CAMPUS_STUDENTS') => ({ bssid, rssi, ssid });

describe('classroom Wi-Fi (ADR-0030)', () => {
  it('router id = first five octets; placeholders and junk are ignored', () => {
    expect(routerId('0A:1B:2C:76:E0:A8')).toBe('0a:1b:2c:76:e0');
    expect(routerId('0a-1b-2c-78-3b-a5')).toBe('0a:1b:2c:78:3b');
    expect(routerId('02:00:00:00:00:00')).toBeNull(); // Android without permission
    expect(routerId('not a mac')).toBeNull();
  });

  it('in Classroom 8 (Android sees everything nearby, including L2 faintly) → room', () => {
    const seen = [ap('0a:1b:2c:78:0e:a8', -44), ap('0a:1b:2c:78:3b:a8', -52), ap('0a:1b:2c:76:e0:a8', -72), ap('0a:1b:2c:77:91:68', -57)];
    expect(evaluateWifi({ seen }, C8, CAMPUS, 'CAMPUS')).toEqual({ result: 'room', strongest: '0a:1b:2c:78:0e' });
  });

  it('iPhone connected to one of the room\'s routers → room', () => {
    expect(evaluateWifi({ connected: { bssid: '0a:1b:2c:78:3b:a8', ssid: 'CAMPUS_STUDENTS' } }, C8, CAMPUS, 'CAMPUS').result).toBe('room');
  });

  it('class is in L2 but the phone only hears Classroom 8 → other_room (a flag, not a refusal)', () => {
    const seen = [ap('0a:1b:2c:78:0e:a8', -44), ap('0a:1b:2c:78:3b:a8', -52)];
    expect(evaluateWifi({ seen }, L2, CAMPUS, 'CAMPUS').result).toBe('other_room');
  });

  it('college Wi-Fi from a router nobody has assigned yet → campus; room routers unknown → campus', () => {
    expect(evaluateWifi({ seen: [ap('0a:1b:2c:77:91:68', -57)] }, C8, CAMPUS, 'CAMPUS').result).toBe('campus');
    expect(evaluateWifi({ seen: [ap('0a:1b:2c:78:0e:a8', -44)] }, new Set(), CAMPUS, 'CAMPUS').result).toBe('campus');
  });

  it('only home Wi-Fi or a hotspot → not_campus; no Wi-Fi data → unknown', () => {
    expect(evaluateWifi({ seen: [ap('22:f5:ee:d6:b7:64', -63, 'Phone hotspot')] }, C8, CAMPUS, 'CAMPUS').result).toBe('not_campus');
    expect(evaluateWifi({ connected: null, seen: [] }, C8, CAMPUS, 'CAMPUS').result).toBe('unknown');
    expect(evaluateWifi(null, C8, CAMPUS, 'CAMPUS').result).toBe('unknown');
  });

  it('a hotspot renamed "CAMPUS_STUDENTS" with its own MAC is only "campus", never this room', () => {
    expect(evaluateWifi({ connected: { bssid: '46:11:fb:76:f9:10', ssid: 'CAMPUS_STUDENTS' } }, C8, CAMPUS, 'CAMPUS').result).toBe('campus');
  });
});
