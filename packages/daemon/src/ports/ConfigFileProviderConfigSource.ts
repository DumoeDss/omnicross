/**
 * ConfigFileProviderConfigSource — the daemon's file-backed `ProviderConfigSource`
 * port impl: an embedder of `@omnicross/core`'s provider catalog port.
 *
 * The daemon's `config.json` provider rows ARE the catalog. Of the port's ten
 * methods, FOUR are real (the ones the BYO proxy/outbound path actually hits):
 *  - `getProvider(id)` — map a `DaemonProviderConfig` row to an `LLMProvider`.
 *  - `getTransformerService()` — a single `TransformerService` seeded by
 *    `registerBuiltinTransformers` in the ctor.
 *  - `getMainTransformer(id)` — the transformer for the provider's target wire
 *    format (anthropic → AnthropicTransformer, gemini → GeminiTransformer,
 *    openai → null/identity), mirroring the host `AgentModelsManager` switch.
 *    `resolveProviderChain` unshifts this FORMAT-FIRST into the provider chain.
 *  - `resolveTransformerChain(id, model)` — the provider's CUSTOM
 *    `transformer.use[]` chain (app-parity-2 child 2: ENFORCED). The format
 *    transformer is NOT included here (getMainTransformer supplies it,
 *    format-first); no `transformer.use[]` → empty chain.
 *
 * The remaining SIX are minimal sensible stubs (never hit on the BYO single-key
 * path — the boot smoke test is the proof).
 *
 * @module @omnicross/daemon/ports/ConfigFileProviderConfigSource
 */

import type {
  AgentDefaultModels,
  GlobalModelParameters,
  LLMProvider,
} from '@omnicross/contracts/llm-config';
import {
  type ProviderConfigSource,
  registerBuiltinTransformers,
  type ResolvedTransformerChain,
  type Transformer,
  TransformerService,
} from '@omnicross/core';

import type { DaemonApiFormat, DaemonConfig, DaemonProviderConfig } from '../config';

/** The empty transformer chain (OpenAI target — identity, no per-format encode). */
const EMPTY_CHAIN: ResolvedTransformerChain = {
  providerTransformers: [],
  modelTransformers: [],
};

/** The built-in transformer name per non-OpenAI target format. */
const FORMAT_TRANSFORMER: Record<Exclude<DaemonApiFormat, 'openai'>, string> = {
  anthropic: 'anthropic',
  gemini: 'gemini',
};

export class ConfigFileProviderConfigSource implements ProviderConfigSource {
  private readonly providers = new Map<string, DaemonProviderConfig>();
  private readonly transformerService: TransformerService;
  /**
   * Optional reload-hook (key-pool change, design D4). A no-type-coupling
   * callback invoked at the END of `reload(...)`. `buildDaemon` injects
   * `() => pool.invalidateCache()` so the `ApiKeyPoolService.keyCache` is
   * flushed after a hot-reload swaps the catalog — WITHOUT this port ever
   * importing/depending on `ApiKeyPoolService`. Absent = no-op (single-key
   * boots that never construct a pool stay byte-identical).
   */
  private reloadHook: (() => void) | undefined;

  constructor(config: DaemonConfig) {
    for (const p of config.providers) this.providers.set(p.id, p);
    this.transformerService = new TransformerService();
    // Seed the built-in transformer set (fire-and-forget; `initialize` is async
    // but the in-memory registry is populated synchronously enough for the
    // first request — the boot smoke test awaits `ready()` before dispatching).
    void registerBuiltinTransformers(this.transformerService);
  }

  // ── Reload hook (key-pool design D4) ───────────────────────────────────────

  /**
   * Register a callback fired after every `reload(...)`. Used by `buildDaemon`
   * to invalidate the pool's keyCache on a hot-reload. The port stays ignorant
   * of what the callback does (no pool type dependency).
   */
  setReloadHook(fn: () => void): void {
    this.reloadHook = fn;
  }

  /**
   * Read the live (post-reload) provider row for `providerId`, or `undefined`.
   * Exposed so the pool's `loadKeys` reads the SAME live catalog Map this port
   * serves (so a hot-reload is observed on the next load after `invalidateCache`).
   */
  getProviderRow(providerId: string): DaemonProviderConfig | undefined {
    return this.providers.get(providerId);
  }

