/**
 * Grok (xAI SuperGrok) OAuth usage collector.
 *
 * Polls the Grok CLI billing proxy (`cli-chat-proxy.grok.com/v1/billing` —
 * NOT `*.x.ai`, and it REJECTS paid API keys: OAuth bearer only) per grok
 * account, mirroring the Claude/Codex/Kimi collectors' cache contract:
 * 5-minute cache, per-account in-flight merging, one 401→refresh→retry.
 *
 * Dual shape (mirrors the audit source's semantics):
 *  - WEEKLY credits (`?format=credits`): `config.creditUsagePercent` +
 *    `config.currentPeriod{start,end,type}` (+ per-product rows and an
 *    on-demand cap, both optional). A missing `creditUsagePercent` on an
 *    ACTIVE weekly period reads as 0 (a fresh period has no usage row).
 *  - UNIFIED monthly (default URL): `config.{billingPeriodStart,
 *    billingPeriodEnd, monthlyLimit{val}, used{val}}` — accounts flagged
 *    `isUnifiedBillingUser` omit the weekly percentage and meter a monthly
 *    included quota instead.
 *
 * Probe policy: always probe weekly first; probe monthly when weekly is
 * missing OR the account is flagged unified. An INFERRED weekly percentage
 * (field absent) on a unified account is only kept when the monthly probe
 * positively confirms there is no monthly quota — otherwise the monthly
 * window wins (an inferred 0% weekly on a unified account is a lie), and a
 * failed monthly probe falls through to a failure snapshot so the store
 * retains the last good one.
 *
 * Every request carries `X-XAI-Token-Auth: xai-grok-cli` — the same product
 * gate the official CLI uses on this host.
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  GrokTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

export const GROK_ALLOWANCE_CACHE_MS = 5 * 60_000;
const GROK_BILLING_BASE = 'https://cli-chat-proxy.grok.com';
const GROK_BILLING_CREDITS_URL = `${GROK_BILLING_BASE}/v1/billing?format=credits`;
const GROK_BILLING_MONTHLY_URL = `${GROK_BILLING_BASE}/v1/billing`;

export interface GrokAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'grok', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'grok', accountId: string): Promise<boolean>;
}

export type GrokAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface GrokAllowanceCollectOptions {
  force?: boolean;
  refreshAheadMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function percent(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed <= 100 ? parsed : undefined;
}

/** `{val: <n>}` on-demand amount shape. */
function onDemandAmount(value: unknown): number | undefined {
  return isRecord(value) ? finiteNumber(value['val']) : undefined;
}

/** The parsed weekly-credits shape. */
interface GrokWeeklyConfig {
  creditUsagePercent: number;
  /** The percentage field was ABSENT (a fresh active period) — inferred 0. */
  inferredPercent: boolean;
  resetsAtMs: number;
  unified: boolean;
}

/** The parsed unified-monthly shape. */
interface GrokMonthlyConfig {
  used: number;
  limit: number;
  periodStartMs: number;
  periodEndMs: number;
}

/** A raw default-URL `config` with NO positive monthly quota (confirmation). */
function confirmsNoMonthlyQuota(raw: Record<string, unknown>): boolean {
  const limit = onDemandAmount(raw['monthlyLimit']);
  if (limit !== undefined) return limit === 0;
  // Some weekly accounts return the credits shape from the default URL too.
  return parseWeeklyConfig(raw)?.inferredPercent === true;
}

function parseWeeklyConfig(raw: Record<string, unknown>): GrokWeeklyConfig | null {
  const period = isRecord(raw['currentPeriod']) ? raw['currentPeriod'] : undefined;
  if (!period) return null;
  const start = typeof period['start'] === 'string' ? Date.parse(period['start']) : Number.NaN;
  const end = typeof period['end'] === 'string' ? Date.parse(period['end']) : Number.NaN;
  const type = typeof period['type'] === 'string' ? period['type'] : '';
  // Keep recently-ended weekly windows so the view renders across rollover
  // while the API mid-refreshes; reject only inverted ranges/non-weekly types.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (!type.toUpperCase().includes('WEEK')) return null;

  const inferred = raw['creditUsagePercent'] === undefined || raw['creditUsagePercent'] === null;
  let creditUsagePercent: number | undefined;
  if (inferred) {
    // An active period with no usage row reads as 0; an ENDED period without
    // explicit data is rejected (retain last good).
    creditUsagePercent = end > Date.now() ? 0 : undefined;
  } else {
    creditUsagePercent = percent(raw['creditUsagePercent']);
  }
  if (creditUsagePercent === undefined) return null;

  return {
    creditUsagePercent,
    inferredPercent: inferred,
    resetsAtMs: end,
    unified: raw['isUnifiedBillingUser'] === true,
  };
}

