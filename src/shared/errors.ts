import { ZodError } from 'zod';

export type ErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'DATABASE' | 'CHECK_FAILED' | 'CANCELED' | 'INTERNAL';

export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class OpossumError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OpossumError';
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof OpossumError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return {
      code: 'VALIDATION',
      message: `Request has ${details.length} validation error${details.length === 1 ? '' : 's'}.`,
      details,
    };
  }
  if (error instanceof Error) return { code: 'INTERNAL', message: error.message };
  return { code: 'INTERNAL', message: 'An unexpected error occurred.' };
}
