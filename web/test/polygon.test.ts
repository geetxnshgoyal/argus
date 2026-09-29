import { describe, expect, it } from 'vitest';
import { parsePolygon } from '../src/components/ResourcePage.tsx';

describe('campus area outline input', () => {
  it('reads one "lat, lon" corner per line (commas or spaces, blank lines ignored)', () => {
    expect(parsePolygon('12.920986, 77.500767\n\n12.92143 77.501498\n 12.920196,77.502288 \n12.919752, 77.501558')).toEqual([
      [12.920986, 77.500767],
      [12.92143, 77.501498],
      [12.920196, 77.502288],
      [12.919752, 77.501558],
    ]);
  });

  it('empty means no outline (use the circle)', () => {
    expect(parsePolygon('  \n ')).toBeNull();
  });

  it('explains mistakes in plain words', () => {
    expect(() => parsePolygon('12.9, 77.5\n12.9, 77.6')).toThrow(/at least 3 corners/);
    expect(() => parsePolygon('12.9, 77.5\nabc\n12.9, 77.6')).toThrow(/Line 2/);
    expect(() => parsePolygon('12.9, 77.5\n120, 77.5\n12.9, 77.6')).toThrow(/Line 2: that is not a valid position/);
  });
});
