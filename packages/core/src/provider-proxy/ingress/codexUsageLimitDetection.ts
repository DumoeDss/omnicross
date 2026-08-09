/**
 * codexUsageLimitDetection — recognize the Codex weekly usage-limit / credit
 * wall in a relayed upstream error body and mark the serving account
 * quota-exhausted so NEW sessions divert to the next account/route.
 *
 * WHY a dedicated path (not the status-based health marker): when a Codex
 * account's weekly window is exhausted, the account's IN-FLIGHT sessions keep
 * returning 2xx (Codex does not kill them mid-session). Those 2xx would
 * immediately clear a transient/rate-limit mark, re-stranding every NEW session
 * onto the exhausted account. `markQuotaExhausted` sets a mark that a 2xx does
 * NOT clear (it self-heals only at its deadline), which is exactly what this
 * mixed-traffic situation needs.
 *
 * The deadline is resolved, in order of reliability:
 *   1. the allowance snapshot's weekly-window `resetsAt` (structured, absolute);
 *   2. the "try again at <date>" parsed from the error body;
 *   3. a bounded default TTL (re-armed on every subsequent hit, so it never
 *      under-runs the real window).
 *
 * @module provider-proxy/ingress/codexUsageLimitDetection
 */

import { getSharedAccountAllowanceStore } from '../../pipeline/AccountAllowanceStore';
import { getSharedAccountHealth } from '../../pipeline/SubscriptionAccountHealth';

const PROVIDER_ID = 'codex' as const;

/**
 * Body markers that identify the Codex usage-limit wall. The settings URL is the
 * most specific; the others cover localized/variant phrasing. Matched
 * case-insensitively against the first few KB of the body only.
 */
const CODEX_USAGE_LIMIT_MARKERS = [
  'chatgpt.com/codex/settings/usage',
  'purchase more credits',
  "you've hit your usage limit",
  'you have hit your usage limit',
] as const;

/** Bounded default cooldown when no structured/parsed deadline is resolvable. */
const DEFAULT_QUOTA_COOLDOWN_MS = 30 * 60_000;

/** Only scan the leading slice of a (potentially large) error body. */
const BODY_SCAN_LIMIT = 4096;

/** Whether a relayed upstream body looks like the Codex usage-limit wall. */
export function isCodexUsageLimitError(bodyText: string | null | undefined): boolean {
  if (!bodyText) return false;
  const lower = bodyText.slice(0, BODY_SCAN_LIMIT).toLowerCase();
  return CODEX_USAGE_LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Parse a "try again at Aug 16th, 2026 3:12 PM" hint into epoch ms. Ordinal
 * suffixes (16th) are stripped so `Date.parse` accepts the result. Returns
 * `undefined` when absent or unparseable. The wall message is English; a
 * localized variant simply falls through to another deadline source.
 */
function parseTryAgainDeadline(bodyText: string): number | undefined {
  const match = bodyText.match(/try again (?:at|on)\s+(.+?)(?:[.\n]|$)/i);
  if (!match) return undefined;
  const cleaned = match[1].replace(/(\d+)(st|nd|rd|th)/giu, '$1').trim();
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The weekly-window reset from the passive allowance snapshot. Absolute and
 * unaffected by the usage-percent staleness flip, so it remains usable as a
 * deadline even after the account stops returning successful responses.
 */
function deadlineFromAllowanceSnapshot(accountId: string, now: number): number | undefined {
  const snapshot = getSharedAccountAllowanceStore().get(PROVIDER_ID, accountId, now);
  if (!snapshot) return undefined;
  for (const window of snapshot.windows) {
    if (!window.resetsAt) continue;
    const ms = Date.parse(window.resetsAt);
    if (Number.isFinite(ms) && ms > now) return ms;
  }
  return undefined;
}

/** Resolve the quota cooldown deadline (epoch ms), never `NaN`. See module doc. */
export function resolveCodexQuotaDeadline(
  accountId: string,
  bodyText: string,
  now: number = Date.now(),
): number {
  const parsed = parseTryAgainDeadline(bodyText);
  // A parsed date must be in the future; a past parse (TZ skew / already-reset
  // window / localization mismatch) is unusable and falls through to the TTL.
  const parsedDeadline = parsed !== undefined && parsed > now ? parsed : undefined;
  return (
    deadlineFromAllowanceSnapshot(accountId, now) ??
    parsedDeadline ??
    now + DEFAULT_QUOTA_COOLDOWN_MS
  );
}

/**
 * Mark the Codex account that served a usage-limit error as quota-exhausted.
 * No-op when `accountId` is absent (BYO / single-account path that never
 * reported a selection). Safe to call after the error has already been relayed
 * to the client — the mark diverts the NEXT new session, not the current one.
 */
export function markCodexUsageLimitExhaustion(
  accountId: string | undefined,
  bodyText: string,
  now: number = Date.now(),
): void {
  if (!accountId) return;
  const deadline = resolveCodexQuotaDeadline(accountId, bodyText, now);
  getSharedAccountHealth().markQuotaExhausted(PROVIDER_ID, accountId, deadline, now);
}
