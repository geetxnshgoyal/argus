import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Minimal DER writer and X.509 builder for tests: makes fake Android key
 * attestation chains (our own "Google root") so the verifier's refusals can be
 * exercised without real phones.
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number | Buffer, content: Buffer): Buffer {
  const t = typeof tag === 'number' ? Buffer.from([tag]) : tag;
  return Buffer.concat([t, len(content.length), content]);
}

export const der = {
  seq: (...items: Buffer[]) => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]) => tlv(0x31, Buffer.concat(items)),
  int: (n: number | Buffer) => {
    const hex = Buffer.isBuffer(n) ? '' : n.toString(16);
    let b = Buffer.isBuffer(n) ? n : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    if ((b[0] as number) & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
  },
  enumerated: (n: number) => tlv(0x0a, Buffer.from([n])),
  bool: (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0])),
  nul: () => Buffer.from([0x05, 0x00]),
  octets: (b: Buffer | string) => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b)),
  utf8: (s: string) => tlv(0x0c, Buffer.from(s)),
  bits: (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b])),
  utcTime: (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z')),
  oid: (dotted: string) => {
    const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
    const out = [40 * a + b];
    for (const n of rest) {
      const groups: number[] = [];
      for (let v = n; ; v = Math.floor(v / 128)) {
        groups.unshift(v % 128);
        if (v < 128) break;
      }
      out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
    }
    return tlv(0x06, Buffer.from(out));
  },
  /** EXPLICIT context tag [n], including the high-tag-number form (n ≥ 31). */
  explicit: (n: number, inner: Buffer) => {
    if (n < 31) return tlv(0xa0 | n, inner);
    const groups: number[] = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    return tlv(Buffer.from([0xbf, ...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g))]), inner);
  },
};

const ECDSA_SHA256 = der.seq(der.oid('1.2.840.10045.4.3.2'));
const name = (cn: string) => der.seq(der.set(der.seq(der.oid('2.5.4.3'), der.utf8(cn))));

export interface TestKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  spki: Buffer;
}

export function ecKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey, spki: publicKey.export({ format: 'der', type: 'spki' }) };
}

export function makeCert(opts: {
  subject: string;
  issuer: string;
  subjectKey: TestKey;
  issuerKey: TestKey;
  notBefore: Date;
  notAfter: Date;
  serial?: Buffer | undefined;
  extensions?: { oid: string; value: Buffer }[];
}): Buffer {
  const exts = opts.extensions?.length ? [der.explicit(3, der.seq(...opts.extensions.map((e) => der.seq(der.oid(e.oid), der.octets(e.value)))))] : [];
  const tbs = der.seq(
    der.explicit(0, der.int(2)),
    der.int(opts.serial ?? randomBytes(8)),
    ECDSA_SHA256,
    name(opts.issuer),
    der.seq(der.utcTime(opts.notBefore), der.utcTime(opts.notAfter)),
    name(opts.subject),
    opts.subjectKey.spki,
    ...exts,
  );
  return der.seq(tbs, ECDSA_SHA256, der.bits(sign('sha256', tbs, opts.issuerKey.privateKey)));
}

// ── Android KeyDescription ────────────────────────────────────────────────

export interface KeyDescriptionOptions {
  challenge: Buffer;
  /** 0 software (emulator), 1 TEE, 2 StrongBox. */
  securityLevel?: number;
  deviceLocked?: boolean;
  /** 0 verified, 2 unverified. */
  bootState?: number;
  purposeSign?: boolean;
  /** 0 generated, 2 imported. */
  origin?: number;
  userAuth?: boolean;
  packageName?: string;
  certDigest?: Buffer;
}

export function keyDescription(o: KeyDescriptionOptions): Buffer {
  const level = o.securityLevel ?? 1;
  const appId = der.seq(der.set(der.seq(der.octets(o.packageName ?? 'app.argus.argus'), der.int(1))), der.set(der.octets(o.certDigest ?? Buffer.alloc(32, 0xab))));
  const sw = der.seq(der.explicit(709, der.octets(appId)));
  const hw = der.seq(
    der.explicit(1, der.set(der.int(o.purposeSign === false ? 3 : 2))),
    der.explicit(2, der.int(3)),
    der.explicit(10, der.int(1)),
    ...(o.userAuth === false ? [der.explicit(503, der.nul())] : [der.explicit(504, der.int(2))]),
    der.explicit(702, der.int(o.origin ?? 0)),
    der.explicit(704, der.seq(der.octets(Buffer.alloc(32, 1)), der.bool(o.deviceLocked ?? true), der.enumerated(o.bootState ?? 0), der.octets(Buffer.alloc(32, 2)))),
    der.explicit(706, der.int(202609)),
  );
  return der.seq(der.int(300), der.enumerated(level), der.int(300), der.enumerated(level), der.octets(o.challenge), der.octets(Buffer.alloc(0)), sw, hw);
}

/** A leaf → intermediate → root chain, base64. `root` is the key the verifier trusts. */
export function androidChain(o: KeyDescriptionOptions & { leafKey: TestKey; root?: TestKey; now: Date; leafSerial?: Buffer }) {
  const root = o.root ?? ecKey();
  const inter = ecKey();
  const day = 86_400_000;
  const from = new Date(o.now.getTime() - 30 * day);
  const to = new Date(o.now.getTime() + 365 * day);
  const rootCert = makeCert({ subject: 'Test Root', issuer: 'Test Root', subjectKey: root, issuerKey: root, notBefore: from, notAfter: to });
  const interCert = makeCert({ subject: 'Test Intermediate', issuer: 'Test Root', subjectKey: inter, issuerKey: root, notBefore: from, notAfter: to });
  const leafCert = makeCert({
    subject: 'Android Keystore Key',
    issuer: 'Test Intermediate',
    subjectKey: o.leafKey,
    issuerKey: inter,
    notBefore: from,
    notAfter: to,
    serial: o.leafSerial,
    extensions: [{ oid: '1.3.6.1.4.1.11129.2.1.17', value: keyDescription(o) }],
  });
  return { chain: [leafCert, interCert, rootCert].map((c) => c.toString('base64')), root };
}
