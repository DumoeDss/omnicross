/**
 * A request-lifecycle abort signal for handlers that EXECUTE rather than relay.
 *
 * Relay paths inherit cancellation from the stream they are piping: when the
 * client goes away, the pipe breaks and the upstream fetch is torn down. A
 * handler that does its own work between reading the request and writing the
 * response has no such inheritance — and neither serving face hands one down.
 * `handleOutboundRequest` in particular has no signal of its own to give, so a
 * router-level handler that omits this keeps working (and keeps making outbound
 * requests) for a client that hung up. For search that means sending the query
 * to every remaining fallback provider AFTER cancellation, which is exactly the
 * class 阶段3 hardened the orchestrator against.
 *
 * Lives in `pipeline/` because both serving faces already depend on this
 * directory, so neither has to import the other to get it.
 *
 * @module pipeline/requestLifecycleSignal
 */

import type http from 'node:http';

/**
 * A signal that aborts when the client goes away.
 *
 * Aborts on `req`'s `aborted` event, and on `res` closing before it finished
 * writing — a `close` after `writableEnded` is the normal end of a successful
 * response and must NOT look like a cancellation. Already-dead connections
 * abort synchronously, so a caller never starts work for a client that is
 * already gone.
 */
export function requestLifecycleSignal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (req.aborted || res.destroyed) abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}
