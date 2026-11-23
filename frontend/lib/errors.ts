/** The single error shape (openapi-outline §1, §3) plus wire validation. */

export type ApiErrorDetail = Record<string, unknown>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  body(): { code: string; message: string; details: ApiErrorDetail[] } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function errorResponse(error: ApiError, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ...error.body(), ...extra }, { status: error.status });
}

/** Mirrors FastAPI's RequestValidationError shape: field / problem / received. */
export class ValidationFailure {
  readonly details: ApiErrorDetail[] = [];

  add(field: string | null, problem: string, received?: unknown): void {
    const detail: ApiErrorDetail = { field, problem };
    if (received !== undefined && (received === null || ['number', 'string', 'boolean'].includes(typeof received))) {
      detail.received = received;
    }
    this.details.push(detail);
  }

  get empty(): boolean {
    return this.details.length === 0;
  }

  throwIfAny(): void {
    if (this.details.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'request validation failed', this.details);
    }
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'request validation failed', [
      { field: null, problem: 'JSON decode error' },
    ]);
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'request validation failed', [
      { field: null, problem: 'JSON decode error' },
    ]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'request validation failed', [
      { field: null, problem: 'Input should be a valid dictionary' },
    ]);
  }
  return parsed as Record<string, unknown>;
}

/** Pydantic's `extra="forbid"`: report every unknown key, then fail. */
export function rejectExtraKeys(payload: Record<string, unknown>, allowed: string[], failure: ValidationFailure): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) failure.add(key, 'Extra inputs are not permitted', payload[key]);
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}
