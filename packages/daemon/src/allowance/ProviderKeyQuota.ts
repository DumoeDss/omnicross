/**
 * ProviderKeyQuota — BYO provider-row key quota parsing (pure functions).
 *
 * Subscription accounts have the daemon's allowance collectors; BYO rows (API
 * keys pasted from a provider console) had NO quota surface at all. Several CN
 * coding-plan providers expose a same-key usage endpoint:
 *
 *  - Z.AI / Zhipu bigmodel (GLM Coding Plan):
 *      GET {origin}/api/monitor/usage/quota/limit
 *      Raw `Authorization: <key>` (NO Bearer prefix). Envelope
 *      `{success, data: {limits[], level}}`; each limit carries
 *      `{type, usage(limit), currentValue(used), percentage, remaining,
 *        nextResetTime, unit(3=h/4=d/5=mo/6=w), number, usageDetails[]}`.
 *      A coding-plan key reports 5h + weekly credit windows; a PAYG key's shape
 *      is unknown → defensive parse, unavailable on surprise.
 *  - MiniMax Token Plan:
 *      GET {origin}/v1/token_plan/remains
 *      `Authorization: Bearer <key>`. HTTP is ALWAYS 200 — `base_resp
 *      .status_code === 0` is the real success gate. `model_remains[]` buckets
 *      each carry a rolling interval + weekly window as REMAINING percent
 *      (0-100); the `"general"` bucket is the plan-wide shared quota.
 *  - Cline Pass:
 *      GET {origin}/api/v1/users/me/plan/usage-limits
 *      `Authorization: Bearer <key>` PLUS the Cline client-identity header set
 *      (the row's `extraHeaders` — the gateway 403s without the full mirror).
 *      `limits[]` rows carry `{type: five_hour|weekly|monthly, percentUsed,
 *      resetsAt}` — pure percentage windows, no absolute meters.
 *
 * Everything here is pure; the fetch/cache lifecycle lives in
 * `ProviderKeyQuotaService`. Windows reuse the subscription `AllowanceWindow`
 * DTO so the UI renders one shape.
 */

import type { AllowanceWindow } from '@omnicross/contracts/account-allowance-types';

/** Which quota adapter applies to a provider row (by resolved endpoint). */
export type ProviderKeyQuotaAdapter =
  | 'zai'
  | 'minimax-token-plan'
  | 'umans'
  | 'synthetic'
  | 'cline-pass';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function finitePercent(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed <= 100 ? parsed : null;
}

function isoInstant(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  const numeric = finiteNumber(value);
  if (numeric !== undefined && numeric > 1_000_000_000) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Detect the quota adapter for a provider row's RESOLVED base URL. Detection is
 * deliberately narrow (host + path markers), because the quota endpoint is tied
 * to the plan product, not just the vendor:
 *  - zai: the CODING-PLAN faces — `/api/coding/` (openai) and `/api/anthropic`
 *    (the Claude Code face; same plan credential, same origin-derived monitor);
 *    the PAYG `/api/paas/v4` endpoint bypasses plan quota and its keys' monitor
 *    shape is unverified;
 *  - minimax: the openai-format `/v1` chat endpoint the Token Plan key rides.
 */
export function detectProviderKeyQuotaAdapter(baseUrl: string | undefined): ProviderKeyQuotaAdapter | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (
    (host === 'api.z.ai' || host === 'open.bigmodel.cn') &&
    (path.includes('/coding') || path.includes('/anthropic'))
  ) {
    return 'zai';
  }
  if (
    (host === 'api.minimax.io' || host === 'api.minimaxi.com') &&
    // Token Plan rides the plain openai `/v1` (chat completions) surface; the
    // anthropic `/anthropic` rows are excluded (their usage impl is unverified).
    (path === '/v1' || path === '/v1/' || path === '' || path === '/')
  ) {
    return 'minimax-token-plan';
  }
  if (host === 'api.code.umans.ai') return 'umans';
  if (host === 'api.synthetic.new') return 'synthetic';
  if (host === 'api.cline.bot') return 'cline-pass';
  return null;
}

/** Absolute quota endpoint for an adapter, derived from the row's base origin. */
export function providerKeyQuotaUrl(adapter: ProviderKeyQuotaAdapter, baseUrl: string): string {
  const origin = new URL(baseUrl).origin;
  if (adapter === 'zai') return `${origin}/api/monitor/usage/quota/limit`;
  if (adapter === 'minimax-token-plan') return `${origin}/v1/token_plan/remains`;
  if (adapter === 'umans') return `${origin}/v1/usage`;
  if (adapter === 'cline-pass') return `${origin}/api/v1/users/me/plan/usage-limits`;
  return `${origin}/v2/quotas`; // synthetic (NOT under the /openai prefix)
}

