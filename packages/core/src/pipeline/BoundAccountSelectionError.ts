/**
 * Secret-free failure contract for a strict outbound subscription-account
 * binding. The selector throws this value only when an endpoint explicitly (or
 * by the migrated default) requires its bound account to serve the request.
 */

/** Persisted policy for an endpoint that binds a subscription account. */
export type BoundAccountFallbackPolicy = 'strict' | 'pool';

/** Bounded reasons a strict bound account can refuse a request. */
export type BoundAccountSelectionFailureReason =
  | 'unavailable'
  | 'not-found'
  | 'disabled'
  | 'unhealthy'
  | 'model-incompatible'
  | 'allowance-paused'
  | 'empty-token';

const FAILURE_MESSAGES: Record<BoundAccountSelectionFailureReason, string> = {
  unavailable: 'Bound subscription account is unavailable',
  'not-found': 'Bound subscription account was not found',
  disabled: 'Bound subscription account is disabled',
  unhealthy: 'Bound subscription account is unhealthy',
  'model-incompatible': 'Bound subscription account cannot serve the requested model',
  'allowance-paused': 'Bound subscription account is paused by the allowance policy',
  'empty-token': 'Bound subscription account has no usable token',
};

/** Return the fixed public message for a validated failure reason. */
export function boundAccountSelectionMessage(
  reason: BoundAccountSelectionFailureReason,
): string {
  return FAILURE_MESSAGES[reason];
}

/**
 * Stable, non-secret error thrown by strict account selection. Account ids and
 * token material are intentionally absent from both the message and the wire
 * projection; the reason is a small fixed vocabulary.
 */
export class BoundAccountSelectionError extends Error {
  readonly code = 'bound_account_unavailable' as const;
  readonly status: 429 | 503;

  constructor(
    readonly providerId: string,
    readonly reason: BoundAccountSelectionFailureReason,
    readonly resumeAt?: string,
  ) {
    super(boundAccountSelectionMessage(reason));
    this.name = 'BoundAccountSelectionError';
    this.status = reason === 'allowance-paused' ? 429 : 503;
  }
}

/** Structural guard that survives package/bundle boundaries. */
export function isBoundAccountSelectionError(
  error: unknown,
): error is BoundAccountSelectionError {
  if (error instanceof BoundAccountSelectionError) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; reason?: unknown };
  return (
    value.code === 'bound_account_unavailable' &&
    (value.status === 429 || value.status === 503) &&
    typeof value.reason === 'string' &&
    Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, value.reason)
  );
}
