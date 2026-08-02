/**
 * Minimal CBOR (RFC 8949) decoder for Apple App Attest objects: unsigned and
 * negative integers, byte and text strings, arrays, maps, tags (unwrapped),
 * booleans, null and floats. Definite lengths only; maps become `Map`s so
 * integer keys (COSE) survive.
 */

export type CborValue = number | bigint | string | Buffer | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(`CBOR: ${message}`);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 10_000;

export function decodeCbor(buf: Uint8Array): CborValue {
  const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  let items = 0;

  const need = (n: number) => {
    if (p + n > data.length) throw new CborError('truncated');
  };

  function readArg(info: number): number | bigint {
    if (info < 24) return info;
    switch (info) {
      case 24:
        need(1);
        return data.readUInt8(p++);
      case 25:
        need(2);
        p += 2;
        return data.readUInt16BE(p - 2);
      case 26:
        need(4);
        p += 4;
        return data.readUInt32BE(p - 4);
      case 27: {
        need(8);
        const v = data.readBigUInt64BE(p);
        p += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      default:
        throw new CborError(info === 31 ? 'indefinite lengths are not supported' : 'reserved additional info');
    }
  }

  function length(info: number): number {
    const n = readArg(info);
    if (typeof n !== 'number') throw new CborError('length too large');
    return n;
  }

  function item(depth: number): CborValue {
    if (depth > MAX_DEPTH) throw new CborError('nesting too deep');
    if (++items > MAX_ITEMS) throw new CborError('too many items');
    need(1);
    const first = data.readUInt8(p++);
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0:
        return readArg(info);
      case 1: {
        const n = readArg(info);
        return typeof n === 'bigint' ? -1n - n : -1 - n;
      }
      case 2: {
        const n = length(info);
        need(n);
        p += n;
        return Buffer.from(data.subarray(p - n, p));
      }
      case 3: {
        const n = length(info);
        need(n);
        p += n;
        return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(p - n, p));
      }
      case 4: {
        const n = length(info);
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const n = length(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (map.has(k)) throw new CborError('duplicate map key');
          map.set(k, item(depth + 1));
        }
        return map;
      }
      case 6:
        readArg(info);
        return item(depth + 1);
      default: // 7: simple values and floats
        switch (info) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          case 25: {
            need(2);
            p += 2;
            return halfToNumber(data.readUInt16BE(p - 2));
          }
          case 26:
            need(4);
            p += 4;
            return data.readFloatBE(p - 4);
          case 27:
            need(8);
            p += 8;
            return data.readDoubleBE(p - 8);
          default:
            throw new CborError('unsupported simple value');
        }
    }
  }

  const out = item(0);
  if (p !== data.length) throw new CborError('trailing bytes');
  return out;
}

function halfToNumber(h: number): number {
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Typed accessors for decoded maps; throw a CborError naming the field. */
export function mapGet(v: CborValue, key: CborValue): CborValue {
  if (!(v instanceof Map)) throw new CborError('expected a map');
  return v.get(key);
}

export function asBytes(v: CborValue, what: string): Buffer {
  if (!Buffer.isBuffer(v)) throw new CborError(`${what} must be a byte string`);
  return v;
}
