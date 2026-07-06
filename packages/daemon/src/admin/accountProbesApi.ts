/**
 * accountProbesApi — the AUTHED `GET /admin/api/account-probes` handler
 * (subscription-account-probe #8, design D5).
 *
 * The per-account probe history NAMES account ids (mildly sensitive), so unlike
 * the coarse `/health` boolean it is served ONLY behind the admin auth gate. This
 * lives in its OWN helper module (the #4/#10 helper-module convention) so
 * `adminApi.ts` — already at its line cap — is not touched: `AdminServer.dispatch`
 * routes the single path here directly, AFTER its auth gate.
 *
 * SECRET-FREE: it returns ids + labels-of-status only (ts/ok/status/latency/tier);
 * never a token/email/config value.
 *
 * @module @omnicross/daemon/admin/accountProbesApi
 */

import type { ServerResponse } from 'node:http';

import type { AccountProbeHistoryReader } from '../AccountHealthProbeScheduler';

/** Serve the per-account probe history (empty when probing is unwired/off). */
export function handleAccountProbes(
  res: ServerResponse,
  reader: AccountProbeHistoryReader | undefined,
): void {
  const accounts = reader ? reader.getAllHistory() : [];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ accounts }));
}
