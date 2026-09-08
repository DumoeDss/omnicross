/**
 * OpenCodeGo usage collector.
 *
 * Polls `GET {go-base}/v1/usage` per OpenCodeGo account with the account's
 * static bearer key, mirroring the other collectors' cache contract (5-minute
 * cache, per-account in-flight merging). The payload reports three percent
 * windows; only rolling(≈5h) + weekly are surfaced — the MONTHLY window is
 * deliberately dropped: the console's "Use balance" fallback keeps a
 * monthly-exhausted key SERVING, and the scheduling policy pauses on the worst
 * reported window, so reporting monthly would strand usable keys (oh-my-pi
 * reached the same conclusion for its ranking scopes).
 *
 * `status: "rate-limited"` is authoritative over the percent (→ 100%).
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type { SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { getOpenCodeGoUserAgent } from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';
import { normalizeOpenCodeGoBaseUrl } from '@omnicross/subscriptions';

export const OPENCODEGO_ALLOWANCE_CACHE_MS = 5 * 60_000;
const OPENCODEGO_DEFAULT_GO_BASE = 'https://opencode.ai/zen/go';

export interface OpenCodeGoAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'opencodego', accountId: string): Promise<string | null>;
}

export type OpenCodeGoAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

interface OpenCodeGoUsageWindowPayload {
  percent?: unknown;
  status?: unknown;
  resetsAt?: unknown;
}

interface OpenCodeGoUsagePayload {
  usage?: {
    rolling?: OpenCodeGoUsageWindowPayload | null;
    weekly?: OpenCodeGoUsageWindowPayload | null;
  } | null;
}

function finitePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function isoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

function windowFromPayload(
  id: 'five-hour' | 'seven-day',
  label: string,
  minutes: number,
  payload: OpenCodeGoUsageWindowPayload | undefined,
  now: number,
): AllowanceWindow {
  // The window's own status outranks the percent: a rate-limited window may
  // carry a stale percent below 100.
  const statusRateLimited = payload?.status === 'rate-limited';
  const usedPercent = statusRateLimited ? 100 : finitePercent(payload?.percent);
  const resetsAt = isoInstant(payload?.resetsAt);
  return {
    id,
    label,
    scope: 'all',
    usedPercent,
    windowMinutes: minutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    remainingSeconds: secondsUntil(resetsAt, now),
    state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
  };
}

export class OpenCodeGoAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: OpenCodeGoAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: OpenCodeGoAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'opencodego', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<OpenCodeGoTokenConfig>[],
    options: { force?: boolean; refreshAheadMs?: number } = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(accounts.map((account) => this.collect(account, options)));
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<OpenCodeGoTokenConfig>,
    options: { force?: boolean; refreshAheadMs?: number } = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    const cached = this.store.get('opencodego', account.id, now);
    if (
      !options.force &&
      cached &&
      (cached.windows.every((window) => window.state === 'unsupported') ||
        (cached.expiresAt && Date.parse(cached.expiresAt) > now + (options.refreshAheadMs ?? 0)))
    ) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account)
      .catch(() => this.failureSnapshot(account.id, this.now()))
      .finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, promise);
    return promise;
  }

  private async fetchAccount(
    account: SubscriptionAccountEntry<OpenCodeGoTokenConfig>,
  ): Promise<AccountAllowanceSnapshot> {
    const apiKey = await this.credentials.getAccessTokenForAccount('opencodego', account.id);
    if (!apiKey) return this.failureSnapshot(account.id, this.now());

    const base = account.tokens.baseUrl
      ? normalizeOpenCodeGoBaseUrl(account.tokens.baseUrl)
      : OPENCODEGO_DEFAULT_GO_BASE;
    const response = await this.fetchImpl(`${base}/v1/usage`, {
      method: 'GET',
      // opencodego-egress-identity: the background poll identifies itself with
      // the same configured/default UA the relay carries (no session header —
      // a poll has no conversation).
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': getOpenCodeGoUserAgent(),
      },
      signal: AbortSignal.timeout(15_000),
    }, account.id);
    if (response.status === 401 || response.status === 403) {
      // Static keys don't refresh — an auth failure is a credential problem the
      // pool's auto-disable already tracks; surface it as a diagnostic snapshot.
      return this.failureSnapshot(account.id, this.now(), 'opencodego_usage_unauthorized');
    }
    if (!response.ok) return this.failureSnapshot(account.id, this.now());

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(account.id, this.now());
    }
    const usage = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as OpenCodeGoUsagePayload).usage
      : undefined;

    const now = this.now();
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'opencodego',
      accountId: account.id,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + OPENCODEGO_ALLOWANCE_CACHE_MS).toISOString(),
      // Monthly deliberately omitted (module doc).
      windows: [
        windowFromPayload('five-hour', '5 hours', 5 * 60, usage?.rolling ?? undefined, now),
        windowFromPayload('seven-day', '7 days', 7 * 24 * 60, usage?.weekly ?? undefined, now),
      ],
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private failureSnapshot(
    accountId: string,
    now: number,
    code = 'opencodego_usage_request_failed',
  ): AccountAllowanceSnapshot {
    const existing = this.store.get('opencodego', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + OPENCODEGO_ALLOWANCE_CACHE_MS).toISOString(),
          windows: existing.windows.map((window) => ({
            ...window,
            state: window.usedPercent !== null || window.resetsAt ? 'stale' : window.state,
          })),
          lastErrorCode: code,
        }
      : {
          providerId: 'opencodego',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + OPENCODEGO_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'five-hour', label: '5 hours', scope: 'all', usedPercent: null, state: 'unavailable' },
            { id: 'seven-day', label: '7 days', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }
}
