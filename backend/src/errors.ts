/**
 * API errors. Every error response has the shape {code, message, details}
 * (spec §10). `code` is a stable machine-readable string clients switch on;
 * `message` is human-readable and safe to show.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
