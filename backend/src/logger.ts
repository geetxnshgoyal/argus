import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured JSON logging with redaction.
 *
 * Rule from the spec: never log secrets, session keys, tokens, raw attestation
 * blobs or precise student locations. Redaction below is a safety net; code
 * should simply not pass such values to the logger in the first place.
 */

/** Field names whose values are always replaced with "[redacted]", at any depth up to 2. */
export const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'display_token',
  'secret',
  'key',
  'session_key',
  'master_key',
  'signature',
  'attestation',
  'integrity_token',
  'assertion',
  'nonce',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'location',
] as const;

function redactPaths(): string[] {
  const paths: string[] = [];
  for (const k of SENSITIVE_KEYS) {
    const p = /^[a-z_]+$/.test(k) ? k : `["${k}"]`;
    const join = (prefix: string) => (p.startsWith('[') ? `${prefix}${p}` : `${prefix}.${p}`);
    paths.push(p, join('*'), join('*.*'));
  }
  paths.push('req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]');
  return paths;
}

export function loggerOptions(level: LoggerOptions['level']): LoggerOptions {
  return {
    level: level ?? 'info',
    base: { service: 'argus' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths(), censor: '[redacted]' },
  };
}

export function createLogger(level: LoggerOptions['level'], destination?: DestinationStream): Logger {
  return destination ? pino(loggerOptions(level), destination) : pino(loggerOptions(level));
}
