import { z, type ZodType } from 'zod';
import { ApiError } from './errors.ts';

/** Parses untrusted input; failures become 400 validation_failed with field-level details. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '(body)';
    fields[key] ??= issue.message;
  }
  throw new ApiError(400, 'validation_failed', 'Some fields are missing or invalid.', { fields });
}

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Must be base64url');
export const idParams = z.object({ id: uuid });
