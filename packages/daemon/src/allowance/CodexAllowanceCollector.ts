/**
 * Codex (ChatGPT) OAuth usage collector.
 *
 * Actively polls `GET https://chatgpt.com/backend-api/wham/usage` per codex
 * account (Bearer + `ChatGPT-Account-Id` decoded from the OAuth id_token),
 * mirroring the Claude collector's cache/coalescing contract: 5-minute cache,
 * per-account in-flight merging, one 401→refresh→retry. The passive
 * `x-codex-*` response-header tap (`upstreamFetch`) remains the complement —
 * it keeps windows fresh mid-flight; this collector makes the quota visible
 * with ZERO traffic (previously codex reported not-observed until a real
 * model response, and its refresh button had to spend a probe request).
 *
 * `reset_at` (absolute epoch seconds) is preferred over `reset_after_seconds`
 * so deadlines do not accumulate observation-clock skew. Tokens and raw
 * upstream payloads never leave this module.
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  CodexTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

export const CODEX_ALLOWANCE_CACHE_MS = 5 * 60_000;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** Mirrors the relay's codex CLI identity markers (`codexCliHeaders`). */
const CODEX_CLI_USER_AGENT = 'codex_cli_rs/0.144.5';

export interface CodexAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'codex', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'codex', accountId: string): Promise<boolean>;
}

export type CodexAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface CodexAllowanceCollectOptions {
  force?: boolean;
  /** Treat an otherwise valid cache entry as due when it expires within this window. */
  refreshAheadMs?: number;
}

interface CodexUsageWindowPayload {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_after_seconds?: unknown;
  reset_at?: unknown;
}