/** How the adapter authenticates: Z.AI wants the RAW key, everyone else a Bearer. */
export function providerKeyQuotaAuthHeader(adapter: ProviderKeyQuotaAdapter, key: string): string {
  return adapter === 'zai' ? key : `Bearer ${key}`;
}

// ── Z.AI ──────────────────────────────────────────────────────────────────────

interface ZaiLimitItem {
  type: 'TOKENS_LIMIT' | 'TIME_LIMIT' | 'CREDIT_LIMIT' | (string & {});
  /** The plan's allotment (the LIMIT, despite the name). */
  usage?: number;
  currentValue?: number;
  percentage?: number;
  remaining?: number;
  nextResetTime?: string;
  /** 3=hours, 4=days, 5=months, 6=week. */
  unit?: number;
  /** Window count (5h → 5). */
  number?: number;
}

function zaiWindowDurationMs(item: ZaiLimitItem): number | undefined {
  const count = item.number !== undefined && item.number > 0 ? item.number : 1;
  switch (item.unit) {
    case 3: return count * HOUR_MS;
    case 4: return count * DAY_MS;
    case 5: return count * MONTH_MS;
    case 6: return WEEK_MS;
    default: return undefined;
  }
}

function zaiWindowIdLabel(durationMs: number | undefined): { id: string; label: string } {
  if (durationMs === WEEK_MS) return { id: 'seven-day', label: '7 days' };
  if (durationMs === 5 * HOUR_MS) return { id: 'five-hour', label: '5 hours' };
  if (durationMs === MONTH_MS) return { id: 'thirty-day', label: '30 days' };
  if (durationMs !== undefined && durationMs % DAY_MS === 0) {
    const days = durationMs / DAY_MS;
    return { id: `${days}d`, label: `${days} day${days === 1 ? '' : 's'}` };
  }
  if (durationMs !== undefined && durationMs % HOUR_MS === 0) {
    const hours = durationMs / HOUR_MS;
    return { id: `${hours}h`, label: `${hours} hour${hours === 1 ? '' : 's'}` };
  }
  return { id: 'quota', label: 'Quota' };
}

/**
 * Parse the Z.AI quota payload. Mirrors oh-my-pi's semantics:
 *  - absolute meters (`currentValue`/`usage`) beat the server-rounded
 *    `percentage` (1438/12000 reports as 11, not 11.98);
 *  - mixed meters (credits + requests + tokens) can repeat a window — keep the
 *    most-binding (highest pressure) limit per window id;
 *  - CREDIT_LIMIT is the GLM Coding Plan's meter; the Zread feature quota
 *    (usageDetails with search-prime/web-reader/zread) is skipped — it is a
 *    per-feature count, not the plan quota.
 */
export function parseZaiQuotaPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload['data']) ? (payload['data'] as Record<string, unknown>) : payload;
  if (payload['success'] === false) return null;
  const limits = Array.isArray(data['limits']) ? data['limits'] : [];
  const byWindow = new Map<string, AllowanceWindow>();
  for (const raw of limits) {
    if (!isRecord(raw)) continue;
    const item = raw as unknown as ZaiLimitItem;
    if (item.type === undefined) continue;
    // Zread/feature quotas (search-prime, web-reader, zread details) are not
    // plan-quota windows.
    const details = raw['usageDetails'];
    if (Array.isArray(details) && details.some((d) => isRecord(d) && d['modelCode'] === 'zread')) {
      continue;
    }
    const durationMs = zaiWindowDurationMs(item);
    const { id, label } = zaiWindowIdLabel(durationMs);
    const limit = finiteNumber(item.usage);
    const used = finiteNumber(item.currentValue);
    const fromAbsolute = limit !== undefined && used !== undefined && limit > 0
      ? Math.min(100, (used / limit) * 100)
      : undefined;
    const fromPercentage = finitePercent(item.percentage) ?? undefined;
    const usedPercent =
      fromAbsolute !== undefined
        ? Math.round(fromAbsolute * 10) / 10
        : fromPercentage;
    if (usedPercent === undefined) continue;
    const resetsAt = isoInstant(item.nextResetTime);
    const candidate: AllowanceWindow = {
      id,
      label,
      scope: 'all',
      usedPercent,
      ...(durationMs !== undefined ? { windowMinutes: Math.round(durationMs / MINUTE_MS) } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    };
    const existing = byWindow.get(id);
    if (!existing || (candidate.usedPercent ?? 0) > (existing.usedPercent ?? 0)) {
      byWindow.set(id, candidate);
    }
  }
  const windows = [...byWindow.values()].sort((a, b) =>
    (a.windowMinutes ?? Number.POSITIVE_INFINITY) - (b.windowMinutes ?? Number.POSITIVE_INFINITY));
  return windows.length > 0 ? windows.slice(0, 4) : null;
}

