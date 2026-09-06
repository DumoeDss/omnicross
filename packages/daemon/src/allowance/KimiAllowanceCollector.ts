/**
 * Kimi Code OAuth usage collector.
 *
 * Polls `GET https://api.kimi.com/coding/v1/usages` per kimi account (Bearer +
 * the CLI fingerprint headers), mirroring the Claude/Codex collectors' cache
 * contract: 5-minute cache, per-account in-flight merging, one 401→refresh→
 * retry. The payload's `usage` aggregate is a weekly row; `limits[]` carries
 * the per-window rows — the 300-minute burst window normalizes to `five-hour`
 * and whole-day spans to `seven-day` (the same canonical ids the Claude view
 * and the UI's window labels use).
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  KimiTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { kimiFingerprintHeaders } from '@omnicross/subscriptions';

export const KIMI_ALLOWANCE_CACHE_MS = 5 * 60_000;
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

export interface KimiAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'kimi', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'kimi', accountId: string): Promise<boolean>;
}

export type KimiAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface KimiAllowanceCollectOptions {
  force?: boolean;
  refreshAheadMs?: number;
}

interface KimiUsageRow {
  used?: number;
  limit?: number;
  remaining?: number;
  resetsAtMs?: number;
  windowDurationMs?: number;
}

interface KimiUsagePayload {
  usage?: Record<string, unknown>;
  limits?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseResetMs(row: Record<string, unknown>, nowMs: number): number | undefined {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    const numeric = finiteNumber(value);
    if (numeric !== undefined && numeric > 1_000_000_000) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
  }
  for (const key of ['reset_in', 'resetIn', 'ttl', 'window']) {
    const seconds = finiteNumber(row[key]);
    if (seconds !== undefined) return nowMs + seconds * 1000;
  }
  return undefined;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Canonical window id from a span: 300min→five-hour, 7d→seven-day, …Nhours. */