function parseMonthlyConfig(raw: Record<string, unknown>): GrokMonthlyConfig | null {
  const start = typeof raw['billingPeriodStart'] === 'string'
    ? Date.parse(raw['billingPeriodStart'])
    : Number.NaN;
  const end = typeof raw['billingPeriodEnd'] === 'string'
    ? Date.parse(raw['billingPeriodEnd'])
    : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const limit = onDemandAmount(raw['monthlyLimit']);
  const used = onDemandAmount(raw['used']);
  // Require a positive included quota; zero/missing is not a usable report.
  if (limit === undefined || limit <= 0 || used === undefined) return null;
  return { used, limit, periodStartMs: start, periodEndMs: end };
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MINUTES = 7 * 24 * 60;

function weeklyWindow(config: GrokWeeklyConfig, now: number): AllowanceWindow {
  const resetsAt = new Date(config.resetsAtMs).toISOString();
  return {
    id: 'seven-day',
    label: '7 days',
    scope: 'all',
    usedPercent: config.creditUsagePercent,
    windowMinutes: WEEK_MINUTES,
    resetsAt,
    remainingSeconds: secondsUntil(resetsAt, now),
    state: 'fresh',
  };
}

function monthlyWindow(config: GrokMonthlyConfig, now: number): AllowanceWindow {
  const resetsAt = new Date(config.periodEndMs).toISOString();
  // Real calendar months vary; label from the observed period length.
  const days = Math.max(1, Math.round((config.periodEndMs - config.periodStartMs) / DAY_MS));
  return {
    id: 'thirty-day',
    label: days === 30 || days === 31 ? '30 days' : `${days} days`,
    scope: 'all',
    usedPercent: Math.round(Math.min(100, (config.used / config.limit) * 100) * 10) / 10,
    windowMinutes: Math.round((config.periodEndMs - config.periodStartMs) / MINUTE_MS),
    resetsAt,
    remainingSeconds: secondsUntil(resetsAt, now),
    state: 'fresh',
  };
}

/** The optional on-demand pay-per-use cap row (absolute quota points). */
function onDemandWindow(raw: Record<string, unknown>): AllowanceWindow | null {
  const cap = onDemandAmount(raw['onDemandCap']);
  const used = onDemandAmount(raw['onDemandUsed']);
  if (cap === undefined || cap <= 0 || used === undefined) return null;
  return {
    id: 'on-demand',
    label: 'On-demand',
    scope: 'all',
    usedPercent: Math.round(Math.min(100, (used / cap) * 100) * 10) / 10,
    state: 'fresh',
  };
}

/** One probe's outcome: the payload record + HTTP status (payload null on fail). */
async function probeBilling(
  url: string,
  accessToken: string,
  accountId: string,
  fetchImpl: GrokAllowanceFetch,
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'X-XAI-Token-Auth': 'xai-grok-cli',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }, accountId);
    if (!response.ok) return { status: response.status, payload: null };
    const payload: unknown = await response.json();
    return { status: response.status, payload: isRecord(payload) ? payload : null };
  } catch {
    return { status: 0, payload: null };
  }
}

/**
 * Pure parse of the two probed payloads into ≤3 windows (weekly / monthly /
 * on-demand). Exported for tests.
 */
export function parseGrokBillingPayloads(
  creditsPayload: Record<string, unknown> | null,
  monthlyPayload: Record<string, unknown> | null,
  now: number,
): AllowanceWindow[] | null {
  const creditsConfig = isRecord(creditsPayload?.['config']) ? creditsPayload!['config'] as Record<string, unknown> : null;
  const monthlyConfig = isRecord(monthlyPayload?.['config']) ? monthlyPayload!['config'] as Record<string, unknown> : null;
  let weekly = creditsConfig ? parseWeeklyConfig(creditsConfig) : null;
  const unifiedFlag = creditsConfig?.['isUnifiedBillingUser'] === true;

  let monthly = monthlyConfig ? parseMonthlyConfig(monthlyConfig) : null;

  // An inferred (absent-field) weekly percentage on a unified account is only
  // trusted when the monthly probe positively confirms there is no monthly
  // quota; otherwise the monthly window wins (or the report is unusable, so
  // the caller retains the last-good snapshot).
  if (weekly?.inferredPercent && unifiedFlag) {
    if (monthly) {
      weekly = null;
    } else if (!monthlyConfig || !confirmsNoMonthlyQuota(monthlyConfig)) {
      weekly = null;
    }
  }

  const windows: AllowanceWindow[] = [];
  if (weekly) windows.push(weeklyWindow(weekly, now));
  if (monthly) windows.push(monthlyWindow(monthly, now));
  const onDemandSource = monthly && monthlyConfig ? monthlyConfig : creditsConfig;
  const onDemand = onDemandSource ? onDemandWindow(onDemandSource) : null;
  if (onDemand) windows.push(onDemand);
  return windows.length > 0 ? windows : null;
}

