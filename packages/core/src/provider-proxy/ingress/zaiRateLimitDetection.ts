/**
 * zaiRateLimitDetection — recognize the Z.AI / Zhipu bigmodel (GLM Coding Plan)
 * business error codes in a relayed upstream 429 body and extract the quota
 * window evidence it carries, so the provider-key quota surface stays accurate
 * between monitor polls (the passive complement to the daemon's
 * `GET /api/monitor/usage/quota/limit` probe).
 *
 * WHY the body and not a header: GLM's anthropic/OpenAI-compatible surfaces
 * answer an exhausted window with HTTP 429 plus an anthropic-shaped error
 * object whose `code` is a GLM business code (string digits) and whose
 * `message` embeds the exact `{next_flush_time}` reset stamp — the only place
 * the window identity (5 hours vs 7 days vs a month) and its deadline are
 * stated. The 429 body is relayed verbatim to the client; the learning tap in
 * `upstreamFetch` reads it off a `clone()` and hands the text here.
 *
 * Diagnostic-only codes (plan expired, balance, fair-use, model permission)
 * carry no window; they surface as `diagnostic` so the UI can say WHY the key
 * is rejected instead of guessing from a bare percent.
 *
 * @module provider-proxy/ingress/zaiRateLimitDetection
 */

/** A quota window learned from one 429 body. No `id` — the daemon's quota
 * layer owns the window-id scheme and matches by `windowMinutes`. */
export interface ZaiRateLimitWindow {
  /** Window length, when the body named it (1308's `{number} {unit}`, 1316's
   * 5-hour wall, 1317's 7-day wall). `undefined` for a window whose length the
   * message did not reveal. */
  windowMinutes?: number;
  /** Absolute reset instant (epoch ms), always in the future. */
  resetsAtMs: number;
  /** A 429 means this window is exhausted; the percent is not negotiable. */
  usedPercent: 100;
}

/** What one GLM rate-limit body taught us. At least one of windows/diagnostic. */
export interface ZaiRateLimitObservation {
  windows: ZaiRateLimitWindow[];
  /** Stable machine code for account-level rejections (no window evidence). */
  diagnostic?: ZaiRateLimitDiagnostic;
}

/** Account-level diagnostic codes the UI can localize from. */
export type ZaiRateLimitDiagnostic =
  | 'zai_plan_expired'
  | 'zai_insufficient_balance'
  | 'zai_fair_use_limited'
  | 'zai_model_not_included';

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;
const THIRTY_DAY_MINUTES = 30 * 24 * 60;

/** Codes that name the 5-hour rolling wall (incl. the balance/spend-limit
 * variants — the window identity is the same). */
const FIVE_HOUR_CODES: ReadonlySet<string> = new Set(['1316', '1318', '1320']);
/** Codes that name the 7-day wall. */
const SEVEN_DAY_CODES: ReadonlySet<string> = new Set(['1317', '1319', '1321']);

const DIAGNOSTIC_CODES: ReadonlyMap<string, ZaiRateLimitDiagnostic> = new Map([
  ['1309', 'zai_plan_expired'],
  ['1113', 'zai_insufficient_balance'],
  ['1313', 'zai_fair_use_limited'],
  ['1311', 'zai_model_not_included'],
]);

/** Only scan the leading slice of a (potentially large) error body. */
const BODY_SCAN_LIMIT = 4096;

/**
 * The Z.AI / Zhipu bigmodel hosts whose 429 bodies speak the GLM business-code
 * dialect. Mirrors the daemon quota adapter's zai host set — keep in sync.
 */
const ZAI_HOSTS: ReadonlySet<string> = new Set(['api.z.ai', 'open.bigmodel.cn']);

