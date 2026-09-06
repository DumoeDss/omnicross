/**
 * GeminiAllowanceCollector — gemini subscription quota via the Cloud Code
 * Assist internal user-quota RPC.
 *
 * Probes `POST ${cloudcode-pa}/v1internal:retrieveUserQuota` per gemini
 * account (Bearer access token + the GeminiCLI masquerade pair the inference
 * path also carries), parsing `buckets[]` into one per-model window:
 * `remainingFraction` (0–1) → used percent, `resetTime` → resetsAt. The
 * Code Assist project id comes from the SHARED `GeminiCodeAssistProjectResolver`
 * (the same instance the dispatch seam uses, so the handshake runs at most
 * once per token across inference + quota); a handshake hard failure degrades
 * to a project-less probe (the valid free-tier envelope), mirroring the
 * reference implementation's tolerant behavior.
 *
 * Mirrors the sibling collectors' cache contract: 5-minute cache, per-account
 * in-flight merging, one 401/403→refresh→retry. Display-only — the scheduling
 * whitelist deliberately excludes gemini (per-model fraction buckets do not
 * fit the worst-window pause/demote rule).
 *
 * @module @omnicross/daemon/allowance/GeminiAllowanceCollector
 */

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type {
  GeminiTokenConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import { getGeminiCodeAssistProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import {
  AccountAllowanceStore,
  getSharedAccountAllowanceStore,
} from '@omnicross/core/pipeline/AccountAllowanceStore';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import {
  getGeminiCliIdentityHeaders,
  resolveCodeAssistEndpoint,
} from '@omnicross/core/transformer/transformers';

export const GEMINI_ALLOWANCE_CACHE_MS = 5 * 60_000;

export interface GeminiAllowanceCredentialReader {
  getAccessTokenForAccount(providerId: 'gemini', accountId: string): Promise<string | null>;
  refreshAccountToken(providerId: 'gemini', accountId: string): Promise<boolean>;
}

export type GeminiAllowanceFetch = (
  url: string,
  init: RequestInit,
  accountId: string,
) => Promise<Response>;

export interface GeminiAllowanceCollectOptions {
  force?: boolean;
  refreshAheadMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function secondsUntil(instant: string | undefined, now: number): number | undefined {
  if (!instant) return undefined;
  return Math.max(0, Math.floor((Date.parse(instant) - now) / 1000));
}

/**
 * Pure parse of the `retrieveUserQuota` payload into per-model windows
 * (buckets without a modelId become the account-wide window). Exported for
 * tests.
 */
export function parseGeminiQuotaPayload(payload: unknown, now: number): AllowanceWindow[] | null {
  if (!isRecord(payload)) return null;
  const buckets = Array.isArray(payload['buckets']) ? payload['buckets'] : [];
  const windows: AllowanceWindow[] = [];
  const seen = new Set<string>();
  for (const raw of buckets) {
    if (!isRecord(raw)) continue;
    const modelId =
      typeof raw['modelId'] === 'string' && raw['modelId'].trim() ? raw['modelId'].trim() : undefined;
    const id = `gemini:${modelId ?? 'all'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const fractionRaw = typeof raw['remainingFraction'] === 'number' ? raw['remainingFraction'] : Number(raw['remainingFraction']);
    const usedPercent = Number.isFinite(fractionRaw)
      ? Math.round(Math.min(100, Math.max(0, (1 - Math.min(1, Math.max(0, fractionRaw))) * 100)) * 10) / 10
      : null;
    const resetRaw = typeof raw['resetTime'] === 'string' && raw['resetTime'].trim() ? raw['resetTime'] : undefined;
    const resetsAt =
      resetRaw !== undefined && Number.isFinite(Date.parse(resetRaw))
        ? new Date(Date.parse(resetRaw)).toISOString()
        : undefined;
    windows.push({
      id,
      label: modelId ? `Gemini ${modelId}` : 'Gemini quota',
      scope: modelId ? 'model-family' : 'all',
      ...(modelId ? { modelFamily: modelId } : {}),
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      remainingSeconds: secondsUntil(resetsAt, now),
      state: 'fresh',
    });
  }
  return windows.length > 0 ? windows : null;
}

export class GeminiAllowanceCollector {
  private readonly inFlight = new Map<string, Promise<AccountAllowanceSnapshot>>();

  constructor(
    private readonly credentials: GeminiAllowanceCredentialReader,
    private readonly store: AccountAllowanceStore = getSharedAccountAllowanceStore(),
    private readonly fetchImpl: GeminiAllowanceFetch = (url, init, accountId) =>
      fetchUpstream(url, init, { providerId: 'gemini', accountId, redactBodies: true }),
    private readonly now: () => number = Date.now,
    private readonly projectResolver: { resolveProject(accessToken: string): Promise<string | undefined> } =
      getGeminiCodeAssistProjectResolver(),
  ) {}

  async collectMany(
    accounts: readonly SubscriptionAccountEntry<GeminiTokenConfig>[],
    options: GeminiAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot[]> {
    const settled = await Promise.allSettled(
      accounts.map((account) => this.collect(account, options)),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  collect(
    account: SubscriptionAccountEntry<GeminiTokenConfig>,
    options: GeminiAllowanceCollectOptions = {},
  ): Promise<AccountAllowanceSnapshot> {
    const now = this.now();
    if (account.tokens.authMethod !== 'oauth') {
      const existing = this.store.get('gemini', account.id, now);
      if (existing?.windows.every((window) => window.state === 'unsupported')) {
        return Promise.resolve(existing);
      }
      const snapshot = this.unsupportedSnapshot(account.id, now);
      this.store.set(snapshot);
      return Promise.resolve(snapshot);
    }

    const cached = this.store.get('gemini', account.id, now);
    if (!options.force && cached && this.isCacheValid(cached, now, options.refreshAheadMs)) {
      return Promise.resolve(cached);
    }

    const running = this.inFlight.get(account.id);
    if (running) return running;

    const promise = this.fetchAccount(account.id)
      .catch(() => this.failureSnapshot(account.id, 'gemini_usage_request_failed', this.now()))
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
    let accessToken = await this.credentials.getAccessTokenForAccount('gemini', accountId);
    if (!accessToken) return this.failureSnapshot(accountId, 'gemini_usage_token_unavailable', this.now());

    // Shared resolver (same instance the dispatch seam uses) — a handshake
    // hard failure degrades to a project-less probe, never fails the collect.
    let project: string | undefined;
    try {
      project = await this.projectResolver.resolveProject(accessToken);
    } catch {
      project = undefined;
    }

    let response = await this.request(accountId, accessToken, project);
    if (response.status === 401 || response.status === 403) {
      const refreshed = await this.credentials.refreshAccountToken('gemini', accountId);
      if (!refreshed) return this.failureSnapshot(accountId, 'gemini_usage_unauthorized', this.now());
      accessToken = await this.credentials.getAccessTokenForAccount('gemini', accountId);
      if (!accessToken) return this.failureSnapshot(accountId, 'gemini_usage_token_unavailable', this.now());
      response = await this.request(accountId, accessToken, project);
      if (response.status === 401 || response.status === 403) {
        return this.failureSnapshot(accountId, 'gemini_usage_unauthorized', this.now());
      }
    }
    if (!response.ok) return this.failureSnapshot(accountId, 'gemini_usage_http_error', this.now());

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return this.failureSnapshot(accountId, 'gemini_usage_invalid_response', this.now());
    }

    const now = this.now();
    const windows = parseGeminiQuotaPayload(payload, now);
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'gemini',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + GEMINI_ALLOWANCE_CACHE_MS).toISOString(),
      windows: windows ?? [
        { id: 'gemini-quota', label: 'Gemini quota', scope: 'all', usedPercent: null, state: 'unavailable' },
      ],
      ...(windows ? {} : { lastErrorCode: 'gemini_usage_invalid_response' }),
    };
    this.store.set(snapshot);
    return snapshot;
  }

  private request(accountId: string, accessToken: string, project?: string): Promise<Response> {
    return this.fetchImpl(`${resolveCodeAssistEndpoint()}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...getGeminiCliIdentityHeaders(),
      },
      body: JSON.stringify(project ? { project } : {}),
      signal: AbortSignal.timeout(15_000),
    }, accountId);
  }

  private failureSnapshot(accountId: string, code: string, now: number): AccountAllowanceSnapshot {
    const existing = this.store.get('gemini', accountId, now);
    const snapshot: AccountAllowanceSnapshot = existing
      ? {
          ...existing,
          expiresAt: new Date(now + GEMINI_ALLOWANCE_CACHE_MS).toISOString(),
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
          providerId: 'gemini',
          accountId,
          source: 'oauth-usage-api',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + GEMINI_ALLOWANCE_CACHE_MS).toISOString(),
          windows: [
            { id: 'gemini-quota', label: 'Gemini quota', scope: 'all', usedPercent: null, state: 'unavailable' },
          ],
          lastErrorCode: code,
        };
    this.store.set(snapshot);
    return snapshot;
  }

  private unsupportedSnapshot(accountId: string, now: number): AccountAllowanceSnapshot {
    return {
      providerId: 'gemini',
      accountId,
      source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(),
      windows: [
        { id: 'gemini-quota', label: 'Gemini quota', scope: 'all', usedPercent: null, state: 'unsupported' },
      ],
      lastErrorCode: 'gemini_usage_unsupported_auth',
    };
  }
}