export class GrokAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: GrokAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: GrokAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'grok', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<GrokTokenConfig>[],
    options: GrokAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(accounts.map((account) => this.collect(account, options)));
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<GrokTokenConfig>,
    options: GrokAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    if (account.tokens.authMethod !== 'oauth') {
      const existing = this.store.get('grok', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('grok', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id)
      .catch(() => this.failureSnapshot(account.id, 'grok_usage_request_failed', this.now()))
      .finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, promise);
    return promise;
  }

  private isCacheValid(
    snapshot: AccountAllowanceSnapshot,
    now: number,
    refreshAheadMs: number | undefined,
  ): boolean {
    if (snapshot.windows.every((window) => window.state === 'unsupported')) return true;
    const expiresAt = snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : 0;
    const ahead =
      typeof refreshAheadMs === 'number' && Number.isFinite(refreshAheadMs)
        ? Math.max(0, refreshAheadMs)
        : 0;
    return Number.isFinite(expiresAt) && expiresAt > now + ahead;
  }

  private async fetchAccount(accountId: string): Promise<AccountAllowanceSnapshot> {
    const probe = async (): Promise<{
      unauthorized: boolean;
      windows: AllowanceWindow[] | null;
    }> => {
      const accessToken = await this.credentials.getAccessTokenForAccount('grok', accountId);
      if (!accessToken) return { unauthorized: true, windows: null };
      const credits = await probeBilling(GROK_BILLING_CREDITS_URL, accessToken, accountId, this.fetchImpl);
      if (credits.status === 401 || credits.status === 403) return { unauthorized: true, windows: null };
      const creditsConfig = isRecord(credits.payload?.['config'])
        ? credits.payload!['config'] as Record<string, unknown>
        : null;
      const weekly = creditsConfig ? parseWeeklyConfig(creditsConfig) : null;
      // Probe monthly when weekly is missing/unusable OR the account is
      // flagged unified (live responses sometimes carry both shapes).
      const monthly = (!weekly || creditsConfig?.['isUnifiedBillingUser'] === true)
        ? await probeBilling(GROK_BILLING_MONTHLY_URL, accessToken, accountId, this.fetchImpl)
        : { status: 200, payload: null as Record<string, unknown> | null };
      if (monthly.status === 401 || monthly.status === 403) return { unauthorized: true, windows: null };
      return {
        unauthorized: false,
        windows: parseGrokBillingPayloads(credits.payload, monthly.payload, this.now()),
      };
    };

    let result = await probe();
    if (result.unauthorized) {
      const refreshed = await this.credentials.refreshAccountToken('grok', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'grok_usage_unauthorized', this.now());
      result = await probe();
      if (result.unauthorized) {
        return this.failureSnapshot(accountId, 'grok_usage_unauthorized', this.now());
      }
    }

    const now = this.now();
    if (result.windows && result.windows.length > 0) {
      const snapshot: AccountAllowanceSnapshot = {
        providerId: 'grok',
        accountId,
        source: 'oauth-usage-api',
        observedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + GROK_ALLOWANCE_CACHE_MS).toISOString(),
        windows: result.windows,
      };
      this.store.set(snapshot);
      return snapshot;
    }
    return this.failureSnapshot(accountId, 'grok_usage_invalid_response', now);
  }

  private failureSnapshot(accountId: string, code: string, now: number): AccountAllowanceSnapshot {
    const existing = this.store.get('grok', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + GROK_ALLOWANCE_CACHE_MS).toISOString(),
          windows: existing.windows.map((window) => ({
            ...window,
            state: window.state === 'unsupported'
              ? 'unsupported'
              : window.usedPercent !== null || window.resetsAt
                ? 'stale'
                : 'unavailable',
          })),
          lastErrorCode: code,
        }
      : {
          providerId: 'grok',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + GROK_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unavailable' },
            { id: 'thirty-day', label: '30 days', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(accountId: string, now: number): AccountAllowanceSnapshot {
    return {
      providerId: 'grok',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unsupported' },
        { id: 'thirty-day', label: '30 days', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: 'grok_usage_unsupported_auth',
    };
  }
}