  /** Await the built-in transformer registration (tests await this before dispatch). */
  async ready(): Promise<void> {
    await registerBuiltinTransformers(this.transformerService);
  }

  // ── Hot-reload seam (admin dashboard, RT3 design D6) ───────────────────────

  /**
   * Replace the live provider catalog in place (additive — does NOT touch the
   * ten port methods, the seeded `TransformerService`, or `ready()`). Called by
   * the admin API after a provider POST/PUT/DELETE persists `config.json`, so the
   * next outbound request sees the new catalog WITHOUT a daemon restart. The Map
   * swap is synchronous; an in-flight request keeps its already-resolved
   * provider (no locking needed for a single-operator local daemon).
   */
  reload(config: DaemonConfig): void {
    this.setProviders(config.providers);
    // Notify the (optional) reload hook AFTER the catalog swap so the pool's
    // keyCache flushes against the new rows (key-pool design D4).
    this.reloadHook?.();
  }

  /** Clear + repopulate the private providers Map from a fresh provider list. */
  setProviders(providers: readonly DaemonProviderConfig[]): void {
    this.providers.clear();
    for (const p of providers) this.providers.set(p.id, p);
  }

  // ── REAL methods ──────────────────────────────────────────────────────────

  async getProvider(id: string): Promise<LLMProvider | null> {
    const row = this.providers.get(id);
    if (!row) return null;
    return toLLMProvider(row);
  }

  getTransformerService(): TransformerService | undefined {
    return this.transformerService;
  }

  async getMainTransformer(providerId: string): Promise<Transformer | null> {
    const row = this.providers.get(providerId);
    if (!row || row.apiFormat === 'openai') return null;
    const name = FORMAT_TRANSFORMER[row.apiFormat];
    const instances = this.transformerService.resolveTransformerReferences([name]);
    return instances[0] ?? null;
  }

  async resolveTransformerChain(
    providerId: string,
    _model?: string,
  ): Promise<ResolvedTransformerChain> {
    const row = this.providers.get(providerId);
    if (!row) return EMPTY_CHAIN;
    // app-parity-2 child 2: the provider's stored `transformer.use[]` is now
    // ENFORCED — its custom transformers (reasoning / maxtoken / deepseek / …)
    // are resolved into the provider chain (was store-only/inert before).
    //
    // The FORMAT transformer (anthropic / gemini) is intentionally NOT added
    // here: `getMainTransformer` + `resolveProviderChain`'s unshift prepend it
    // (FORMAT-FIRST — the load-bearing wire-format conversion), deduped by name,
    // so adding it here too would only be deduped away. An UNKNOWN transformer
    // name is warned + skipped by `TransformerService.resolveTransformerReferences`
    // (lenient — no hard failure, the request still proceeds). A row with no
    // `transformer.use[]` → EMPTY chain, byte-identical to before (the format
    // transformer alone, supplied by `getMainTransformer`).
    const customRefs = row.transformer?.use ?? [];
    if (customRefs.length === 0) return EMPTY_CHAIN;
    // Defensive: drop any entry naming the row's OWN format transformer. It is
    // always supplied FRONT by `getMainTransformer` (format-first); listing it
    // again here would let `resolveProviderChain`'s dedup-by-name suppress that
    // front unshift and run the format transformer SECOND. Filtering it keeps the
    // invariant regardless of UI click-order.
    const formatName = row.apiFormat === 'openai' ? undefined : FORMAT_TRANSFORMER[row.apiFormat];
    const effectiveRefs = formatName
      ? customRefs.filter((ref) => (typeof ref === 'string' ? ref : ref[0]) !== formatName)
      : customRefs;
    if (effectiveRefs.length === 0) return EMPTY_CHAIN;
    return {
      providerTransformers: this.transformerService.resolveTransformerReferences(effectiveRefs),
      modelTransformers: [],
    };
  }

  // ── STUBS (never hit on the BYO single-key path) ────────────────────────────

  async resolveRoutedModel(): Promise<null> {
    return null;
  }

  async resolveEffectiveModels(): Promise<{ background?: string; vision?: string }> {
    return {};
  }

  async getAgentDefaultModels(): Promise<AgentDefaultModels> {
    return {};
  }

