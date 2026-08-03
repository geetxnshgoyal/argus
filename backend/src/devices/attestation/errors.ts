/**
 * Attestation outcomes. `AttestationFailed` means the evidence is bad (reject);
 * `AttestationUnavailable` means the provider (Google/Apple) could not be
 * reached, which spec §6/§14 says must flag, never mass-reject.
 */
export class AttestationFailed extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`attestation failed: ${reason}`);
    this.name = 'AttestationFailed';
    this.reason = reason;
  }
}

export class AttestationUnavailable extends Error {
  constructor(message: string) {
    super(`attestation provider unavailable: ${message}`);
    this.name = 'AttestationUnavailable';
  }
}

/** Decodes standard or URL-safe base64; throws AttestationFailed on garbage. */
export function b64any(s: string, what: string): Buffer {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) throw new AttestationFailed(`${what} is not base64`);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
