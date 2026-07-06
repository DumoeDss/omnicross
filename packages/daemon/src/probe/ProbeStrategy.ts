/**
 * ProbeStrategy — the per-provider two-tier probe plan
 * (subscription-account-probe #8, design D1).
 *
 * A `ProbePlan` says HOW to probe one provider's account, cheapest signal first:
 *  - `{ kind: 'local' }` — no upstream call. The scheduler's free local tier reads
 *    the account's token via the credential store; a missing/expired-unrefreshable
 *    token is a dead account (recorded as a synthesized 401). A provider is
 *    local-only until a cheap authed GET endpoint is VERIFIED (the omnicross
 *    `// UNVERIFIED` convention) — Phase 1 ships codex/gemini/opencodego local-only
 *    (LEAD OQ1: never GUESS a billable/wrong endpoint).
 *  - `{ kind: 'upstream'; url; buildInit(token) }` — a minimal AUTHED GET the
 *    scheduler issues through #3's proxy-aware `fetchUpstream`. Phase 1 wires ONLY
 *    claude → `GET https://api.anthropic.com/v1/models` (a verified free list;
 *    NEVER a billable completion). The scheduler adds the timeout `signal` +
 *    `{ providerId, accountId }` ctx; `buildInit` supplies method + auth header.
 *
 * NEVER put a body / max_tokens here — a probe must cost nothing (design D1).
 *
 * @module @omnicross/daemon/probe/ProbeStrategy
 */

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

/** How to probe one provider's account (design D1). */
export type ProbePlan =
  | { kind: 'local' }
  | {
      kind: 'upstream';
      /** The cheap, free, authed GET endpoint. */
      url: string;
      /** Build the minimal request init (method + Authorization only — no body). */
      buildInit(token: string): RequestInit;
    };

/**
 * Per-provider probe plans (design D1, Phase 1). claude has a VERIFIED free
 * endpoint (`GET /v1/models`); the rest are local-only until theirs is confirmed.
 */
export const PROVIDER_PROBE_PLANS: Record<SubscriptionProviderId, ProbePlan> = {
  claude: {
    kind: 'upstream',
    // VERIFIED free authed list endpoint (no tokens billed). The anthropic OAuth
    // bearer is accepted here exactly as on the relay path.
    url: 'https://api.anthropic.com/v1/models',
    buildInit: (token) => ({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
    }),
  },
  // UNVERIFIED cheap authed GET — Phase 1 local-only (LEAD OQ1: do not guess a
  // billable/wrong endpoint). Upgrade to `{ kind:'upstream' }` once verified.
  codex: { kind: 'local' },
  gemini: { kind: 'local' },
  opencodego: { kind: 'local' },
};

/** Resolve the probe plan for a provider (defaults to local for an unknown id). */
export function probePlanFor(providerId: string): ProbePlan {
  return PROVIDER_PROBE_PLANS[providerId as SubscriptionProviderId] ?? { kind: 'local' };
}
