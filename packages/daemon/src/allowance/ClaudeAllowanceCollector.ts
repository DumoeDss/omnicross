/**
 * Claude OAuth usage collector.
 *
 * Fetches one account's five-hour, seven-day, and seven-day Sonnet windows,
 * coalesces concurrent refreshes by account, and caches every result for five
 * minutes. Tokens and raw upstream payloads never leave this module.
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  ClaudeTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { applyFingerprint } from '@omnicross/core/provider-proxy/identity/fingerprintHeaders';
import {
  getSharedIdentityStore,
  type SubscriptionIdentityStore,
} from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';

export const CLAUDE_ALLOWANCE_CACHE_MS = 5 * 60_000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export interface ClaudeAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'claude', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'claude', accountId: string): Promise<boolean>;
}

export type ClaudeAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface ClaudeAllowanceCollectOptions {
  force?: boolean;
  /**
   * Treat an otherwise valid cache entry as due when it will expire within this
   * window. The resident background scheduler uses this to refresh shortly
   * before expiry without bypassing the normal cache on every tick.
   */
  refreshAheadMs?: number;
}

interface ClaudeUsageWindowPayload {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindowPayload;
  seven_day?: ClaudeUsageWindowPayload;
  seven_day_sonnet?: ClaudeUsageWindowPayload;
}

function finitePercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
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
  id: 'five-hour' | 'seven-day' | 'seven-day-sonnet',
  payload: ClaudeUsageWindowPayload | undefined,
  now: number,
): AllowanceWindow {
  const usedPercent = finitePercent(payload?.utilization);
  const resetsAt = isoInstant(payload?.resets_at);
  const isSonnet = id === 'seven-day-sonnet';
  const isFiveHour = id === 'five-hour';
  return {
    id,
    label: isFiveHour ? '5 hours' : isSonnet ? '7 days · Sonnet' : '7 days',
    scope: isSonnet ? 'model-family' : 'all',
    modelFamily: isSonnet ? 'sonnet' : undefined,
    usedPercent,
    windowMinutes: isFiveHour ? 5 * 60 : 7 * 24 * 60,
    resetsAt,
    remainingSeconds: secondsUntil(resetsAt, now),
    state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
  };
}

function emptyClaudeWindows(state: 'unavailable' | 'unsupported'): AllowanceWindow[] {
  return [
    {
      id: 'five-hour',
      label: '5 hours',
      scope: 'all',
      usedPercent: null,
      windowMinutes: 5 * 60,
      state,
    },
    {
      id: 'seven-day',
      label: '7 days',
      scope: 'all',
      usedPercent: null,
      windowMinutes: 7 * 24 * 60,
      state,
    },
    {
      id: 'seven-day-sonnet',
      label: '7 days · Sonnet',
      scope: 'model-family',
      modelFamily: 'sonnet',
      usedPercent: null,
      windowMinutes: 7 * 24 * 60,
      state,
    },
  ];
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

export class ClaudeAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: ClaudeAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: ClaudeAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'claude', accountId }),
    private readonly identityStore: SubscriptionIdentityStore = getSharedIdentityStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<ClaudeTokenConfig>[],
    options: ClaudeAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(accounts.map((account) => this.collect(account, options)));
    return settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  }

  collect(
    account: SubscriptionAccountEntry<ClaudeTokenConfig>,
    options: ClaudeAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    const unsupported = account.tokens.isSetupToken || account.tokens.authMethod !== 'oauth';
    if (unsupported) {
      const existing = this.store.get('claude', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) return Promise.resolve(existing);
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('claude', account.id, now);
    if (
      !options.force &&
      cached &&
      this.isCacheValid(cached, now, options.refreshAheadMs)
    ) return Promise.resolve(cached);

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id)
      .catch(() => this.failureSnapshot(account.id, 'claude_usage_request_failed', this.now()))
      .finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, promise);
    return promise;
  }

  private isCacheValid(
    snapshot: AccountAllowanceSnapshot,
    now: number,
    refreshAheadMs: number | undefined,
  ): boolean {
    if (snapshot.source !== 'oauth-usage-api') return false;
    if (snapshot.windows.every((window) => window.state === 'unsupported')) return true;
    const expiresAt = snapshot.expiresAt ? Date.parse(snapshot.expiresAt) : 0;
    const ahead = typeof refreshAheadMs === 'number' && Number.isFinite(refreshAheadMs)
      ? Math.max(0, refreshAheadMs)
      : 0;
    return Number.isFinite(expiresAt) && expiresAt > now + ahead;
  }

  private async fetchAccount(accountId: string): Promise<AccountAllowanceSnapshot> {
    let token = await this.credentials.getAccessTokenForAccount('claude', accountId);
    if (!token) return this.failureSnapshot(accountId, 'claude_usage_token_unavailable', this.now());

    let response = await this.request(accountId, token);
    if (response.status === 401) {
      const refreshed = await this.credentials.refreshAccountToken('claude', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'claude_usage_unauthorized', this.now());
      token = await this.credentials.getAccessTokenForAccount('claude', accountId);
      if (!token) return this.failureSnapshot(accountId, 'claude_usage_token_unavailable', this.now());
      response = await this.request(accountId, token);
    }

    if (response.status === 403) {
      const snapshot = this.unsupportedSnapshot(accountId, this.now(), 'claude_usage_unsupported');
      this.store.set(snapshot);
      return snapshot;
    }
    if (!response.ok) {
      return this.failureSnapshot(accountId, 'claude_usage_http_error', this.now());
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(accountId, 'claude_usage_invalid_response', this.now());
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return this.failureSnapshot(accountId, 'claude_usage_invalid_response', this.now());
    }

    const now = this.now();
    const usage = payload as ClaudeUsagePayload;
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'claude',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CLAUDE_ALLOWANCE_CACHE_MS).toISOString(),
      windows: [
        windowFromPayload('five-hour', usage.five_hour, now),
        windowFromPayload('seven-day', usage.seven_day, now),
        windowFromPayload('seven-day-sonnet', usage.seven_day_sonnet, now),
      ],
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private request(accountId: string, token: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    // Replay the account's already-sanitized/frozen Claude Code identity when the
    // operator enabled fingerprinting. Auth/content-type remain protected.
    applyFingerprint(this.identityStore, headers, 'claude', accountId, undefined);
    if (!hasHeader(headers, 'user-agent')) {
      headers['User-Agent'] = 'claude-cli/2.0.53 (external, cli)';
    }
    return this.fetchImpl(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    }, accountId);
  }

  private failureSnapshot(
    accountId: string,
    code: string,
    now: number,
  ): AccountAllowanceSnapshot {
    const existing = this.store.get('claude', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + CLAUDE_ALLOWANCE_CACHE_MS).toISOString(),
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
          providerId: 'claude',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + CLAUDE_ALLOWANCE_CACHE_MS).toISOString(),
          windows: emptyClaudeWindows('unavailable'),
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(
    accountId: string,
    now: number,
    code = 'claude_usage_unsupported_auth',
  ): AccountAllowanceSnapshot {
    return {
      providerId: 'claude',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: emptyClaudeWindows('unsupported'),
      lastErrorCode: code,
    };
  }
}