// ── MiniMax Token Plan ────────────────────────────────────────────────────────

const MINIMAX_STATUS_EXHAUSTED = 2;
const MINIMAX_STATUS_UNLIMITED = 3;
const MINIMAX_SHARED_BUCKET = 'general';

interface MiniMaxBucket {
  modelName: string;
  intervalEnd?: number;
  intervalRemainingPercent?: number;
  intervalStatus?: number;
  weeklyEnd?: number;
  weeklyRemainingPercent?: number;
  weeklyStatus?: number;
}

function parseMiniMaxBucket(value: unknown): MiniMaxBucket | null {
  if (!isRecord(value)) return null;
  const modelName = typeof value['model_name'] === 'string' ? value['model_name'].trim() : '';
  if (!modelName) return null;
  const instant = (v: unknown) => {
    const n = finiteNumber(v);
    return n !== undefined && n > 1_000_000_000 ? (n > 1e12 ? n : n * 1000) : undefined;
  };
  return {
    modelName,
    intervalEnd: instant(value['end_time']),
    intervalRemainingPercent: finiteNumber(value['current_interval_remaining_percent']),
    intervalStatus: finiteNumber(value['current_interval_status']),
    weeklyEnd: instant(value['weekly_end_time']),
    weeklyRemainingPercent: finiteNumber(value['current_weekly_remaining_percent']),
    weeklyStatus: finiteNumber(value['current_weekly_status']),
  };
}

function minimaxWindow(
  id: string,
  label: string,
  windowMinutes: number | undefined,
  resetsAtMs: number | undefined,
  remainingPercent: number | undefined,
  status: number | undefined,
  now: number,
): AllowanceWindow {
  // The endpoint's own status outranks the percentage: an exhausted window may
  // omit the percentage or keep a stale one.
  const usedPercent = status === MINIMAX_STATUS_EXHAUSTED
    ? 100
    : remainingPercent !== undefined
      ? Math.round((100 - remainingPercent) * 10) / 10
      : null;
  const resetsAt = resetsAtMs !== undefined ? new Date(resetsAtMs).toISOString() : undefined;
  return {
    id,
    label,
    scope: 'all',
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    remainingSeconds: secondsUntil(resetsAt, now),
    state: usedPercent !== null ? 'fresh' : 'unavailable',
  };
}

/**
 * Parse the MiniMax Token Plan payload. Only the plan-wide `"general"` bucket is
 * reported — per-model buckets would overflow the display and the shared quota
 * is what actually gates coding traffic. An out-of-plan model reports both
 * windows unlimited with zero totals (MiniMax CLI #173); the general bucket is
 * never that placeholder.
 */
export function parseMiniMaxTokenPlanPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const baseResp = payload['base_resp'];
  if (!isRecord(baseResp) || baseResp['status_code'] !== 0) return null;
  const buckets = Array.isArray(payload['model_remains']) ? payload['model_remains'] : [];
  let general: MiniMaxBucket | null = null;
  for (const raw of buckets) {
    const bucket = parseMiniMaxBucket(raw);
    if (bucket?.modelName === MINIMAX_SHARED_BUCKET) {
      general = bucket;
      break;
    }
  }
  if (!general) return null;
  return [
    minimaxWindow(
      'five-hour',
      '5 hours',
      5 * 60,
      general.intervalEnd,
      general.intervalRemainingPercent,
      general.intervalStatus,
      now,
    ),
    minimaxWindow(
      'seven-day',
      '7 days',
      Math.round(WEEK_MS / MINUTE_MS),
      general.weeklyEnd,
      general.weeklyRemainingPercent,
      general.weeklyStatus,
      now,
    ),
  ];
}

// ── Umans AI Coding Plan ──────────────────────────────────────────────────────

/**
 * Parse the Umans `/v1/usage` payload. The plan meters a rolling 5h window TWO
 * ways: a soft cap on weighted requests (only warns — never blocks) and a hard
 * cap on RAW requests (the binding limit). Only the hard cap is reported as the
 * five-hour window: judging exhaustion by the soft meter would strand keys that
 * still have weighted headroom (oh-my-pi #7858). `resets_at` is the rolling
 * window's next tick — a countdown, not a hard reset.
 */
