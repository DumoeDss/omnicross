import type { RouteLeaseManager } from '@omnicross/core/provider-proxy';

export const TERMINAL_LEASE_TTL_SECONDS = 600;
export const TERMINAL_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
export const TERMINAL_LEASE_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Keep a built-in terminal lease alive while retaining a hard orphan bound. */
export function startTerminalLeaseRenewal(
  manager: Pick<RouteLeaseManager, 'renew'>,
  leaseId: string,
): () => void {
  const stopAt = Date.now() + TERMINAL_LEASE_MAX_LIFETIME_MS;
  const timer = setInterval(() => {
    if (Date.now() >= stopAt) {
      clearInterval(timer);
      return;
    }
    try {
      manager.renew(leaseId, TERMINAL_LEASE_TTL_SECONDS);
    } catch {
      clearInterval(timer);
    }
  }, TERMINAL_LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
