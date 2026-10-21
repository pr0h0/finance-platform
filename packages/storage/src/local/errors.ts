import type { z } from '@finplat/validation';

/** Same fields as @finplat/api-client ApiError, so UI error handling is mode-agnostic. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'entity') =>
  new ServiceError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new ServiceError(409, code, message, details);
export const invalid = (fields: Record<string, string>) =>
  new ServiceError(422, 'validation_failed', 'request validation failed', { fields });
export const unprocessable = (message: string, details?: unknown) =>
  new ServiceError(422, 'invariant_violation', message, details);

/** zod parse that throws a ServiceError with field paths like the API's validation errors. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
  throw invalid(fields);
}
