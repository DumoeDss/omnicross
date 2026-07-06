/**
 * quotaWarn — the key.quotaWarning threshold helper (webhook-notifications,
 * design D3, Phase 2).
 *
 * A PURE crossing detector ({@link computeQuotaWarnings}) + a tiny module-level
 * "already warned this window" guard ({@link markQuotaWarnedOnce}). The wire
 * path (`outboundApiRouter`) computes warnings alongside the existing quota
 * check and emits `key.quotaWarning` ONCE per window-crossing — so a key sitting
 * above the warn ratio doesn't spam a webhook every request. The guard is keyed
 * by `keyId + scope + windowStart`, so a NEW day/week window re-arms the warning
 * naturally (its `windowStart` differs).
 *
 * @module @omnicross/core/outbound-api/quotaWarn
 */

import type { KeyCostLimits, KeySpend } from './keyPolicy';

/** Warn when accumulated spend reaches this fraction of a scope's limit (design OQ2). */
export const WEBHOOK_QUOTA_WARN_RATIO = 0.8;

/** A per-scope warning crossing (not-yet-exceeded, at/over the warn ratio). */
export interface QuotaWarning {
  scope: 'daily' | 'weekly' | 'total';
  limitUsd: number;
  spentUsd: number;
  /** The window boundary (epoch ms; `0` for the window-less `total` scope). */
  windowStart: number;
}

/**
 * Detect which cost scopes have crossed the warn ratio but are NOT yet exceeded
 * (an EXCEEDED scope is handled by `checkKeyQuota` → `key.quotaExceeded`, not a
 * warning). Pure — the caller owns the emit + the dedupe guard.
 */
export function computeQuotaWarnings(
  limits: KeyCostLimits,
  spend: KeySpend,
  ratio: number = WEBHOOK_QUOTA_WARN_RATIO,
): QuotaWarning[] {
  const out: QuotaWarning[] = [];
  const consider = (
    scope: QuotaWarning['scope'],
    limit: number | undefined,
    spent: number,
    windowStart: number,
  ): void => {
    if (limit == null || limit <= 0) return;
    if (spent >= limit) return; // exceeded ⇒ quotaExceeded owns it, not a warning
    if (spent >= ratio * limit) out.push({ scope, limitUsd: limit, spentUsd: spent, windowStart });
  };
  consider('daily', limits.dailyUsd, spend.dailyUsd, spend.dailyWindowStart);
  consider('weekly', limits.weeklyUsd, spend.weeklyUsd, spend.weeklyWindowStart);
  consider('total', limits.totalUsd, spend.totalUsd, 0);
  return out;
}

/** Bound on the dedupe set so a long-lived process can't grow it unboundedly. */
const WARN_GUARD_MAX = 10_000;
const warned = new Set<string>();

/**
 * Record a warning for `(keyId, scope, windowStart)` and return whether THIS is
 * the first time (⇒ the caller should emit). Subsequent calls in the same window
 * return `false` (deduped). A new window (different `windowStart`) re-arms.
 */
export function markQuotaWarnedOnce(keyId: string, scope: string, windowStart: number): boolean {
  const key = `${keyId}\0${scope}\0${windowStart}`;
  if (warned.has(key)) return false;
  if (warned.size >= WARN_GUARD_MAX) warned.clear();
  warned.add(key);
  return true;
}

/** TEST SEAM — clear the dedupe guard between suites. */
export function __resetQuotaWarnGuardForTests(): void {
  warned.clear();
}
