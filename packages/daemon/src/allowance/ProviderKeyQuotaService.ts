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
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import type { DaemonProviderConfig } from '../config';
import type { SecretBox } from '../secrets';

import {
  detectProviderKeyQuotaAdapter,
  parseMiniMaxTokenPlanPayload,
  parseSyntheticQuotasPayload,
  parseUmansUsagePayload,
  parseZaiQuotaPayload,
  providerKeyQuotaAuthHeader,
  providerKeyQuotaUrl,
  type ProviderKeyQuotaAdapter,
} from './ProviderKeyQuota';

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
    ) return cached;

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
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, promise);
    return promise;
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
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('invalid JSON');
    }
    const windows = parseQuotaPayload(adapter, payload, now);
    const snapshot: ProviderKeyQuota = {
      adapter,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PROVIDER_KEY_QUOTA_CACHE_MS).toISOString(),
      windows: windows ?? [],
      ...(windows ? {} : { errorCode: 'quota_unavailable' }),
    };
    this.cache.set(cacheKey, snapshot);
    return snapshot;
  }
}
