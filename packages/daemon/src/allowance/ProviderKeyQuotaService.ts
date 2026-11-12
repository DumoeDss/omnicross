/**
 * ProviderKeyQuotaService — read-through quota cache for BYO provider-row keys.
 *
 * The UI polls `GET /admin/api/providers/:id/keys` every few seconds for pool
 * health; this service backs the optional `quota` field on that DTO. A read is
 * cache-first (5-minute TTL) with per-key in-flight coalescing, so the UI's poll
 * cadence never translates into upstream request cadence. `force` (the refresh
 * button) bypasses the cache. Failures degrade to a stale marker — quota
 * telemetry must never break the keys view.
 *
 * The key plaintext is resolved from the live row (same synthesis as the pool
 * loader: explicit `apiKeys[]` else the single-key fallback) and decrypted via
 * the injected box; it is used ONLY for the upstream Authorization header and
 * never appears in any returned DTO.
 */

import type { AllowanceWindow } from '@omnicross/contracts/account-allowance-types';
import { mergeExtraHeaders } from '@omnicross/core';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import type { DaemonProviderConfig } from '../config';
import type { SecretBox } from '../secrets';

import {
  detectProviderKeyQuotaAdapter,
  mergeLearnedZaiWindows,
 parseClinePassUsageLimitsPayload,
  parseCommandCodeCreditsPayload,
  parseCommandCodeWhoamiOrgId,
  parseMiniMaxTokenPlanPayload,
  parseSyntheticQuotasPayload,
  parseUmansUsagePayload,
  parseZaiPlanLevel,
  parseZaiQuotaPayload,
  providerKeyQuotaAuthHeader,
  providerKeyQuotaUrl,
  type ProviderKeyQuotaAdapter,
} from './ProviderKeyQuota';
import {
  getSharedProviderKeyQuotaLearningStore,
  type LearnedQuotaEntry,
} from '@omnicross/core/pipeline/ProviderKeyQuotaLearningStore';

function parseQuotaPayload(
  adapter: ProviderKeyQuotaAdapter,
  payload: unknown,
  now: number,
) {
  switch (adapter) {
    case 'zai':
      return parseZaiQuotaPayload(payload, now);
    case 'minimax-token-plan':
      return parseMiniMaxTokenPlanPayload(payload, now);
    case 'umans':
      return parseUmansUsagePayload(payload, now);
    case 'synthetic':
      return parseSyntheticQuotasPayload(payload, now);
   case 'cline-pass':
     return parseClinePassUsageLimitsPayload(payload, now);
    case 'commandcode':
      return parseCommandCodeCreditsPayload(payload, now);
  }
}

export const PROVIDER_KEY_QUOTA_CACHE_MS = 5 * 60_000;

/** Secret-free quota view for one pool key. */
export interface ProviderKeyQuota {
  adapter: ProviderKeyQuotaAdapter;
  observedAt: string;
  expiresAt: string;
  windows: AllowanceWindow[];
  /** Stable display-safe diagnostic code on a failed probe. */
  errorCode?: string;
  /** zai monitor payload's plan tier (`data.level`), when it names one. */
  planLevel?: string;
  /**
   * Upstream-rejection diagnostic learned from a real 429 on the serving path
   * (plan expired / balance / fair-use / model permission). More specific than
   * a probe `errorCode` — the UI should prefer it when present.
   */
  learnedDiagnostic?: string;
}

export type ProviderKeyQuotaFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Resolve a row's effective base URL (selected apiMode → codingPlan → plain). */
function resolvedBaseUrl(row: DaemonProviderConfig): string {
  const modes = row.apiModes ?? [];
  const selected = row.selectedApiModeId
    ? modes.find((mode) => mode.id === row.selectedApiModeId)
    : undefined;
  const fallback = modes[0];
  const modeBase = selected?.baseUrl ?? fallback?.baseUrl;
  return modeBase ?? row.codingPlan?.baseUrl ?? row.baseUrl;
}

