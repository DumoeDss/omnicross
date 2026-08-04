/**
 * PricingEngine — manages model pricing and computes per-event cost.
 *
 * Persistence goes through the injected `PricingStore` port. Sources of
 * pricing rows:
 *  - 'builtin'  — bundled fallback prices, seeded by the host
 *  - 'litellm'  — primary catalog from LiteLLM's public JSON
 *  - 'openrouter' — supplemental OpenRouter route pricing
 *  - 'user'     — hand-edited; protected from auto-overwrite
 *
 * @module usage/pricing-engine
 */
import type {
  PricingConflict,
  PricingConflictDecision,
  PricingEntry,
  PricingEntryInput,
  PricingFetchResult,
  PricingResolution,
  PricingSourceRefreshResult,
} from '@omnicross/contracts/pricing-types';
import {
  DEFAULT_LITELLM_PRICING_URL,
  DEFAULT_OPENROUTER_PRICING_URL,
} from '@omnicross/contracts/pricing-types';
import type { UsageTokens } from '@omnicross/contracts/usage-types';

import type { Logger } from '../ports/logger';
import type { PricingStore } from '../ports/pricing-store';

/** Output of `calculateCost`. */
export interface CostCalculation {
  costUsd: number;
  /**
   * Difference between hypothetical-no-cache cost (charging cacheReadTokens at
   * the full input price) and the actual cost (charging at the cache_read price).
   * Always ≥ 0.
   */
  costSavedByCacheUsd: number;
}

/** Optional knobs (mostly for tests). */
export interface PricingEngineOptions {
  /** Override the pricing-source JSON URL — useful for testing. */
  sourceUrl?: string;
  /** Override the supplemental OpenRouter catalog URL. */
  openRouterSourceUrl?: string;
  /** Override `fetch` — useful for testing. */
  fetchImpl?: typeof fetch;
  /** Bound each remote source independently; both sources are fetched in parallel. */
  fetchTimeoutMs?: number;
}

export class PricingEngine {
  private cache: Map<string, PricingEntry> = new Map();
  /**
   * Secondary index keyed by modelId alone. Used as a fallback when no exact
   * (providerId, modelId) match exists — usage may be recorded under a
   * runtime provider alias while pricing rows use the canonical provider id,
   * so matching by model name lets the price still resolve. First
   * non-wildcard entry per model wins.
   */
  private cacheByModel: Map<string, PricingEntry> = new Map();
  private cacheLoaded = false;
  /** Coalesce manual and background refreshes to prevent a catalog stampede. */
  private refreshInFlight: Promise<PricingFetchResult> | null = null;

  constructor(
    private store: PricingStore,
    private logger: Logger,
    private options: PricingEngineOptions = {},
  ) {}

  // ===== Cache management =====