export function parseUmansUsagePayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const limits = isRecord(payload['limits']) ? payload['limits'] : undefined;
  const requests = limits && isRecord(limits['requests']) ? limits['requests'] : undefined;
  const usage = isRecord(payload['usage']) ? payload['usage'] : undefined;
  const window = isRecord(payload['window']) ? payload['window'] : undefined;

  const hardCap = finiteNumber(requests?.['hard_cap']);
  const softLimit = finiteNumber(requests?.['limit']);
  const requestsInWindow = finiteNumber(usage?.['requests_in_window']);
  const weightedInWindow = finiteNumber(usage?.['weighted_in_window']);
  const resetsAt = isoInstant(window?.['resets_at']);

  let usedPercent: number | null = null;
  if (hardCap !== undefined && hardCap > 0 && requestsInWindow !== undefined) {
    usedPercent = Math.round(Math.min(100, (requestsInWindow / hardCap) * 100) * 10) / 10;
  } else if (softLimit !== undefined && softLimit > 0 && weightedInWindow !== undefined) {
    usedPercent = Math.round(Math.min(100, (weightedInWindow / softLimit) * 100) * 10) / 10;
  }
  if (usedPercent === null && resetsAt === undefined) return null;
  return [
    {
      id: 'five-hour',
      label: '5 hours',
      scope: 'all',
      usedPercent,
      windowMinutes: 5 * 60,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    },
  ];
}

// ── Synthetic ─────────────────────────────────────────────────────────────────

/**
 * Parse the Synthetic `/v2/quotas` payload: a 5h rolling REQUEST budget that
 * regrows a fraction per tick (`nextTickAt`), and a weekly USD credit window
 * (`percentRemaining` + `nextRegenAt`). Both map onto percent windows; the tick
 * vs hard-reset distinction only affects the displayed reset instant.
 */
export function parseSyntheticQuotasPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const fiveHour = isRecord(payload['rollingFiveHourLimit']) ? payload['rollingFiveHourLimit'] : undefined;
  const weekly = isRecord(payload['weeklyTokenLimit']) ? payload['weeklyTokenLimit'] : undefined;

  const windows: AllowanceWindow[] = [];
  if (fiveHour) {
    const max = finiteNumber(fiveHour['max']);
    const remaining = finiteNumber(fiveHour['remaining']);
    const usedPercent =
      max !== undefined && max > 0 && remaining !== undefined
        ? Math.round(Math.min(100, ((max - remaining) / max) * 100) * 10) / 10
        : null;
    const resetsAt = isoInstant(fiveHour['nextTickAt']);
    windows.push({
      id: 'five-hour',
      label: '5 hours',
      scope: 'all',
      usedPercent,
      windowMinutes: 5 * 60,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
    });
  }
  if (weekly) {
    const percentRemaining = finiteNumber(weekly['percentRemaining']);
    const usedPercent = percentRemaining !== undefined
      ? Math.round(Math.min(100, Math.max(0, 100 - percentRemaining)) * 10) / 10
      : null;
    const resetsAt = isoInstant(weekly['nextRegenAt']);
    windows.push({
      id: 'seven-day',
      label: '7 days',
      scope: 'all',
      usedPercent,
      windowMinutes: 7 * 24 * 60,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
    });
  }
  return windows.length > 0 ? windows : null;
}

// ── Cline Pass ────────────────────────────────────────────────────────────────

/** Window type → the shared allowance-window id/label/duration. */
const CLINE_WINDOW_CONFIG: Record<string, { id: string; label: string; minutes: number }> = {
  five_hour: { id: 'five-hour', label: '5 hours', minutes: 5 * 60 },
  weekly: { id: 'seven-day', label: '7 days', minutes: 7 * 24 * 60 },
  monthly: { id: 'thirty-day', label: '30 days', minutes: 30 * 24 * 60 },
};

/**
 * Parse the Cline Pass `/users/me/plan/usage-limits` payload. Pure percentage
 * windows (no absolute meters); the monthly window is reported too — this view
 * is display-only quota telemetry, not the account scheduler, so the extra
 * window is information rather than a worst-window risk.
 */
export function parseClinePassUsageLimitsPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const data = isRecord(payload['data']) ? (payload['data'] as Record<string, unknown>) : payload;
  const limits = Array.isArray(data['limits']) ? data['limits'] : [];
  const windows: AllowanceWindow[] = [];
  for (const raw of limits) {
    if (!isRecord(raw)) continue;
    const config = CLINE_WINDOW_CONFIG[typeof raw['type'] === 'string' ? raw['type'] : ''];
    if (!config) continue;
    const usedPercent = finitePercent(raw['percentUsed']);
    if (usedPercent === null) continue;
    const resetsAt = isoInstant(raw['resetsAt']);
    windows.push({
      id: config.id,
      label: config.label,
      scope: 'all',
      usedPercent,
      windowMinutes: config.minutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    });
  }
  return windows.length > 0 ? windows : null;
}