/** Whether a request URL targets a Z.AI / bigmodel host (quota-learning gate). */
export function isZaiQuotaHost(url: string): boolean {
  try {
    return ZAI_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Epoch ms from a seconds (~1.7e9) or milliseconds (~1.7e12) value. */
function epochMsFromMaybeSeconds(value: number): number {
  return value > 1e11 ? value : value * 1000;
}

/**
 * Extract the `{next_flush_time}` stamp a rate-limit message embeds. GLM
 * renders it as a timezone-offset ISO stamp ("2026-08-07T16:00:05+08:00"); a
 * bare epoch number is accepted as a fallback. Returns `undefined` when no
 * FUTURE instant is found (a past stamp means the window already reset).
 */
function parseNextFlushTime(message: string, now: number): number | undefined {
  const iso = message.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const ms = Date.parse(iso[0].replace(' ', 'T'));
    if (Number.isFinite(ms) && ms > now) return ms;
  }
  const epoch = message.match(/(?<![\d.])(\d{10,13})(?![\d.])/);
  if (epoch) {
    const raw = Number(epoch[1]);
    if (Number.isFinite(raw)) {
      const ms = epochMsFromMaybeSeconds(raw);
      if (ms > now && ms < now + 100 * 24 * 60 * 60_000) return ms;
    }
  }
  return undefined;
}

/** Window length in minutes from a `{number} {unit}` phrase, zh or en. The
 *  English message template renders the placeholders in backticks
 *  ("`5` `hours`") — stripped first so the phrase regex sees them adjacent. */
function windowMinutesFromPhrase(message: string): number | undefined {
  const match = message.replace(/`/g, ' ').match(
    /(\d+)\s*(小时|个小时|天|日|周|星期|月|个月|hours?|hrs?|days?|d\b|weeks?|wks?|w\b|months?|mo\b)/i,
  );
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return undefined;
  switch (match[2].toLowerCase()) {
    case '小时':
    case '个小时':
    case 'hour':
    case 'hours':
    case 'hr':
    case 'hrs':
      return count * 60;
    case '天':
    case '日':
    case 'day':
    case 'days':
    case 'd':
      return count * 24 * 60;
    case '周':
    case '星期':
    case 'week':
    case 'weeks':
    case 'wk':
    case 'wks':
    case 'w':
      return count * 7 * 24 * 60;
    case '月':
    case '个月':
    case 'month':
    case 'months':
    case 'mo':
      return count * 30 * 24 * 60;
    default:
      return undefined;
  }
}

/** 1310 names "weekly/monthly" without a count — classify from the wording. */
function windowMinutesFromWeeklyMonthlyWording(message: string): number | undefined {
  if (/每月|monthly/i.test(message)) return THIRTY_DAY_MINUTES;
  if (/每周|weekly/i.test(message)) return SEVEN_DAY_MINUTES;
  return undefined;
}

/**
 * Parse a GLM rate-limit error body into window evidence + diagnostic.
 * Accepts the anthropic-shaped envelope (`{error:{code,message},type}`) and
 * the bare OpenAI-wire shape (`{code,message}`); `code` is a string of GLM
 * business digits. Returns `null` for anything unrecognized — a transient
 * 1302/1305 concurrency/overload 429 carries no quota evidence and must stay a
 * strict no-op.
 */
export function parseZaiRateLimitError(
  bodyText: string | null | undefined,
  now: number = Date.now(),
): ZaiRateLimitObservation | null {
  if (!bodyText) return null;
  const raw = bodyText.slice(0, BODY_SCAN_LIMIT).trim();
  if (!raw.startsWith('{')) return null;
  let parsed: { error?: { code?: unknown; message?: unknown }; code?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const errorObject =
    parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : parsed;
  const code = errorObject?.code;
  const message = errorObject?.message;
  if (typeof code !== 'string' || !/^\d{3,4}$/.test(code.trim())) return null;
  const messageText = typeof message === 'string' ? message : '';

  const diagnostic = DIAGNOSTIC_CODES.get(code.trim());
  if (diagnostic) return { windows: [], diagnostic };

  let windowMinutes: number | undefined;
  if (FIVE_HOUR_CODES.has(code.trim())) windowMinutes = FIVE_HOUR_MINUTES;
  else if (SEVEN_DAY_CODES.has(code.trim())) windowMinutes = SEVEN_DAY_MINUTES;
  else if (code.trim() === '1308') windowMinutes = windowMinutesFromPhrase(messageText);
  else if (code.trim() === '1310') windowMinutes = windowMinutesFromWeeklyMonthlyWording(messageText);
  else return null; // 1302/1305/unknown — no quota evidence

  const resetsAtMs = parseNextFlushTime(messageText, now);
  if (resetsAtMs === undefined) {
    // A wall without a resolvable deadline cannot pace a window card; treat as
    // no evidence rather than inventing one.
    return null;
  }
  return {
    windows: [{ resetsAtMs, usedPercent: 100, ...(windowMinutes !== undefined ? { windowMinutes } : {}) }],
  };
}
