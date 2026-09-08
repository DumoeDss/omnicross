/**
 * AntigravityAllowanceCollector — the antigravity subscription's quota via the
 * Code Assist internal quotaSummary RPC (antigravity-subscription-provider
 * design D6).
 *
 * Probes `POST ${daily-cloudcode-pa}/v1internal:retrieveUserQuotaSummary` per
 * antigravity account (Bearer access token + the antigravity/hub UA the
 * inference path also carries), parsing the rolling 5h + weekly DUAL buckets —
 * split by counter family (Google / Anthropic / OpenAI) — into per-model-family
 * allowance windows: `remainingFraction` (0–1) → used percent, `resetTime` →
 * resetsAt, `disabled` → the window's hard-block flag. The shared
 * counter-family ←→ model-family map lives in core (`antigravityQuotaFamily`).
 *
 * FALLBACK: when the summary RPC fails, `v1internal:fetchAvailableModels`'s
 * per-model `quotaInfo` is the legacy source — the collect then updates from
 * it instead. A total failure NEVER clears the existing windows (stale-marking
 * only), mirroring the sibling collectors.
 *
 * Mirrors the sibling collectors' cache contract: 5-minute cache, per-account
 * in-flight merging, one 401/403→refresh→retry. Unlike gemini (per-model
 * fractions, display-only), antigravity IS in the allowance scheduling
 * whitelist — the account-level dual buckets fit the worst-window rule.
 *
 * @module @omnicross/daemon/allowance/AntigravityAllowanceCollector
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  AntigravityTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import { ANTIGRAVITY_CODE_ASSIST_ENDPOINT } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import {
  ANTIGRAVITY_COUNTER_TO_MODEL_FAMILY,
  antigravityCounterFamiliesForBucketId,
  type AntigravityCounterFamily,
} from '@omnicross/core/pipeline/antigravityQuotaFamily';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { getAntigravityUserAgent } from '@omnicross/core/transformer/transformers/antigravityIdentity';

export const ANTIGRAVITY_ALLOWANCE_CACHE_MS = 5 * 60_000;

const RETRIEVE_USER_QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';
const FETCH_AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels';

/** Model ids the dynamic discovery excludes (mirrors the static catalog's denylist). */
export const ANTIGRAVITY_DISCOVERY_DENYLIST: ReadonlySet<string> = new Set([
  'chat_20706',
  'chat_23310',
  'gemini-2.5-pro',
]);

export interface AntigravityAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'antigravity', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'antigravity', accountId: string): Promise<boolean>;
}

export type AntigravityAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface AntigravityAllowanceCollectOptions {
  force?: boolean;
  refreshAheadMs?: number;
}

interface QuotaSummaryBucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  remainingAmount?: number | string;
  disabled?: boolean;
  resetTime?: string;
}

interface QuotaSummaryGroup {
  displayName?: string;
  description?: string;
  buckets?: QuotaSummaryBucket[];
}

interface QuotaSummaryResponse {
  buckets?: QuotaSummaryBucket[];
  groups?: QuotaSummaryGroup[];
}

/** A legacy per-model quotaInfo entry on fetchAvailableModels. */
interface LegacyQuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
  tier?: string;
  windowId?: string;
  windowLabel?: string;
  apiProvider?: string;
  modelProvider?: string;
}

interface LegacyModelInfo {
  quotaInfo?: LegacyQuotaInfo | LegacyQuotaInfo[];
  quotaInfos?: LegacyQuotaInfo[];
  dailyQuotaInfo?: LegacyQuotaInfo | LegacyQuotaInfo[];
  dailyQuotaInfos?: LegacyQuotaInfo[];
  weeklyQuotaInfo?: LegacyQuotaInfo | LegacyQuotaInfo[];
  weeklyQuotaInfos?: LegacyQuotaInfo[];
  apiProvider?: string;
  modelProvider?: string;
}

