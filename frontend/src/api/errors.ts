/** An error response: `{"error": {"code", "message", "details"?}}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiErrorFrom(response: Pick<Response, 'status'>, body: unknown): ApiError {
  const err = (body ?? {}) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  return new ApiError(
    response.status,
    err.error?.code ?? `http_${response.status}`,
    err.error?.message ?? `Request failed (${response.status})`,
    err.error?.details,
  );
}
