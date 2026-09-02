import type http from 'node:http';

export const DEFAULT_RESPONSES_TIMEOUT_MS = 120_000;

export class ResponsesRequestTimeoutError extends Error {
  readonly name = 'ResponsesRequestTimeoutError';
  readonly code = 'request_timeout';

  constructor() {
    super('Responses request timed out');
  }
}

/**
 * Abort reason meaning "the DOWNSTREAM client withdrew this request" (its socket
 * closed, or the response closed before it was written) - as opposed to a
 * timeout, which is OUR decision and a genuine failure.
 *
 * Carried as the signal's `reason` so the shared egress seam can tell the two
 * apart. `upstreamFetch` records a route-activity row for every failed attempt;
 * a withdrawn request is not an account failure, and recording it paints a red
 * "Network error" row indistinguishable from a real DNS/connection fault. That
 * seam recognizes this by the stable `code` (the `isAccountAllowanceExhaustedError`
 * idiom) rather than importing this class: `pipeline` must not depend on
 * `provider-proxy`.
 */
export class ClientDisconnectError extends Error {
  readonly name = 'ClientDisconnectError';
  readonly code = 'client_disconnect';

  constructor() {
    super('The downstream client disconnected');
  }
}

export interface ResponsesAbortScope {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  disableTimeout(): void;
  dispose(): void;
}

export interface ResponsesAbortScopeOptions {
  readonly request?: http.IncomingMessage;
  readonly response?: http.ServerResponse;
  readonly parentSignal?: AbortSignal;
  /**
   * Total-duration guard. Omitted ⇒ {@link DEFAULT_RESPONSES_TIMEOUT_MS}.
   * `null` ⇒ NO timer is ever armed — the scope aborts on disconnect only.
   * That is the Anthropic ingress's shape: `/v1/messages` has never carried a
   * total-duration cap (a long thinking turn is not a stall), and adding one
   * here would truncate exactly the requests the cancellation work is meant to
   * protect. Disconnect cancellation and duration limits stay separate concerns.
   */
  readonly timeoutMs?: number | null;
}

function abortReason(signal: AbortSignal): unknown {
  return 'reason' in signal ? signal.reason : undefined;
}

/**
 * Compose request disconnect, response close, parent cancellation and (optionally)
 * a total-duration timeout into ONE scope.
 *
 * Ingress-agnostic despite the module name: the Responses ingress was simply the
 * first caller. The Anthropic `/v1/messages` ingress composes the same scope with
 * `timeoutMs: null` so a downstream hang-up cancels the upstream fetch/body while
 * a long-running turn is never capped.
 */
export function createRequestAbortScope(options: ResponsesAbortScopeOptions): ResponsesAbortScope {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = (): void => abort(abortReason(options.parentSignal!));
  const onRequestAborted = (): void => abort(new ClientDisconnectError());
  const onRequestClose = (): void => {
    if (options.request?.aborted === true || options.request?.complete === false) {
      abort(new ClientDisconnectError());
    }
  };
  const onResponseClose = (): void => {
    if (!options.response?.writableEnded) abort(new ClientDisconnectError());
  };

  options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  options.request?.once('aborted', onRequestAborted);
  options.request?.once('close', onRequestClose);
  options.response?.once('close', onResponseClose);
  if (options.parentSignal?.aborted) onParentAbort();
  if (options.request?.aborted || options.response?.destroyed) abort(new ClientDisconnectError());

  let timer: ReturnType<typeof setTimeout> | undefined;
  const disableTimeout = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  if (options.timeoutMs !== null) {
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RESPONSES_TIMEOUT_MS);
    timer = setTimeout(() => {
      timer = undefined;
      timedOut = true;
      abort(new ResponsesRequestTimeoutError());
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    disableTimeout,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disableTimeout();
      options.parentSignal?.removeEventListener('abort', onParentAbort);
      options.request?.removeListener('aborted', onRequestAborted);
      options.request?.removeListener('close', onRequestClose);
      options.response?.removeListener('close', onResponseClose);
    },
  };
}

/**
 * Historical name kept for the Responses ingress + its tests. Identical to
 * {@link createRequestAbortScope}.
 */
export const createResponsesAbortScope = createRequestAbortScope;

export function throwIfResponsesAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = abortReason(signal);
  if (reason instanceof Error) throw reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}
