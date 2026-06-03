import { ApiError } from '../errors.ts';

/**
 * Translates Postgres constraint errors into friendly API errors so Acad Ops
 * sees "already exists" rather than a database message.
 */
export function mapDbError(err: unknown, op: 'create' | 'update' | 'delete'): never {
  const e = err as { code?: string; constraint?: string; detail?: string };
  switch (e.code) {
    case '23505':
      throw new ApiError(409, 'duplicate', 'Something with the same identifying details already exists.', {
        constraint: e.constraint,
      });
    case '23503':
      if (op === 'delete') {
        throw new ApiError(409, 'in_use', 'This is still used elsewhere (for example by a class or student). Remove those first.', {
          constraint: e.constraint,
        });
      }
      throw new ApiError(400, 'invalid_reference', 'A selected item does not exist.', { constraint: e.constraint });
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
      throw new ApiError(400, 'invalid_value', 'A value is outside the allowed range or format.', { constraint: e.constraint });
    case '23P01':
      throw new ApiError(409, 'conflict', 'This overlaps with something already scheduled.', { constraint: e.constraint });
    default:
      throw err;
  }
}