  async hasVisionCapability(): Promise<boolean> {
    return false;
  }

  async getGlobalModelParameters(): Promise<GlobalModelParameters> {
    return {};
  }

  async getDiscoveredModelMaxTokens(): Promise<number | undefined> {
    return undefined;
  }
}

/**
 * Resolve the row's preferred outbound key (key-pool design D3). When the row
 * has a single `apiKey` (incl. a child-1 preset's single key), that is used
 * VERBATIM — byte-identical to before. ONLY when `apiKey` is empty AND an
 * `apiKeys[]` pool is configured does this fall to the pool's first enabled key,
 * so the ingress preferred key equals the pool's first key (no confusing "pool
 * configured but preferred is still the old single key"). This is a PURE row
 * mapping — no `ApiKeyPoolService` dependency, no core edit.
 */
function resolvePreferredApiKey(row: DaemonProviderConfig): string {
  if (row.apiKey.length > 0) return row.apiKey;
  const firstEnabled = row.apiKeys?.find((k) => k.enabled !== false && k.apiKey.length > 0);
  return firstEnabled?.apiKey ?? '';
}

/** Map a daemon provider row to the `LLMProvider` shape the core pipeline reads. */
function toLLMProvider(row: DaemonProviderConfig): LLMProvider {
  // The daemon's `gemini` format maps to the core's `google` apiFormat; the
  // transformer config drives `resolveTransformerChain` for the non-OpenAI
  // targets exactly as a host config service's provider rows do.
  const apiFormat = row.apiFormat === 'gemini' ? 'google' : row.apiFormat;
  const transformer =
    row.apiFormat === 'openai' ? undefined : { use: [FORMAT_TRANSFORMER[row.apiFormat]] };
  // app-parity-2 child 2: ENFORCE per-model `enabled` as a DISCOVERY/advertisement
  // gate — a model whose `modelConfigs[].enabled === false` is dropped from the
  // advertised `models[]`, so the served catalog no longer lists it. HONEST SCOPE:
  // this gates ADVERTISEMENT, not a hard request block — core does not validate a
  // requested model against `models[]`, so a client hardcoding a disabled model id
  // still reaches the upstream (which rejects it). The other per-model fields
  // (name / group / vision / reasoning) stay display-only metadata: the core
  // `LLMProvider` has no per-model capability binding on the BYO path.
  const allModels = row.models ?? [];
  const models = row.modelConfigs
    ? allModels.filter((id) => row.modelConfigs!.find((c) => c.id === id)?.enabled !== false)
    : allModels;
  return {
    id: row.id,
    name: row.id,
    apiFormat,
    api_base_url: row.baseUrl,
    api_key: resolvePreferredApiKey(row),
    models,
    enabled: true,
    transformer,
    // app-parity-2 child 3: POPULATE the coding-plan endpoint onto the core
    // `LLMProvider` (structurally identical to the contracts `CodingPlanConfig`).
    // The daemon does NOT resolve endpoints itself — core's shared
    // `resolveProviderEndpoint` (wired into `buildProviderApiUrl` + the BYO proxy
    // key path) reads `provider.codingPlan` and, when `enabled` + `baseUrl`, routes
    // via the coding-plan endpoint (key = `codingPlan.apiKey || api_key`). Absent →
    // undefined → the plain `api_base_url`/`api_key` path (byte-identical to before).
    codingPlan: row.codingPlan,
    // app-parity-2 child 4: POPULATE the API modes + selected id onto the core
    // `LLMProvider` (structurally identical to the contracts `ApiMode`). Core's
    // shared `resolveProviderEndpoint` (layer 1) reads them: when a mode is selected
    // it reports `source:'api-mode'` and uses `api_base_url || mode.baseUrl` /
    // `api_key || mode.apiKey`. The row's `baseUrl`/`apiKey` hold the EFFECTIVE
    // endpoint (synced on switch — baseUrl app-side, the secret key server-side in
    // `parseProviderInput`), so customizations are preserved (the row value wins).
    apiModes: row.apiModes,
    selectedApiModeId: row.selectedApiModeId,
    // Official-Anthropic signature handling only matters for the Anthropic
    // ingress (deferred → 502); leave it off for the BYO transform path.
    isOfficial: false,
  };
}