/** The row's pool keys in loader order (explicit pool else single-key fallback). */
function rowKeyEntries(row: DaemonProviderConfig): Array<{ id: string; apiKey: string }> {
  const pool = (row.apiKeys ?? []).filter((entry) => entry.apiKey.length > 0);
  if (pool.length > 0) return pool.map((entry) => ({ id: entry.id, apiKey: entry.apiKey }));
  if (row.apiKey.length > 0) {
    return [{ id: `${row.id}:default`, apiKey: row.apiKey }];
  }
  return [];
}

export class ProviderKeyQuotaService {
  private readonly cache = new Map<string, ProviderKeyQuota>();
  private readonly inFlight = new Map<string, Promise<ProviderKeyQuota | null>>();

  constructor(
    /** At-rest decryption for the key value (idempotent on plaintext). */
    private readonly box: Pick<SecretBox, 'decryptMaybe'>,
    private readonly fetchImpl: ProviderKeyQuotaFetch = (url, init) =>
      fetchUpstream(url, init, { redactBodies: true }),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Quota for one key of a provider row, or `null` when the row has no quota
   * adapter / no such key. Cache-first; concurrent reads share one flight.
   */
  async quotaFor(
    row: DaemonProviderConfig,
    keyId: string,
    options: { force?: boolean } = {},
  ): Promise<ProviderKeyQuota | null> {
    const adapter = detectProviderKeyQuotaAdapter(resolvedBaseUrl(row));
    if (!adapter) return null;
    const entry = rowKeyEntries(row).find((candidate) => candidate.id === keyId);
    if (!entry) return null;

    const cacheKey = `${row.id}\0${keyId}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (
      !options.force &&
      cached &&
      Date.parse(cached.expiresAt) > now
    ) return this.decorateWithLearned(adapter, row.id, keyId, cached);

    const running = this.inFlight.get(cacheKey);
    if (running) return running;

    const promise = this.fetchQuota(adapter, row, entry.apiKey, cacheKey)
      .catch((error): ProviderKeyQuota | null => {
        // Never propagate — quota telemetry must not break the keys view.
        void error;
        const previous = this.cache.get(cacheKey);
        if (previous) {
          const degraded: ProviderKeyQuota = {
            ...previous,
            expiresAt: new Date(now + PROVIDER_KEY_QUOTA_CACHE_MS).toISOString(),
            windows: previous.windows.map((window) => ({
              ...window,
              state: window.usedPercent !== null || window.resetsAt ? 'stale' : window.state,
            })),
            errorCode: 'quota_request_failed',
          };
          this.cache.set(cacheKey, degraded);
          return degraded;
        }
        return null;
      })
      .then((result) => this.decorateWithLearned(adapter, row.id, keyId, result))
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Overlay passively-learned zai evidence (429 walls observed on the serving
   * path, core's `ProviderKeyQuotaLearningStore`) onto a polled/cached
   * snapshot. Pure overlay — the cache keeps its own copy; a learned window's
   * lifetime is its reset instant, so freshness never depends on the poll.
   */
  private decorateWithLearned(
    adapter: ProviderKeyQuotaAdapter,
    rowId: string,
    keyId: string,
    snapshot: ProviderKeyQuota | null,
  ): ProviderKeyQuota | null {
    if (!snapshot || adapter !== 'zai') return snapshot;
    const now = this.now();
    let learned: LearnedQuotaEntry | null = null;
    try {
      learned = getSharedProviderKeyQuotaLearningStore().lookup(rowId, keyId, now);
    } catch {
      /* learning telemetry must never break the keys view */
    }
    if (!learned || (learned.windows.length === 0 && learned.diagnostic === undefined)) return snapshot;
    return {
      ...snapshot,
      windows: learned.windows.length > 0
        ? mergeLearnedZaiWindows(snapshot.windows, learned.windows, now)
        : snapshot.windows,
      ...(learned.diagnostic !== undefined ? { learnedDiagnostic: learned.diagnostic } : {}),
    };
  }

  /** Drop cached rows for a provider (key added/removed/rotated). */
  invalidateProvider(providerRowId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${providerRowId}\0`)) this.cache.delete(key);
    }
  }

  private async fetchQuota(
    adapter: ProviderKeyQuotaAdapter,
    row: DaemonProviderConfig,
    rawKey: string,
    cacheKey: string,
  ): Promise<ProviderKeyQuota | null> {
    const baseUrl = resolvedBaseUrl(row);
    const url = providerKeyQuotaUrl(adapter, baseUrl);
    const key = this.box.decryptMaybe(rawKey);
    const now = this.now();
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: providerKeyQuotaAuthHeader(adapter, key),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // The row's static identity headers ride along — the Cline usage
        // endpoint sits behind the SAME client-identity 403 gate as inference.
        ...mergeExtraHeaders({}, row.extraHeaders),
      },
      signal: AbortSignal.timeout(15_000),
    });
    // Command Code's FIRST step (whoami) is an optional org-scope resolver: a
    // personal (non-org) key can fail it (403/404) while the billing meters
    // still answer, so only the CREDITS response may declare unauthorized.
    const firstStepOptional = adapter === 'commandcode';
    if (!firstStepOptional && (response.status === 401 || response.status === 403)) {
      // A wrong-scheme key (e.g. a PAYG key on a plan endpoint) is a permanent
      // mismatch — remember it so the poll does not hammer the endpoint.
      const snapshot: ProviderKeyQuota = {
        adapter,
        observedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PROVIDER_KEY_QUOTA_CACHE_MS).toISOString(),
        windows: [],
        errorCode: 'quota_unauthorized',
      };
      this.cache.set(cacheKey, snapshot);
      return snapshot;
    }
    if (!response.ok && !firstStepOptional) throw new Error(`HTTP ${response.status}`);

   let payload: unknown;
   if (response.ok) {
     try {
       payload = await response.json();
     } catch {
       throw new Error('invalid JSON');
     }
   }
    // Command Code is two-step: whoami resolves the org scope, then the
    // billing/credits payload carries the actual window meters.
    if (adapter === 'commandcode') {
      const orgId = parseCommandCodeWhoamiOrgId(payload);
      const creditsUrl = `${new URL(url).origin}/alpha/billing/credits${
        orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
      }`;
      const creditsResponse = await this.fetchImpl(creditsUrl, {
        method: 'GET',
        headers: {
          Authorization: providerKeyQuotaAuthHeader(adapter, key),
          Accept: 'application/json',
          ...mergeExtraHeaders({}, row.extraHeaders),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (creditsResponse.status === 401 || creditsResponse.status === 403) {
        const unauthorized: ProviderKeyQuota = {
          adapter,
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + PROVIDER_KEY_QUOTA_CACHE_MS).toISOString(),
          windows: [],
          errorCode: 'quota_unauthorized',
        };
        this.cache.set(cacheKey, unauthorized);
        return unauthorized;
      }
      if (!creditsResponse.ok) throw new Error(`HTTP ${creditsResponse.status}`);
      try {
        payload = await creditsResponse.json();
      } catch {
        throw new Error('invalid JSON');
      }
    }
   const windows = parseQuotaPayload(adapter, payload, now);
    const planLevel = adapter === 'zai' ? parseZaiPlanLevel(payload) : undefined;
    const snapshot: ProviderKeyQuota = {
      adapter,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROVIDER_KEY_QUOTA_CACHE_MS).toISOString(),
      windows: windows ?? [],
      ...(windows ? {} : { errorCode: 'quota_unavailable' }),
      ...(planLevel !== undefined ? { planLevel } : {}),
    };
    this.cache.set(cacheKey, snapshot);
    return snapshot;
  }
}
