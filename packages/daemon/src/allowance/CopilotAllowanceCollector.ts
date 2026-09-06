/**
 * CopilotAllowanceCollector — GitHub Copilot quota via the internal user API.
 *
 * Polls `GET api.github.com/copilot_internal/user` per copilot account
 * (Bearer ghu_ + the mirrored Copilot CLI user-agent), reading
 * `quota_snapshots`:
 *  - `premium_interactions` — the plan's premium-request monthly window
 *    (`{entitlement, remaining, percent_remaining, unlimited}` + the
 *    account-level `quota_reset_date`). Reported as a single `thirty-day`
 *    window; an `unlimited` entitlement reports 0% (never blocks).
 *  - `chat` — the legacy chat-completions quota, reported only when it is
 *    NOT unlimited (newer plans fold it into premium).
 *
 * Mirrors the Claude/Codex/Kimi/Grok collectors' cache contract: 5-minute
 * cache, per-account in-flight merging, one 401→refresh→retry (for copilot a
 * "refresh" marks the account expired — ghu_ tokens cannot be refreshed — so
 * the retry path is exercised only by transient upstream 401 flaps and never
 * loops). The GitHub API base honors the account's `enterpriseUrl` (GHE).
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  CopilotTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { COPILOT_GITHUB_HEADERS, copilotGitHubApiBase } from '@omnicross/subscriptions';

export const COPILOT_ALLOWANCE_CACHE_MS = 5 * 60_000;

export interface CopilotAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'copilot', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'copilot', accountId: string): Promise<boolean>;
}

export type CopilotAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface CopilotAllowanceCollectOptions {
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

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

interface CopilotQuotaDetail {
  entitlement: number;
  remaining: number;
  percentRemaining: number;
  unlimited: boolean;
}

function parseQuotaDetail(value: unknown): CopilotQuotaDetail | null {
  if (!isRecord(value)) return null;
  const entitlement = finiteNumber(value['entitlement']);
  const remaining = finiteNumber(value['remaining']);
  const percentRemaining = finiteNumber(value['percent_remaining']);
  const unlimited = booleanValue(value['unlimited']);
  if (
    entitlement === undefined ||
    remaining === undefined ||
    percentRemaining === undefined ||
    unlimited === undefined
  ) {
    return null;
  }
  return { entitlement, remaining, percentRemaining, unlimited };
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

/**
 * Pure parse of the `copilot_internal/user` payload into ≤2 windows
 * (premium monthly + legacy chat when metered). Exported for tests.
 */
export function parseCopilotUserPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const snapshots = isRecord(payload['quota_snapshots']) ? payload['quota_snapshots'] : undefined;
  if (!snapshots) return null;
  const resetRaw = payload['quota_reset_date'];
  const resetsAt =
    typeof resetRaw === 'string' && resetRaw.trim() && Number.isFinite(Date.parse(resetRaw))
      ? new Date(Date.parse(resetRaw)).toISOString()
      : undefined;

  const windows: AllowanceWindow[] = [];
  const premium = parseQuotaDetail(snapshots['premium_interactions']);
  if (premium) {
    // Absolute meters beat the rounded percent; unlimited reports 0 (never blocks).
    const usedPercent = premium.unlimited
      ? 0
      : premium.entitlement > 0
        ? Math.round(Math.min(100, ((premium.entitlement - premium.remaining) / premium.entitlement) * 100) * 10) / 10
        : finiteNumber(premium.percentRemaining) !== undefined
          ? Math.round(Math.min(100, Math.max(0, 100 - premium.percentRemaining)) * 10) / 10
          : null;
    if (usedPercent !== null) {
      windows.push({
        id: 'thirty-day',
        label: 'Monthly',
        scope: 'all',
        usedPercent,
        windowMinutes: 30 * 24 * 60,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        remainingSeconds: secondsUntil(resetsAt, now),
        state: 'fresh',
      });
    }
  }
  const chat = parseQuotaDetail(snapshots['chat']);
  if (chat && !chat.unlimited && chat.entitlement > 0) {
    const usedPercent =
      Math.round(Math.min(100, ((chat.entitlement - chat.remaining) / chat.entitlement) * 100) * 10) / 10;
    windows.push({
      id: 'chat-monthly',
      label: 'Chat (monthly)',
      scope: 'all',
      usedPercent,
      windowMinutes: 30 * 24 * 60,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    });
  }
  return windows.length > 0 ? windows : null;
}

/** The GitHub REST base for an account (GHE domains route to api.<domain>). */
function githubApiBase(tokens: Pick<CopilotTokenConfig, 'enterpriseUrl'>): string {
  return copilotGitHubApiBase(tokens.enterpriseUrl);
}

export class CopilotAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: CopilotAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: CopilotAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'copilot', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<CopilotTokenConfig>[],
    options: CopilotAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(
      accounts.map((account) => this.collect(account, options)),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<CopilotTokenConfig>,
    options: CopilotAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    if (account.tokens.authMethod !== 'oauth') {
      const existing = this.store.get('copilot', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('copilot', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id, account.tokens)
      .catch(() => this.failureSnapshot(account.id, 'copilot_usage_request_failed', this.now()))
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
    tokens: CopilotTokenConfig,
  ): Promise<AccountAllowanceSnapshot> {
    let accessToken = await this.credentials.getAccessTokenForAccount('copilot', accountId);
    if (!accessToken) return this.failureSnapshot(accountId, 'copilot_usage_token_unavailable', this.now());

    let response = await this.request(accountId, accessToken, tokens);
    if (response.status === 401 || response.status === 403) {
      // A revoked ghu_ token: the "refresh" marks the account expired (its
      // honest outcome) and this probe degrades to unauthorized.
      const refreshed = await this.credentials.refreshAccountToken('copilot', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'copilot_usage_unauthorized', this.now());
      accessToken = await this.credentials.getAccessTokenForAccount('copilot', accountId);
      if (!accessToken) return this.failureSnapshot(accountId, 'copilot_usage_token_unavailable', this.now());
      response = await this.request(accountId, accessToken, tokens);
      if (response.status === 401 || response.status === 403) {
        return this.failureSnapshot(accountId, 'copilot_usage_unauthorized', this.now());
      }
    }
    if (!response.ok) return this.failureSnapshot(accountId, 'copilot_usage_http_error', this.now());

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(accountId, 'copilot_usage_invalid_response', this.now());
    }

    const now = this.now();
    const windows = parseCopilotUserPayload(payload, now);
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'copilot',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + COPILOT_ALLOWANCE_CACHE_MS).toISOString(),
      windows: windows ?? [
        { id: 'thirty-day', label: 'Monthly', scope: 'all', usedPercent: null, state: 'unavailable' },
      ],
      ...(windows ? {} : { lastErrorCode: 'copilot_usage_invalid_response' }),
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private request(
    accountId: string,
    accessToken: string,
    tokens: CopilotTokenConfig,
  ): Promise<Response> {
    return this.fetchImpl(`${githubApiBase(tokens)}/copilot_internal/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...COPILOT_GITHUB_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    }, accountId);
  }

  private failureSnapshot(accountId: string, code: string, now: number): AccountAllowanceSnapshot {
    const existing = this.store.get('copilot', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + COPILOT_ALLOWANCE_CACHE_MS).toISOString(),
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
          providerId: 'copilot',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + COPILOT_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'thirty-day', label: 'Monthly', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(accountId: string, now: number): AccountAllowanceSnapshot {
    return {
      providerId: 'copilot',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'thirty-day', label: 'Monthly', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: 'copilot_usage_unsupported_auth',
    };
  }
}