  /** Lazy-load and cache the full pricing table. */
  private async ensureCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const rows = await this.store.getAll();
    this.cache = new Map(rows.map(r => [keyOf(r.providerId, r.modelId), r]));
    this.cacheByModel = new Map();
    for (const r of rows) {
      // OpenRouter prices describe routing through OpenRouter, not the direct
      // vendor endpoint. Never let their shared model slug satisfy the legacy
      // cross-provider alias fallback.
      if (r.providerId === '*' || r.providerId === 'openrouter' || r.source === 'openrouter') continue;
      if (!this.cacheByModel.has(r.modelId)) this.cacheByModel.set(r.modelId, r);
    }
    this.cacheLoaded = true;
  }

  /** Force a cache refresh — call after any write. */
  async invalidateCache(): Promise<void> {
    this.cacheLoaded = false;
    await this.ensureCache();
  }

  // ===== Read API =====

  async getAll(): Promise<PricingEntry[]> {
    await this.ensureCache();
    return Array.from(this.cache.values());
  }

  /**
   * Look up a price for (provider, model). Resolution order:
   *   1. exact (providerId, modelId)
   *   2. wildcard provider ('*', modelId)
   *   3. model name alone (any provider) — tolerates a runtime-alias vs
   *      canonical provider-id mismatch for the same model.
   */
  async getEntry(providerId: string, modelId: string): Promise<PricingEntry | null> {
    await this.ensureCache();
    return (
      this.cache.get(keyOf(providerId, modelId)) ??
      this.cache.get(keyOf('*', modelId)) ??
      this.cacheByModel.get(modelId) ??
      null
    );
  }

  // ===== Cost calculation =====

  /**
   * Compute the cost (and cache savings) for a single response.
   *
   * Cost formula (USD):
   *   cost = (input  * inputPrice
   *         + output * outputPrice
   *         + cacheRead  * (cacheReadPrice  ?? inputPrice)
   *         + cacheWrite * (cacheWritePrice ?? inputPrice)
   *        ) / 1e6
   *
   * Cache savings:
   *   savings = cacheRead * (inputPrice - cacheReadPrice) / 1e6
   *           — clamped at 0 if cacheReadPrice is null or ≥ inputPrice.
   */
  async calculateCost(
    providerId: string,
    modelId: string,
    usage: UsageTokens,
  ): Promise<CostCalculation> {
    const entry = await this.getEntry(providerId, modelId);
    if (!entry) {
      // Unpriced model — record 0 cost and let the UI flag it.
      return { costUsd: 0, costSavedByCacheUsd: 0 };
    }

    const ip = entry.inputPricePer1m;
    const op = entry.outputPricePer1m;
    const crp = entry.cacheReadPricePer1m ?? ip;
    const cwp = entry.cacheWritePricePer1m ?? ip;

    const costUsd =
      (usage.inputTokens * ip +
        usage.outputTokens * op +
        usage.cacheReadTokens * crp +
        usage.cacheCreationTokens * cwp) /
      1_000_000;

    const savingsRate = entry.cacheReadPricePer1m == null ? 0 : Math.max(0, ip - crp);
    const costSavedByCacheUsd = (usage.cacheReadTokens * savingsRate) / 1_000_000;

    return { costUsd, costSavedByCacheUsd };
  }

  // ===== Manual upsert (used by inline editors) =====

  async upsertManual(input: PricingEntryInput): Promise<PricingEntry> {
    const updated = await this.store.upsert(input, /* asUserEdit */ true);
    this.cache.set(keyOf(updated.providerId, updated.modelId), updated);
    if (
      updated.providerId !== '*' &&
      updated.providerId !== 'openrouter' &&
      updated.source !== 'openrouter'
    ) {
      this.cacheByModel.set(updated.modelId, updated);
    }
    return updated;
  }

  // ===== Source refresh =====

  async fetchLatestFromSource(): Promise<PricingFetchResult> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.refreshSources();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async refreshSources(): Promise<PricingFetchResult> {
    const sourceUrl = this.options.sourceUrl ?? DEFAULT_LITELLM_PRICING_URL;
    const openRouterSourceUrl =
      this.options.openRouterSourceUrl ?? DEFAULT_OPENROUTER_PRICING_URL;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.fetchTimeoutMs ?? 10_000;
    const fetchedAt = Date.now();

    const [litellm, openrouter] = await Promise.all([
      fetchCatalog(fetchImpl, sourceUrl, timeoutMs, parseLitellmJson),
      fetchCatalog(fetchImpl, openRouterSourceUrl, timeoutMs, parseOpenRouterJson),
    ]);
    const sources: PricingSourceRefreshResult[] = [
      sourceResult('litellm', sourceUrl, litellm),
      sourceResult('openrouter', openRouterSourceUrl, openrouter),
    ];
    for (const source of sources) {
      if (source.status === 'failed') {
        this.logger.warn(`[PricingEngine] ${source.source} pricing-source fetch failed`, {
          error: source.error,
        });
      }
    }
    if (!litellm.ok && !openrouter.ok) {
      throw new Error(
        `Pricing-source fetch failed: LiteLLM (${litellm.error}); OpenRouter (${openrouter.error})`,
      );
    }

    const applied: PricingEntry[] = [];
    const conflicts: PricingConflict[] = [];

    if (litellm.ok) {
      const result = await this.store.bulkApplyFromSource(litellm.entries, 'litellm');
      applied.push(...result.applied);
      conflicts.push(
        ...result.conflicts.map<PricingConflict>((c) => ({
          providerId: c.current.providerId,
          modelId: c.current.modelId,
          current: c.current,
          incoming: c.incoming,
        })),
      );
      sources[0]!.appliedCount = result.applied.length;
    }

    // OpenRouter publishes the price for routing THROUGH OpenRouter. It is a
    // supplement for providerId=openrouter rows, not a substitute for direct
    // vendor prices. It may refresh only its own/builtin rows and never wins
    // over LiteLLM or a hand edit.
    if (openrouter.ok) {
      const current = new Map(
        (await this.store.getAll()).map((row) => [keyOf(row.providerId, row.modelId), row]),
      );
      const supplemental = openrouter.entries.filter((incoming) => {
        const row = current.get(keyOf(incoming.providerId, incoming.modelId));
        return !row || row.source === 'openrouter' || row.source === 'builtin';
      });
      const result = await this.store.bulkApplyFromSource(supplemental, 'openrouter');
      applied.push(...result.applied);
      sources[1]!.appliedCount = result.applied.length;
    }

    if (applied.length > 0) await this.invalidateCache();

    return {
      applied,
      conflicts,
      fetchedAt,
      sourceUrl,
      sources,
    };
  }

  // ===== Conflict resolution =====

  async resolveConflicts(
    decisions: PricingConflictDecision[],
    pendingIncoming: Map<string, PricingEntryInput>,
  ): Promise<PricingResolution> {
    const resolutions: Array<{
      incoming: PricingEntryInput;
      action: 'overwrite' | 'skip';
    }> = [];

    for (const d of decisions) {
      const incoming = pendingIncoming.get(keyOf(d.providerId, d.modelId));
      if (!incoming) continue;
      resolutions.push({ incoming, action: d.action });
    }

    const result = await this.store.applyResolutions(resolutions);
    await this.invalidateCache();
    return result;
  }
}