interface CodexUsagePayload {
  rate_limit?: {
    primary_window?: CodexUsageWindowPayload | null;
    secondary_window?: CodexUsageWindowPayload | null;
  } | null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finitePercent(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed <= 100 ? parsed : null;
}

function isoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Epoch seconds (~1.7e9) or milliseconds (~1.7e12) → epoch ms. */
function epochMs(value: number): number {
  return value > 1e11 ? value : value * 1000;
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

/**
 * Decode a JWT's payload WITHOUT verifying (the issuer is the trusted party;
 * we only read a claim, never authenticate on it). Returns `undefined` for a
 * malformed/non-JWT token.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function chatgptAccountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  const auth = claims?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') return undefined;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined;
}

/** Resolve the ChatGPT workspace id: stored field → id_token JWT → access_token JWT. */
export function resolveCodexChatGptAccountId(tokens: CodexTokenConfig): string | undefined {
  if (tokens.accountId?.trim()) return tokens.accountId.trim();
  if (tokens.idToken) {
    const fromIdToken = chatgptAccountIdFromClaims(decodeJwtClaims(tokens.idToken));
    if (fromIdToken) return fromIdToken;
  }
  if (tokens.accessToken) {
    return chatgptAccountIdFromClaims(decodeJwtClaims(tokens.accessToken));
  }
  return undefined;
}

function windowFromPayload(
  id: 'primary' | 'secondary',
  payload: CodexUsageWindowPayload | undefined,
  now: number,
): AllowanceWindow {
  const usedPercent = finitePercent(payload?.used_percent);
  const resetAtSeconds = finiteNumber(payload?.reset_at);
  const resetAfterSeconds = finiteNumber(payload?.reset_after_seconds);
  const windowSeconds = finiteNumber(payload?.limit_window_seconds);
  const resetsAt =
    resetAtSeconds !== null && resetAtSeconds > 0
      ? new Date(epochMs(resetAtSeconds)).toISOString()
      : resetAfterSeconds !== null && resetAfterSeconds > 0
        ? new Date(now + resetAfterSeconds * 1000).toISOString()
        : undefined;
  const windowMinutes =
    windowSeconds !== null && windowSeconds > 0 ? Math.round(windowSeconds / 60) : undefined;
  return {
    id,
    label: id === 'primary' ? 'Primary' : 'Secondary',
    scope: 'all',
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    remainingSeconds: secondsUntil(resetsAt, now),
    state: usedPercent !== null || resetsAt ? 'fresh' : 'unavailable',
  };
}

export class CodexAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: CodexAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: CodexAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'codex', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<CodexTokenConfig>[],
    options: CodexAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(accounts.map((account) => this.collect(account, options)));
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<CodexTokenConfig>,
    options: CodexAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    const unsupported = account.tokens.authMethod !== 'oauth';
    if (unsupported) {
      const existing = this.store.get('codex', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('codex', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id, account.tokens)
      .catch(() => this.failureSnapshot(account.id, 'codex_usage_request_failed', this.now()))
      .finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, promise);
    return promise;
  }

  /**
   * A response-header snapshot stays a valid cache hit only while fresh; an
   * active oauth-usage snapshot is honored on the same 5-minute cadence as
   * Claude's (the poll is cheap and quota is the scheduling input).
   */
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
    tokens: CodexTokenConfig,
  ): Promise<AccountAllowanceSnapshot> {
    let accessToken = await this.credentials.getAccessTokenForAccount('codex', accountId);
    if (!accessToken) {
      return this.failureSnapshot(accountId, 'codex_usage_token_unavailable', this.now());
    }

    let response = await this.request(accountId, accessToken, tokens);
    if (response.status === 401) {
      const refreshed = await this.credentials.refreshAccountToken('codex', accountId);
      if (!refreshed) {
        return this.failureSnapshot(accountId, 'codex_usage_unauthorized', this.now());
      }
      accessToken = await this.credentials.getAccessTokenForAccount('codex', accountId);
      if (!accessToken) {
        return this.failureSnapshot(accountId, 'codex_usage_token_unavailable', this.now());
      }
      response = await this.request(accountId, accessToken, tokens);
    }

    if (response.status === 403) {
      const snapshot = this.unsupportedSnapshot(accountId, this.now(), 'codex_usage_unsupported');
      this.store.set(snapshot);
      return snapshot;
    }
    if (!response.ok) {
      return this.failureSnapshot(accountId, 'codex_usage_http_error', this.now());
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(accountId, 'codex_usage_invalid_response', this.now());
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return this.failureSnapshot(accountId, 'codex_usage_invalid_response', this.now());
    }

    const now = this.now();
    const usage = (payload as CodexUsagePayload).rate_limit;
    const previous = this.store.get('codex', accountId, now);
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'codex',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CODEX_ALLOWANCE_CACHE_MS).toISOString(),
      windows: [
        windowFromPayload('primary', usage?.primary_window ?? undefined, now),
        windowFromPayload('secondary', usage?.secondary_window ?? undefined, now),
      ],
      // The wham payload has no ratio field; keep the passively-observed value.
      ...(previous?.primaryOverSecondaryLimitPercent !== undefined
        ? { primaryOverSecondaryLimitPercent: previous.primaryOverSecondaryLimitPercent }
        : {}),
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private request(accountId: string, accessToken: string, tokens: CodexTokenConfig): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': CODEX_CLI_USER_AGENT,
    };
    const chatgptAccountId = resolveCodexChatGptAccountId(tokens);
    if (chatgptAccountId) headers['ChatGPT-Account-Id'] = chatgptAccountId;
    return this.fetchImpl(CODEX_USAGE_URL, {
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
    const existing = this.store.get('codex', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + CODEX_ALLOWANCE_CACHE_MS).toISOString(),
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
          providerId: 'codex',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + CODEX_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'primary', label: 'Primary', scope: 'all', usedPercent: null, state: 'unavailable' },
            { id: 'secondary', label: 'Secondary', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(
    accountId: string,
    now: number,
    code = 'codex_usage_unsupported_auth',
  ): AccountAllowanceSnapshot {
    return {
      providerId: 'codex',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'primary', label: 'Primary', scope: 'all', usedPercent: null, state: 'unsupported' },
        { id: 'secondary', label: 'Secondary', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: code,
    };
  }
}
