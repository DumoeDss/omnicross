/**
 * The admin service layer's transport-neutral result: an HTTP-style status and
 * a JSON-able body. The daemon writes it straight to the admin response; the
 * embedding host unwraps it (status >= 400 → a thrown `HostError`).
 *
 * Errors use the admin envelope `{ error: { type: 'admin_api_error', message } }`
 * so the daemon's HTTP responses stay byte-identical to the pre-service-layer
 * handlers.
 *
 * @module @omnicross/daemon/service/result
 */

export interface ServiceResult {
  readonly status: number;
  readonly body: unknown;
}

export function ok(status: number, body: unknown): ServiceResult {
  return { status, body };
}

export function fail(status: number, message: string): ServiceResult {
  return { status, body: { error: { type: 'admin_api_error', message } } };
}

/** The error message inside a failed result's envelope (or a generic fallback). */
export function serviceErrorMessage(result: ServiceResult): string {
  const body = result.body as { error?: { message?: unknown } } | null;
  const message = body?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : `request failed (${result.status})`;
}
