import type http from 'node:http';

export const DEFAULT_RESPONSES_TIMEOUT_MS = 120_000;

export class ResponsesRequestTimeoutError extends Error {
  readonly name = 'ResponsesRequestTimeoutError';
  readonly code = 'request_timeout';

  constructor() {
    super('Responses request timed out');
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
  readonly timeoutMs?: number;
}

function abortReason(signal: AbortSignal): unknown {
  return 'reason' in signal ? signal.reason : undefined;
}

/** Compose request disconnect, response close, parent cancellation and timeout into one scope. */
export function createResponsesAbortScope(options: ResponsesAbortScopeOptions): ResponsesAbortScope {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;
  const abort = (reason?: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = (): void => abort(abortReason(options.parentSignal!));
  const onRequestAborted = (): void => abort();
  const onRequestClose = (): void => {
    if (options.request?.aborted === true || options.request?.complete === false) abort();
  };
  const onResponseClose = (): void => {
    if (!options.response?.writableEnded) abort();
  };

  options.parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  options.request?.once('aborted', onRequestAborted);
  options.request?.once('close', onRequestClose);
  options.response?.once('close', onResponseClose);
  if (options.parentSignal?.aborted) onParentAbort();
  if (options.request?.aborted || options.response?.destroyed) abort();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const disableTimeout = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RESPONSES_TIMEOUT_MS);
  timer = setTimeout(() => {
    timer = undefined;
    timedOut = true;
    abort(new ResponsesRequestTimeoutError());
  }, timeoutMs);
  timer.unref?.();

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

export function throwIfResponsesAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = abortReason(signal);
  if (reason instanceof Error) throw reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}
