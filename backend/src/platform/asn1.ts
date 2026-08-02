import { X509Certificate } from 'node:crypto';

/**
 * Minimal ASN.1 DER reader: just enough for X.509 extensions, Android key
 * attestation (KeyDescription) and the Apple App Attest nonce extension.
 * Rejects indefinite lengths and anything that runs past its parent.
 */

export const CLASS_UNIVERSAL = 0;
export const CLASS_CONTEXT = 2;

export const TAG = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OID: 6,
  ENUMERATED: 10,
  SEQUENCE: 16,
  SET: 17,
} as const;

export interface DerNode {
  tagClass: number;
  constructed: boolean;
  tag: number;
  /** Content bytes (without tag and length). */
  value: Buffer;
  /** The whole TLV. */
  raw: Buffer;
}

export class Asn1Error extends Error {
  constructor(message: string) {
    super(`ASN.1: ${message}`);
    this.name = 'Asn1Error';
  }
}

/** Reads one TLV at `offset`; returns the node and the offset just after it. */
export function readTlv(buf: Buffer, offset = 0): { node: DerNode; next: number } {
  let p = offset;
  const need = (n: number) => {
    if (p + n > buf.length) throw new Asn1Error('truncated');
  };
  need(1);
  const first = buf[p++] as number;
  const tagClass = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    // High-tag-number form: base-128, most significant group first.
    tag = 0;
    for (let i = 0; ; i++) {
      if (i > 4) throw new Asn1Error('tag too long');
      need(1);
      const b = buf[p++] as number;
      tag = tag * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  need(1);
  let len = buf[p++] as number;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new Asn1Error('indefinite length is not DER');
    if (n > 4) throw new Asn1Error('length too long');
    need(n);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[p++] as number);
  }
  need(len);
  const value = buf.subarray(p, p + len);
  return { node: { tagClass, constructed, tag, value, raw: buf.subarray(offset, p + len) }, next: p + len };
}

/** Parses a buffer that must contain exactly one TLV. */
export function parseDer(buf: Buffer): DerNode {
  const { node, next } = readTlv(buf, 0);
  if (next !== buf.length) throw new Asn1Error('trailing bytes');
  return node;
}

export function children(node: DerNode): DerNode[] {
  if (!node.constructed) throw new Asn1Error('not a constructed type');
  const out: DerNode[] = [];
  let p = 0;
  while (p < node.value.length) {
    const { node: child, next } = readTlv(node.value, p);
    out.push(child);
    p = next;
  }
  return out;
}

function expect(node: DerNode, tag: number, tagClass = CLASS_UNIVERSAL): void {
  if (node.tagClass !== tagClass || node.tag !== tag) {
    throw new Asn1Error(`expected tag ${tagClass}:${tag}, got ${node.tagClass}:${node.tag}`);
  }
}

export function asSequence(node: DerNode): DerNode[] {
  expect(node, TAG.SEQUENCE);
  return children(node);
}

export function asSet(node: DerNode): DerNode[] {
  expect(node, TAG.SET);
  return children(node);
}

/** Non-negative integers up to 2^53; larger ones throw. */
export function asInt(node: DerNode, tag: number = TAG.INTEGER): number {
  expect(node, tag);
  const v = node.value;
  if (v.length === 0) throw new Asn1Error('empty integer');
  if ((v[0] as number) & 0x80) throw new Asn1Error('negative integers are not supported');
  let n = 0;
  for (const b of v) {
    n = n * 256 + b;
    if (n > Number.MAX_SAFE_INTEGER) throw new Asn1Error('integer too large');
  }
  return n;
}

export function asEnum(node: DerNode): number {
  return asInt(node, TAG.ENUMERATED);
}

export function asBool(node: DerNode): boolean {
  expect(node, TAG.BOOLEAN);
  if (node.value.length !== 1) throw new Asn1Error('bad boolean');
  return node.value[0] !== 0;
}

export function asOctets(node: DerNode): Buffer {
  expect(node, TAG.OCTET_STRING);
  return node.value;
}

export function asOid(node: DerNode): string {
  expect(node, TAG.OID);
  const v = node.value;
  if (v.length === 0) throw new Asn1Error('empty OID');
  const parts: number[] = [];
  const first = v[0] as number;
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    const b = v[i] as number;
    n = n * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join('.');
}

/** The single child of an EXPLICIT context tag `[n]`. */
export function explicit(node: DerNode, n: number): DerNode {
  expect(node, n, CLASS_CONTEXT);
  const kids = children(node);
  if (kids.length !== 1) throw new Asn1Error(`[${n}] must wrap exactly one value`);
  return kids[0] as DerNode;
}

/** Context-tagged fields of a SEQUENCE, keyed by tag number (e.g. AuthorizationList). */
export function contextFields(seq: DerNode): Map<number, DerNode> {
  const out = new Map<number, DerNode>();
  for (const c of asSequence(seq)) {
    if (c.tagClass !== CLASS_CONTEXT) throw new Asn1Error('expected context-tagged fields');
    out.set(c.tag, explicit(c, c.tag));
  }
  return out;
}

/**
 * The `extnValue` contents of an X.509 extension, or null if the certificate
 * doesn't have it. Walks Certificate → tbsCertificate → [3] extensions.
 */
export function certExtension(cert: X509Certificate, oid: string): Buffer | null {
  const tbs = asSequence(parseDer(cert.raw))[0];
  if (!tbs) throw new Asn1Error('no tbsCertificate');
  for (const field of asSequence(tbs)) {
    if (field.tagClass !== CLASS_CONTEXT || field.tag !== 3) continue;
    for (const ext of asSequence(explicit(field, 3))) {
      const parts = asSequence(ext);
      if (asOid(parts[0] as DerNode) !== oid) continue;
      return asOctets(parts[parts.length - 1] as DerNode);
    }
  }
  return null;
}
