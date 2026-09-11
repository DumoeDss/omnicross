/**
 * testEgressIdentity — the outbound identity the admin probe paths
 * (discover-models / test-model) present to upstreams.
 *
 * WHY THIS EXISTS: those two admin handlers build their request headers inline
 * and fetch via `fetchUpstream` directly — they never pass through a provider's
 * auth strategy, so unaided their egress carries Node's default `user-agent:
 * node` and no session hint at all. That is exactly the "too generic" shape
 * gateways such as opencode.ai flag (opencodego-egress-identity): the relay
 * paths present `omnicross/<version>` (+ `x-opencode-session`), while the admin
 * connectivity test against the same upstream was rejected — the model test
 * failed even though real traffic worked.
 *
 * RULES (fill-only defaults — the row's own `extraHeaders` always win):
 *  - `user-agent`: the SAME library identity the OpenCodeGo relay presents
 *    (`getOpenCodeGoUserAgent()`: the configured embedding-app UA, else the
 *    `omnicross/<version>` product default) — one identity seam, so an
 *    embedding app brands its admin probes exactly like its relay egress, and
 *    no probe ever falls back to the bare `node` default.
 *  - `x-opencode-session`: ONLY for rows whose `baseUrl` host is `opencode.ai`
 *    (apex or a subdomain — the zen gateway lives at `opencode.ai/zen/...`) —
 *    other upstreams never see the opencode-specific header. The value is a
 *    fixed, clearly-labeled sentinel: the probe is a one-shot connectivity
 *    check with no conversation to key, and a stable value keeps the upstream's
 *    cache affinity from fragmenting across repeated tests.
 *
 * Both names are absent from `EXTRA_HEADER_RESERVED_NAMES`, so a row may still
 * pin either explicitly via `extraHeaders`; the case-insensitive fill check
 * honors any spelling of the row's own header.
 *
 * Pure module — no I/O, never throws; mutates the caller's header bag in place
 * (the `expandRowExtraHeaders` merge idiom).
 *
 * @module daemon/admin/testEgressIdentity
 */

import {
  getOpenCodeGoUserAgent,
  OPENCODE_SESSION_HEADER,
} from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';

/** The session value admin probes present to opencode.ai upstreams. */
export const ADMIN_PROBE_OPENCODE_SESSION = 'omnicross-admin-probe';

/** Whether a provider `baseUrl` points at opencode.ai (apex or any subdomain). */
export function isOpenCodeUpstream(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/** Case-insensitive header-name presence over a plain string bag. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Fill the probe egress identity defaults into `headers` IN PLACE. Call AFTER
 * the row's `extraHeaders` merge (`expandRowExtraHeaders`) so an explicit
 * row-level `user-agent` / `x-opencode-session` always wins.
 */
export function applyAdminProbeIdentity(
  headers: Record<string, string>,
  row: { baseUrl?: string },
): void {
  if (!hasHeader(headers, 'user-agent')) {
    headers['user-agent'] = getOpenCodeGoUserAgent();
  }
  if (isOpenCodeUpstream(row.baseUrl) && !hasHeader(headers, OPENCODE_SESSION_HEADER)) {
    headers[OPENCODE_SESSION_HEADER] = ADMIN_PROBE_OPENCODE_SESSION;
  }
}
