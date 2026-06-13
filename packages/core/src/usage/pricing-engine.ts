/**
 * PricingEngine — manages model pricing and computes per-event cost.
 *
 * Persistence goes through the injected `PricingStore` port. Sources of
 * pricing rows:
 *  - 'builtin'  — bundled fallback prices, seeded by the host
 *  - 'litellm'  — refreshed on user demand from LiteLLM's public JSON
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
} from '@omnicross/contracts/pricing-types';
import { DEFAULT_LITELLM_PRICING_URL } from '@omnicross/contracts/pricing-types';
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
  /** Override `fetch` — useful for testing. */
  fetchImpl?: typeof fetch;
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
      if (r.providerId === '*') continue;
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
    if (updated.providerId !== '*') this.cacheByModel.set(updated.modelId, updated);
    return updated;
  }

  // ===== Source refresh =====

  async fetchLatestFromSource(): Promise<PricingFetchResult> {
    const sourceUrl = this.options.sourceUrl ?? DEFAULT_LITELLM_PRICING_URL;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const fetchedAt = Date.now();

    let json: Record<string, LiteLlmModelEntry>;
    try {
      const res = await fetchImpl(sourceUrl);
      if (!res.ok) {
        throw new Error(`Pricing-source fetch failed with status ${res.status}`);
      }
      json = (await res.json()) as Record<string, LiteLlmModelEntry>;
    } catch (e) {
      this.logger.warn('[PricingEngine] pricing-source fetch failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    const incoming = parseLitellmJson(json);
    const { applied, conflicts } = await this.store.bulkApplyFromSource(incoming);
    await this.invalidateCache();

    return {
      applied,
      conflicts: conflicts.map<PricingConflict>(c => ({
        providerId: c.current.providerId,
        modelId: c.current.modelId,
        current: c.current,
        incoming: c.incoming,
      })),
      fetchedAt,
      sourceUrl,
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
  const out: PricingEntryInput[] = [];
  for (const [modelId, entry] of Object.entries(json)) {
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