interface LegacyModelsResponse {
  models?: Record<string, LegacyModelInfo>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

const WINDOW_LABELS: Record<string, string> = {
  'five-hour': '5 Hour',
  weekly: 'Weekly',
  daily: 'Daily',
};

/** Classify a bucket's window descriptor (id/label/window) → a window id. */
function classifyWindowId(...sources: Array<string | undefined>): 'five-hour' | 'weekly' | 'daily' | undefined {
  for (const source of sources) {
    if (!source) continue;
    const text = source.toLowerCase();
    if (text.includes('week') || text.includes('7d') || /7[\s_-]*day/.test(text)) return 'weekly';
    if (text.includes('5h') || text.includes('five hour') || /5[\s_-]*hour/.test(text)) return 'five-hour';
    if (text.includes('day') || text.includes('daily') || text.includes('24h')) return 'daily';
  }
  return undefined;
}

/** Infer the window from the reset distance when the descriptor carries none. */
function inferWindowFromReset(resetsAt: string | undefined, now: number): 'weekly' | 'daily' {
  if (resetsAt !== undefined && Date.parse(resetsAt) - now > 24 * 60 * 60 * 1000) return 'weekly';
  return 'daily';
}

function clampFraction(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** remainingFraction (0–1 remaining) → used percent (0–100, one decimal). */
function usedPercentFromFraction(fraction: number | undefined): number | null {
  const clamped = clampFraction(fraction);
  if (clamped === undefined) return null;
  return Math.round((1 - clamped) * 1000) / 10;
}

function toResetsAt(resetTime: string | undefined): string | undefined {
  if (!resetTime || !Number.isFinite(Date.parse(resetTime))) return undefined;
  return new Date(Date.parse(resetTime)).toISOString();
}

/**
 * Pure parse of a quotaSummary payload into per-model-family windows (grouped
 * buckets preferred; top-level buckets as the fallback shape). Disabled
 * buckets are kept (they drive the family scheduling block). Deduped by
 * `(family, window)` with the WORST (highest usedPercent / disabled) entry
 * winning. Exported for tests.
 */
export function parseAntigravityQuotaSummary(
  payload: unknown,
  now: number,
): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const groups = Array.isArray(payload['groups'])
    ? (payload['groups'] as QuotaSummaryGroup[])
    : [];
  const topBuckets = Array.isArray(payload['buckets'])
    ? (payload['buckets'] as QuotaSummaryBucket[])
    : [];
  const hasGrouped = groups.some((group) => Array.isArray(group.buckets) && group.buckets.length > 0);
  if (!hasGrouped && topBuckets.length === 0) return null;

  const windows = new Map<string, AllowanceWindow>();
  const addBucket = (bucket: QuotaSummaryBucket, groupName?: string): void => {
    const families = antigravityCounterFamiliesForBucketId(bucket.bucketId, groupName);
    if (families.length === 0) return;
    const resetsAt = toResetsAt(bucket.resetTime);
    const windowId =
      classifyWindowId(bucket.window, bucket.displayName, bucket.bucketId) ??
      (resetsAt !== undefined ? inferWindowFromReset(resetsAt, now) : undefined);
    if (windowId === undefined) return;
    // A disabled bucket without a fraction reads as fully used until reset.
    const usedPercent =
      usedPercentFromFraction(bucket.remainingFraction) ??
      (bucket.disabled === true || bucket.resetTime ? (bucket.disabled === true ? 100 : null) : null);
    for (const family of families) {
      const id = `antigravity:${family}:${windowId}`;
      const candidate: AllowanceWindow = {
        id,
        label: `${WINDOW_LABELS[windowId]} (${family})`,
        scope: 'model-family',
        // The window carries the MODEL family (gemini/claude/gpt-oss) — the
        // scheduling gate compares it against the requested model's family.
        modelFamily: ANTIGRAVITY_COUNTER_TO_MODEL_FAMILY[family],
        usedPercent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        remainingSeconds: secondsUntil(resetsAt, now),
        state: 'fresh',
        ...(bucket.disabled === true ? { disabled: true } : {}),
      };
      const existing = windows.get(id);
      // Dedupe: the worst entry wins (disabled > higher usedPercent).
      if (
        !existing ||
        candidate.disabled === true ||
        (existing.disabled !== true &&
          (candidate.usedPercent ?? -1) > (existing.usedPercent ?? -1))
      ) {
        windows.set(id, candidate);
      }
    }
  };

  if (hasGrouped) {
    for (const group of groups) {
      for (const bucket of group.buckets ?? []) addBucket(bucket, group.displayName);
    }
  } else {
    for (const bucket of topBuckets) addBucket(bucket);
  }

  const result = [...windows.values()];
  return result.length > 0 ? result : null;
}

/** Normalize one legacy model's quotaInfo entries into a flat list. */
function legacyQuotaInfos(model: LegacyModelInfo): LegacyQuotaInfo[] {
  const out: LegacyQuotaInfo[] = [];
  const source = {
    ...(model.apiProvider ? { apiProvider: model.apiProvider } : {}),
    ...(model.modelProvider ? { modelProvider: model.modelProvider } : {}),
  };
  const add = (
    value: LegacyQuotaInfo | LegacyQuotaInfo[] | undefined,
    windowDefault?: string,
  ): void => {
    if (!value) return;
    const list = Array.isArray(value) ? value : [value];
    for (const info of list) {
      out.push({ ...source, ...(windowDefault ? { windowId: windowDefault } : {}), ...info });
    }
  };
  add(model.quotaInfo);
  add(model.quotaInfos);
  add(model.dailyQuotaInfo, 'daily');
  add(model.dailyQuotaInfos, 'daily');
  add(model.weeklyQuotaInfo, 'weekly');
  add(model.weeklyQuotaInfos, 'weekly');
  return out;
}

/** Map a legacy counter provider enum → the counter family (undefined = skip). */
function legacyCounterFamily(info: LegacyQuotaInfo): AntigravityCounterFamily | undefined {
  switch (info.modelProvider ?? info.apiProvider) {
    case 'MODEL_PROVIDER_ANTHROPIC':
    case 'API_PROVIDER_ANTHROPIC_VERTEX':
      return 'anthropic';
    case 'MODEL_PROVIDER_GOOGLE':
    case 'API_PROVIDER_GOOGLE_GEMINI':
      return 'google';
    case 'MODEL_PROVIDER_OPENAI':
    case 'API_PROVIDER_OPENAI_VERTEX':
      return 'openai';
    default:
      return undefined;
  }
}

/**
 * Pure parse of the legacy fetchAvailableModels payload into per-family
 * windows (the fallback source when quotaSummary is unavailable). Exported for
 * tests.
 */
export function parseAntigravityLegacyQuota(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const models = payload['models'];
  if (!isRecord(models)) return null;

  const windows = new Map<string, AllowanceWindow>();
  for (const info of Object.values(models as Record<string, LegacyModelInfo>).flatMap(legacyQuotaInfos)) {
    const family = legacyCounterFamily(info);
    if (!family) continue;
    const resetsAt = toResetsAt(info.resetTime);
    const windowId =
      classifyWindowId(info.windowId, info.windowLabel) ??
      (resetsAt !== undefined ? inferWindowFromReset(resetsAt, now) : undefined);
    if (windowId === undefined) continue;
    const id = `antigravity:${family}:${windowId}`;
    const candidate: AllowanceWindow = {
      id,
      label: `${WINDOW_LABELS[windowId]} (${family})`,
      scope: 'model-family',
      modelFamily: ANTIGRAVITY_COUNTER_TO_MODEL_FAMILY[family],
      usedPercent: usedPercentFromFraction(info.remainingFraction),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    };
    const existing = windows.get(id);
    if (!existing || (candidate.usedPercent ?? -1) > (existing.usedPercent ?? -1)) {
      windows.set(id, candidate);
    }
  }

  const result = [...windows.values()];
  return result.length > 0 ? result : null;
}

export class AntigravityAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: AntigravityAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: AntigravityAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'antigravity', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<AntigravityTokenConfig>[],
    options: AntigravityAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(
      accounts.map((account) => this.collect(account, options)),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<AntigravityTokenConfig>,
    options: AntigravityAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    if (account.tokens.authMethod !== 'oauth') {
      const existing = this.store.get('antigravity', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('antigravity', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id)
      .catch(() => this.failureSnapshot(account.id, 'antigravity_usage_request_failed', this.now()))
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
    let accessToken = await this.credentials.getAccessTokenForAccount('antigravity', accountId);
    if (!accessToken) return this.failureSnapshot(accountId, 'antigravity_usage_token_unavailable', this.now());

    let response = await this.request(accountId, accessToken, RETRIEVE_USER_QUOTA_SUMMARY_PATH, {
      project: undefined,
    });
    if (response.status === 401 || response.status === 403) {
      const refreshed = await this.credentials.refreshAccountToken('antigravity', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'antigravity_usage_unauthorized', this.now());
      accessToken = await this.credentials.getAccessTokenForAccount('antigravity', accountId);
      if (!accessToken) return this.failureSnapshot(accountId, 'antigravity_usage_token_unavailable', this.now());
      response = await this.request(accountId, accessToken, RETRIEVE_USER_QUOTA_SUMMARY_PATH, {
        project: undefined,
      });
      if (response.status === 401 || response.status === 403) {
        return this.failureSnapshot(accountId, 'antigravity_usage_unauthorized', this.now());
      }
    }

    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const windows = parseAntigravityQuotaSummary(payload, this.now());
      if (windows) {
        const snapshot = this.snapshot(accountId, windows);
        this.store.set(snapshot);
        return snapshot;
      }
    }

    // Fallback: the legacy per-model quotaInfo on fetchAvailableModels. A
    // failure here NEVER clears the prior windows (stale-marking only).
    const legacy = await this.request(accountId, accessToken, FETCH_AVAILABLE_MODELS_PATH, {});
    if (!legacy.ok) {
      return this.failureSnapshot(accountId, 'antigravity_usage_http_error', this.now());
    }
    const legacyPayload = await legacy.json().catch(() => null);
    const legacyWindows = parseAntigravityLegacyQuota(legacyPayload, this.now());
    if (!legacyWindows) {
      return this.failureSnapshot(accountId, 'antigravity_usage_invalid_response', this.now());
    }
    const snapshot = this.snapshot(accountId, legacyWindows);
    this.store.set(snapshot);
    return snapshot;
  }

  /** One upstream round-trip with the antigravity/hub masquerade UA. */
  private request(
    accountId: string,
    accessToken: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.fetchImpl(`${ANTIGRAVITY_CODE_ASSIST_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': getAntigravityUserAgent(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }, accountId);
  }

  private snapshot(accountId: string, windows: AllowanceWindow[], now: number = this.now()): AccountAllowanceSnapshot {
    return {
      providerId: 'antigravity',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ANTIGRAVITY_ALLOWANCE_CACHE_MS).toISOString(),
      windows,
    };
  }

  private failureSnapshot(accountId: string, code: string, now: number): AccountAllowanceSnapshot {
    const existing = this.store.get('antigravity', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + ANTIGRAVITY_ALLOWANCE_CACHE_MS).toISOString(),
          windows: existing.windows.map((window) => ({
            ...window,
            state: window.state === 'unsupported'
              ? 'unsupported'
              : window.usedPercent !== null || window.resetsAt || window.disabled
                ? 'stale'
                : 'unavailable',
          })),
          lastErrorCode: code,
        }
      : {
          providerId: 'antigravity',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ANTIGRAVITY_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'antigravity-quota', label: 'Antigravity quota', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(accountId: string, now: number): AccountAllowanceSnapshot {
    return {
      providerId: 'antigravity',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'antigravity-quota', label: 'Antigravity quota', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: 'antigravity_usage_unsupported_auth',
    };
  }
}
