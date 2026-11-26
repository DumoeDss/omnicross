/**
 * HostError — the single error type the embedding entry throws.
 *
 * `code` is stable and machine-readable: route-lease failures keep the lease
 * contract's codes (`upstream_not_found`, `upstream_exhausted`, …); admin
 * service failures map their HTTP-style status to a small vocabulary
 * (`invalid_request`, `not_found`, `conflict`, `gone`, `unavailable`,
 * `upstream_error`, `internal_error`). `message` never contains key material.
 *
 * @module @omnicross/daemon/embed/errors
 */

import { RouteLeaseError, type RouteLeaseErrorCode } from '@omnicross/core/provider-proxy';

import { type ServiceResult, serviceErrorMessage } from '../service/result';

export type HostErrorCode =
  | RouteLeaseErrorCode
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'unavailable'
  | 'upstream_error'
  | 'internal_error'
  | 'host_conflict'
  | 'host_stopped';

export class HostError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: HostErrorCode,
    /** HTTP-style status, for hosts that forward errors over their own API. */
    readonly status: number,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HostError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const STATUS_CODES: Readonly<Record<number, HostErrorCode>> = {
  400: 'invalid_request',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  501: 'unavailable',
  502: 'upstream_error',
  503: 'unavailable',
};

/** Convert a failed service result into a {@link HostError}. */
export function hostErrorFromResult(result: ServiceResult): HostError {
  const code = STATUS_CODES[result.status] ?? (result.status >= 500 ? 'internal_error' : 'invalid_request');
  return new HostError(code, result.status, serviceErrorMessage(result), {
    retryable: result.status === 502 || result.status === 503,
  });
}

/** Convert anything a lease operation threw into a {@link HostError}. */
export function hostErrorFromLease(error: unknown): HostError {
  if (error instanceof HostError) return error;
  if (error instanceof RouteLeaseError) {
    return new HostError(error.code, error.status, error.message, {
      retryable: error.retryable,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      cause: error,
    });
  }
  return new HostError('internal_error', 500, 'route lease operation failed', { cause: error });
}