const keyOf = (providerId: string, modelId: string): string =>
  `${providerId}::${modelId}`;

// ===== LiteLLM JSON parsing =====
// LiteLLM publishes one JSON file with model id keys mapping to objects shaped
// like { input_cost_per_token, output_cost_per_token, cache_read_input_token_cost,
//        cache_creation_input_token_cost, litellm_provider, ... }
// All prices are USD per single token (not per 1M), so we multiply.

interface LiteLlmModelEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  // unused: max_tokens, mode, etc.
}

const PROVIDER_ALIASES: Record<string, string> = {
  vertex_ai: 'gemini',
  google: 'gemini',
  bedrock: 'anthropic',
  azure: 'openai',
};

const parseLitellmJson = (
  json: Record<string, LiteLlmModelEntry>,
): PricingEntryInput[] => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('invalid LiteLLM catalog shape');
  }
  const out: PricingEntryInput[] = [];
  for (const [modelId, entry] of Object.entries(json)) {
    // LiteLLM keeps this documentation/example object beside real model rows.
    // It has price-shaped fields, so shape validation alone cannot distinguish it.
    if (modelId === 'sample_spec') continue;
    if (!entry || typeof entry !== 'object') continue;
    if (entry.input_cost_per_token == null || entry.output_cost_per_token == null) {
      continue;
    }
    const rawProvider = entry.litellm_provider ?? '';
    const providerId = PROVIDER_ALIASES[rawProvider] ?? rawProvider;
    if (!providerId) continue;

    out.push({
      providerId,
      modelId,
      inputPricePer1m: entry.input_cost_per_token * 1_000_000,
      outputPricePer1m: entry.output_cost_per_token * 1_000_000,
      cacheReadPricePer1m:
        entry.cache_read_input_token_cost != null
          ? entry.cache_read_input_token_cost * 1_000_000
          : null,
      cacheWritePricePer1m:
        entry.cache_creation_input_token_cost != null
          ? entry.cache_creation_input_token_cost * 1_000_000
          : null,
    });
  }
  return out;
};

interface OpenRouterModelEntry {
  id?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
    input_cache_read?: unknown;
    input_cache_write?: unknown;
  };
}

interface OpenRouterCatalog {
  data?: OpenRouterModelEntry[];
}

/** Parse OpenRouter string per-token prices into OpenRouter-route rows. */
const parseOpenRouterJson = (json: OpenRouterCatalog): PricingEntryInput[] => {
  if (!json || !Array.isArray(json.data)) {
    throw new Error('invalid OpenRouter catalog shape');
  }
  const out: PricingEntryInput[] = [];
  for (const model of json.data) {
    const modelId = typeof model?.id === 'string' ? model.id.trim() : '';
    const input = parseUnitPrice(model?.pricing?.prompt);
    const output = parseUnitPrice(model?.pricing?.completion);
    if (!modelId || input === null || output === null) continue;
    const cacheRead = parseUnitPrice(model.pricing?.input_cache_read);
    const cacheWrite = parseUnitPrice(model.pricing?.input_cache_write);
    out.push({
      providerId: 'openrouter',
      modelId,
      inputPricePer1m: input * 1_000_000,
      outputPricePer1m: output * 1_000_000,
      cacheReadPricePer1m: cacheRead === null ? null : cacheRead * 1_000_000,
      cacheWritePricePer1m: cacheWrite === null ? null : cacheWrite * 1_000_000,
    });
  }
  return out;
};

function parseUnitPrice(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

type CatalogAttempt =
  | { ok: true; entries: PricingEntryInput[] }
  | { ok: false; error: string };

async function fetchCatalog<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  parse: (json: T) => PricingEntryInput[],
): Promise<CatalogAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const entries = parse((await response.json()) as T);
    // A syntactically valid but empty catalog is not a healthy refresh. Treat
    // it like a source failure so the scheduler retries on its short failure
    // interval instead of advancing the successful-refresh TTL for 24 hours.
    if (entries.length === 0) throw new Error('pricing catalog contained no usable entries');
    return { ok: true, entries };
  } catch (error) {
    const message = controller.signal.aborted
      ? `timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

function sourceResult(
  source: 'litellm' | 'openrouter',
  sourceUrl: string,
  attempt: CatalogAttempt,
): PricingSourceRefreshResult {
  return attempt.ok
    ? {
        source,
        sourceUrl,
        status: 'applied',
        parsedCount: attempt.entries.length,
        appliedCount: 0,
      }
    : {
        source,
        sourceUrl,
        status: 'failed',
        parsedCount: 0,
        appliedCount: 0,
        error: attempt.error,
      };
}