function canonicalWindow(durationMs: number): { id: string; label: string; minutes: number } | undefined {
  if (durationMs === 5 * HOUR_MS) return { id: 'five-hour', label: '5 hours', minutes: 300 };
  if (durationMs === 7 * DAY_MS) return { id: 'seven-day', label: '7 days', minutes: 10_080 };
  if (durationMs > 0 && durationMs % DAY_MS === 0) {
    const days = durationMs / DAY_MS;
    return { id: `${days}d`, label: `${days} day${days === 1 ? '' : 's'}`, minutes: Math.round(durationMs / MINUTE_MS) };
  }
  if (durationMs > 0 && durationMs % HOUR_MS === 0) {
    const hours = durationMs / HOUR_MS;
    return { id: `${hours}h`, label: `${hours} hour${hours === 1 ? '' : 's'}`, minutes: Math.round(durationMs / MINUTE_MS) };
  }
  return undefined;
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

function windowFromRow(
  row: KimiUsageRow | undefined,
  fallback: { id: string; label: string; minutes: number },
  now: number,
): AllowanceWindow {
  const usedPercent = row?.limit !== undefined && row.limit > 0 && row.used !== undefined
    ? Math.round(Math.min(100, (row.used / row.limit) * 100) * 10) / 10
    : null;
  const resetsAt = row?.resetsAtMs !== undefined
    ? new Date(row.resetsAtMs).toISOString()
    : undefined;
  return {
    id: fallback.id,
    label: fallback.label,
    scope: 'all',
    usedPercent,
    windowMinutes: fallback.minutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    remainingSeconds: secondsUntil(resetsAt, now),
    state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
  };
}

/**
 * Parse the usages payload into (≤4) windows: the 5h burst + the weekly
 * aggregate, keeping the most-binding row per canonical id.
 */
export function parseKimiUsagePayload(payload: unknown, now: number): AllowanceWindow[] {
  if (!isRecord(payload)) return [];
  const byId = new Map<string, AllowanceWindow>();

  const rowFrom = (data: Record<string, unknown>): KimiUsageRow => {
    const limit = finiteNumber(data['limit']);
    let used = finiteNumber(data['used']);
    const remaining = finiteNumber(data['remaining']);
    if (used === undefined && remaining !== undefined && limit !== undefined) {
      used = limit - remaining;
    }
    let windowDurationMs: number | undefined;
    const windowData = isRecord(data['window']) ? data['window'] : undefined;
    const duration = finiteNumber(windowData?.['duration']);
    const timeUnit = typeof windowData?.['timeUnit'] === 'string' ? windowData['timeUnit'].toUpperCase() : '';
    if (duration !== undefined) {
      if (timeUnit.includes('MINUTE')) windowDurationMs = duration * MINUTE_MS;
      else if (timeUnit.includes('HOUR')) windowDurationMs = duration * HOUR_MS;
      else if (timeUnit.includes('DAY')) windowDurationMs = duration * DAY_MS;
      else if (timeUnit.includes('WEEK')) windowDurationMs = duration * 7 * DAY_MS;
      else if (timeUnit.includes('SECOND')) windowDurationMs = duration * 1000;
    }
    // Kimi puts the reset on the row/detail, not on `window`; prefer the
    // row-level reset when the window carries none.
    const resetsAtMs = parseResetMs(windowData && parseResetMs(windowData, now) !== undefined ? windowData : data, now);
    return { used, limit, remaining, ...(resetsAtMs !== undefined ? { resetsAtMs } : {}), ...(windowDurationMs !== undefined ? { windowDurationMs } : {}) };
  };

  // The `usage` aggregate is a weekly row (no duration in the payload).
  if (isRecord(payload['usage'])) {
    const row = rowFrom(payload['usage']);
    const window = windowFromRow({ ...row, resetsAtMs: row.resetsAtMs }, { id: 'seven-day', label: '7 days', minutes: 10_080 }, now);
    byId.set('seven-day', window);
  }

  if (Array.isArray(payload['limits'])) {
    for (const item of payload['limits']) {
      if (!isRecord(item)) continue;
      const detail = isRecord(item['detail']) ? item['detail'] : item;
      const row = rowFrom(detail);
      const canonical = row.windowDurationMs !== undefined ? canonicalWindow(row.windowDurationMs) : undefined;
      if (!canonical) continue;
      const window = windowFromRow(row, canonical, now);
      const existing = byId.get(canonical.id);
      if (!existing || (window.usedPercent ?? 0) > (existing.usedPercent ?? 0)) {
        byId.set(canonical.id, window);
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
    .slice(0, 4);
}

export class KimiAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: KimiAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: KimiAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'kimi', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<KimiTokenConfig>[],
    options: KimiAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(accounts.map((account) => this.collect(account, options)));
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<KimiTokenConfig>,
    options: KimiAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    if (account.tokens.authMethod !== 'oauth') {
      const existing = this.store.get('kimi', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('kimi', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id, account.tokens)
      .catch(() => this.failureSnapshot(account.id, 'kimi_usage_request_failed', this.now()))
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

  private async fetchAccount(
    accountId: string,
    tokens: KimiTokenConfig,
  ): Promise<AccountAllowanceSnapshot> {
    let accessToken = await this.credentials.getAccessTokenForAccount('kimi', accountId);
    if (!accessToken) return this.failureSnapshot(accountId, 'kimi_usage_token_unavailable', this.now());

    let response = await this.request(accountId, accessToken, tokens);
    if (response.status === 401) {
      const refreshed = await this.credentials.refreshAccountToken('kimi', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'kimi_usage_unauthorized', this.now());
      accessToken = await this.credentials.getAccessTokenForAccount('kimi', accountId);
      if (!accessToken) return this.failureSnapshot(accountId, 'kimi_usage_token_unavailable', this.now());
      response = await this.request(accountId, accessToken, tokens);
    }
    if (response.status === 403) {
      const snapshot = this.unsupportedSnapshot(accountId, this.now(), 'kimi_usage_unsupported');
      this.store.set(snapshot);
      return snapshot;
    }
    if (!response.ok) return this.failureSnapshot(accountId, 'kimi_usage_http_error', this.now());

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(accountId, 'kimi_usage_invalid_response', this.now());
    }

    const now = this.now();
    const windows = parseKimiUsagePayload(payload, now);
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'kimi',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + KIMI_ALLOWANCE_CACHE_MS).toISOString(),
      windows: windows.length > 0
        ? windows
        : [
            { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: null, state: 'unavailable' },
            { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
      ...(windows.length > 0 ? {} : { lastErrorCode: 'kimi_usage_invalid_response' }),
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private request(accountId: string, accessToken: string, tokens: KimiTokenConfig): Promise<Response> {
    return this.fetchImpl(KIMI_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...kimiFingerprintHeaders(tokens.deviceId),
      },
      signal: AbortSignal.timeout(15_000),
    }, accountId);
  }

  private failureSnapshot(accountId: string, code: string, now: number): AccountAllowanceSnapshot {
    const existing = this.store.get('kimi', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + KIMI_ALLOWANCE_CACHE_MS).toISOString(),
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
          providerId: 'kimi',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + KIMI_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: null, state: 'unavailable' },
            { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(
    accountId: string,
    now: number,
    code = 'kimi_usage_unsupported_auth',
  ): AccountAllowanceSnapshot {
    return {
      providerId: 'kimi',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: null, state: 'unsupported' },
        { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: code,
    };
  }
}
