/**
 * Secret-free upstream subscription allowance contracts.
 *
 * These DTOs intentionally contain only normalized percentages, window metadata,
 * timestamps, and stable error codes. Raw provider headers, OAuth credentials,
 * account e-mail addresses, and upstream response bodies must never be added here.
 */

import type { SubscriptionProviderId } from './subscription-types';

/** Availability/freshness of one normalized allowance window. */
export type AllowanceWindowState = 'fresh' | 'stale' | 'unavailable' | 'unsupported';

/** A single provider allowance window (for example five hours or seven days). */
export type AllowanceWindow = {
  /** Stable machine id (`five-hour`, `seven-day`, `primary`, ...). */
  id: string;
  /** Display-safe fallback label. UIs may localize from `id` instead. */
  label: string;
  /** Whether this window applies to the full account or one model family. */
  scope: 'all' | 'model-family';
  /** Present only when `scope` is `model-family`. */
  modelFamily?: string;
  /** Provider-reported percentage used; `null` means the value is unavailable. */
  usedPercent: number | null;
  /** Provider-reported window duration, when known. */
  windowMinutes?: number;
  /** Absolute reset instant, normalized to ISO-8601, when known. */
  resetsAt?: string;
  /** Remaining whole seconds at the time this DTO was materialized. */
  remainingSeconds?: number;
  state: AllowanceWindowState;
};

/**
 * Secret-free allowance snapshot for exactly one stored subscription account.
 */
export type AccountAllowanceSnapshot = {
  providerId: SubscriptionProviderId;
  /** Omnicross's stable account-entry id, not an upstream account identifier. */
  accountId: string;
  source: 'oauth-usage-api' | 'response-headers';
  /** Last successful observation, or the attempted-at instant for an unavailable result. */
  observedAt: string;
  /** Freshness deadline; fresh windows become stale after this instant. */
  expiresAt?: string;
  windows: AllowanceWindow[];
  /** Stable, display-safe diagnostic code. Never an upstream body or token. */
  lastErrorCode?: string;
  /**
   * Codex's normalized primary-over-secondary ratio, when supplied. This is the
   * numeric value only; the original response header is never retained.
   */
  primaryOverSecondaryLimitPercent?: number;
};
