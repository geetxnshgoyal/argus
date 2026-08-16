import { describe, expect, it } from 'vitest';
import { epochAt, importRoundKey, qrContent, qrTag } from '../src/display/qr.ts';

// Same vectors as backend/test/attendance-crypto.test.ts (protocol.md §7).
const SESSION = '01923b6e-7c2a-7d4e-8f00-0123456789ab';
const CASES = [
  { round: 1, epoch: 0, kqr: '58BLCxoM3Wo7nThwsJtyjY60hhpWElv8Jq8SmIEv4N0', tag: 'akVShuIFylEuGxrB' },
  { round: 1, epoch: 1234, kqr: '58BLCxoM3Wo7nThwsJtyjY60hhpWElv8Jq8SmIEv4N0', tag: 'cCQrbMuIfbZejtJP' },
  { round: 2, epoch: 1234, kqr: 'mPBYE7kewskoTgaNm9fAQh1ZrdCrwX5XHhEmcU1OCpM', tag: 'Y2dQF4G2KPW0Xt_w' },
];

describe('display QR tags (WebCrypto)', () => {
  it.each(CASES)('round $round epoch $epoch matches the server', async ({ round, epoch, kqr, tag }) => {
    const key = await importRoundKey(kqr);
    expect(await qrTag(key, SESSION, round, epoch)).toBe(tag);
    expect(qrContent(SESSION, round, epoch, tag)).toBe(`argus://a/${SESSION}/${round}/${epoch}/${tag}`);
  });

  it('the imported round key cannot be exported', async () => {
    const key = await importRoundKey(CASES[0]!.kqr);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('epochs follow the server clock', () => {
    expect(epochAt(1_000_000 + 2999, 1_000_000, 3000)).toBe(0);
    expect(epochAt(1_000_000 + 3000, 1_000_000, 3000)).toBe(1);
  });
});
