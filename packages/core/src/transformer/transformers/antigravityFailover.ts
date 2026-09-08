/**
 * antigravityFailover — the OPTIONAL production→sandbox endpoint failover for
 * the antigravity subscription (antigravity-subscription-provider design D5).
 *
 * The primary endpoint is `daily-cloudcode-pa.googleapis.com`; the failover
 * target is `daily-cloudcode-pa.sandbox.googleapis.com`. The switch is GATED
 * by the daemon config flag `antigravity.sandboxFailover` (default OFF):
 *   - OFF  ⇒ a retryable upstream error is NEVER switched (the original error
 *            semantics surface unchanged),
 *   - ON   ⇒ a RETRYABLE error (see `isAntigravityRetryableFailure`) on the
 *            primary endpoint swaps the NEXT attempt to the sandbox host.
 *
 * v1 deliberately has NO health-probe-driven auto-switching (design D5).
 *
 * The dispatch retry seams (the daemon `SubscriptionDispatcher` loop and the
 * core `/v1/messages` subscription retry wrapper) call
 * `maybeAntigravityFailoverUrl(currentUrl, status, bodyText)` after a failed
 * attempt; a non-null return is the URL to retry once.
 *
 * @module transformer/transformers/antigravityFailover
 */

import { ANTIGRAVITY_ENDPOINT } from './AntigravityTransformer';

/** The sandbox failover endpoint host base. */
export const ANTIGRAVITY_SANDBOX_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com';

/** Module-level switch, set by the daemon's config application (default OFF). */
let sandboxFailoverEnabled = false;

/** Set the failover switch (daemon `applyConfig` wires this; default OFF). */
export function setAntigravitySandboxFailover(enabled: boolean): void {
  sandboxFailoverEnabled = enabled;
}

/** Read the switch (tests + diagnostics). */
export function isAntigravitySandboxFailoverEnabled(): boolean {
  return sandboxFailoverEnabled;
}

/** Reset the switch + latch (test seam). */
export function __resetAntigravityFailoverState(): void {
  sandboxFailoverEnabled = false;
}

/**
 * Whether a failed antigravity attempt is RETRYABLE on the alternate endpoint
 * (aligned with the reference client's retryable classification):
 *   - transport errors (status-less throw — ECONNRESET/ETIMEDOUT shape),
 *   - 429 (rate limit),
 *   - 400/404 whose body reads as "model unavailable / not found" (the two
 *     environments route models differently),
 *   - 5xx (upstream-side failure).
 */
export function isAntigravityRetryableFailure(status: number | null, bodyText?: string): boolean {
  if (status === null) return true;
  if (status === 429 || status >= 500) return true;
  if (status === 400 || status === 404) {
    const message = (bodyText ?? '').toLowerCase();
    return (
      message.includes('requested model is currently unavailable') ||
      message.includes('requested entity was not found') ||
      message.includes('not found') ||
      message.includes('tool_use') ||
      message.includes('tool_result')
    );
  }
  return false;
}

/**
 * The failover decision for one failed attempt. Returns the SANDBOX URL to
 * retry when (a) the switch is ON, (b) the failure is retryable, and (c) the
 * failed URL was the PRIMARY endpoint (a sandbox failure never fails BACK to
 * production — one direction only); otherwise `null` (surface the original
 * error). `methodPath` is the tail of the failed URL (e.g.
 * `/v1internal:streamGenerateContent?alt=sse`) so the retry keeps the same
 * method.
 */
export function maybeAntigravityFailoverUrl(
  failedUrl: string,
  status: number | null,
  bodyText?: string,
  methodPath?: string,
): string | null {
  if (!sandboxFailoverEnabled) return null;
  if (!isAntigravityRetryableFailure(status, bodyText)) return null;
  let parsed: URL;
  try { parsed = new URL(failedUrl); } catch { return null; }
  if (parsed.origin !== ANTIGRAVITY_ENDPOINT) return null;
  const tail = methodPath ?? `${parsed.pathname}${parsed.search}`;
  return `${ANTIGRAVITY_SANDBOX_ENDPOINT}${tail.startsWith('/') ? tail : `/${tail}`}`;
}

export async function fetchWithAntigravityFailover(
  url: string,
  fetcher: (url: string) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    signal?.throwIfAborted();
    const fallback = maybeAntigravityFailoverUrl(url, null);
    if (!fallback) throw error;
    return fetcher(fallback);
  }
  if (!sandboxFailoverEnabled || response.ok) return response;
  const body = response.status === 400 || response.status === 404
    ? await response.clone().text().catch(() => '')
    : undefined;
  const fallback = maybeAntigravityFailoverUrl(url, response.status, body);
  if (!fallback) return response;
  await response.body?.cancel().catch(() => undefined);
  signal?.throwIfAborted();
  return fetcher(fallback);
}
