/**
 * providerAdmin — the provider catalog + key-pool admin SERVICE LAYER.
 *
 * Plain functions over a narrow deps object, each returning a
 * {@link ServiceResult} (`{ status, body }`). The daemon's admin HTTP handlers
 * (`admin/adminApi.ts`) are thin wrappers that read the request body, call
 * these, and write the result verbatim; the embedding host
 * (`@omnicross/daemon/embed`) calls the same functions and unwraps the result.
 * One implementation, two transports.
 *
 * SECRET SPINE (design D4): secrets flow IN (create/update/add-key) and NEVER
 * OUT — every read projects through `toProviderView` / `toPoolKeyView`, which
 * mask key material with `maskProviderApiKey`.
 *
 * Import discipline: this module is part of the embed entry's static graph, so
 * it must not import `admin/adminApi.ts` (search/jsdom), image runtime modules
 * or anything that loads native code at evaluation time.
 *
 * @module @omnicross/daemon/service/providerAdmin
 */

import { parseLogJevSettings } from '@omnicross/contracts/logjev';
import { mergeExtraHeaders } from '@omnicross/core';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import { applyAdminProbeIdentity } from '../admin/testEgressIdentity';
import type { ProviderKeyQuota } from '../allowance/ProviderKeyQuotaService';
import {
  type DaemonApiKeyEntry,
  type DaemonApiMode,
  type DaemonCodingPlanConfig,
  type DaemonConfig,
  type DaemonModelConfig,
  type DaemonProviderConfig,
  type DaemonTransformerConfig,
  type DaemonTransformerEntry,
  loadConfig,
  migrateFormatAxis,
  saveConfig,
  validateExtraHeaders,
  validateFormatVariants,
  validateThinkingLevels,
  validateThinkingTokenLimit,
  validateTransformerEntry,
} from '../config';
import type { AutoDisableStore } from '../pool/autoDisableStore';
import { resolveEnvKey } from '../pool/resolveEnvKey';
import { listMappablePresets } from '../preset-map';

import { fail, ok, type ServiceResult } from './result';

/** One key's live cooldown health (mirrors core `KeyHealthEntry`; read-only). */
export interface PoolKeyHealth {
  until: number;
  errors: number;
  lastStatus: number | null;
}

/**
 * The READ-ONLY pool-health surface the admin view needs (key-pool design D7).
 * Structurally satisfied by core's `ApiKeyPoolService.getKeyHealth`; typed as a
 * minimal reader so this layer carries no class coupling and can never reach a
 * key value through it (cooldown health only).
 */
export interface PoolHealthReader {
  getKeyHealth(providerId: string): Promise<Record<string, PoolKeyHealth>>;
}

/**
 * The BYO provider-key quota surface the keys view needs — structurally
 * satisfied by `ProviderKeyQuotaService`. Read-only; the DTO is secret-free by
 * construction (normalized windows + diagnostic codes only).
 */
export interface ProviderKeyQuotaReader {
  quotaFor(
    row: DaemonProviderConfig,
    keyId: string,
    options?: { force?: boolean },
  ): Promise<ProviderKeyQuota | null>;
}

/** The live handles the provider service operates over. */
export interface ProviderAdminDeps {
  /** Path to `config.json` (the provider catalog is read/written here). */
  readonly configPath: string;
  /** Live provider catalog (hot-reload target). */
  readonly llmConfig: { reload(cfg: DaemonConfig): void };
  /** Read-only pool cooldown health. */
  readonly apiKeyPool: PoolHealthReader;
  /** In-memory auto-disable store (read-only here). */
  readonly autoDisableStore: Pick<AutoDisableStore, 'get' | 'isDisabled'>;
  /** Optional BYO key quota probes (absent ⇒ no `quota` on key views). */
  readonly providerKeyQuota?: ProviderKeyQuotaReader;
  /**
   * Best-effort hook after every catalog write (the daemon re-derives its live
   * gateway routing here). Failures are swallowed.
   */
  readonly afterProvidersChanged?: () => Promise<void>;
  /**
   * Create-time conveniences that run AFTER model discovery inside the same
   * best-effort block (the daemon's default mapping row + onboarding access
   * key). Absent for embedded hosts, which have no gateway.
   */
  readonly provisionProviderDefaults?: (
    row: DaemonProviderConfig,
    isFirstProvider: boolean,
  ) => Promise<void>;
}

/** Persist the config to disk AND hot-reload the live provider catalog. */
export async function persistProviders(cfg: DaemonConfig, deps: ProviderAdminDeps): Promise<void> {
  saveConfig(deps.configPath, cfg);
  deps.llmConfig.reload(cfg);
  // UPSTREAM ROUTING MODEL: the provider catalog feeds `mode:'all'` expansion
  // and derived-binding labels — re-derive so live routing follows the edit.
  await deps.afterProvidersChanged?.().catch(() => undefined);
}

// ── Provider CRUD ──────────────────────────────────────────────────────────

/** `GET /providers` → every row, masked. */
export function listProviders(deps: Pick<ProviderAdminDeps, 'configPath'>): ServiceResult {
  return ok(200, { providers: loadConfig(deps.configPath).providers.map(toProviderView) });
}

/**
 * `POST /providers` → validate + append + persist, then run create-time
 * provisioning (model discovery, daemon defaults). 201 with the masked row.
 */
export async function createProvider(
  deps: ProviderAdminDeps,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  const provider = parseProviderInput(body, undefined);
  if (!provider) return fail(400, 'invalid provider (id, apiFormat, baseUrl required)');
  if (cfg.providers.some((p) => p.id === provider.id)) {
    return fail(409, `provider '${provider.id}' already exists`);
  }
  const isFirstProvider = cfg.providers.length === 0;
  cfg.providers.push(provider);
  await persistProviders(cfg, deps);
  await provisionNewProvider(deps, provider, isFirstProvider);
  return ok(201, { provider: toProviderView(provider) });
}

/**
 * `PUT /providers/:id` → patch one row. Omitted fields keep the stored value,
 * `null` clears, a blank `apiKey` keeps the stored key.
 */
export async function updateProvider(
  deps: ProviderAdminDeps,
  id: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);
  // Blank/omitted apiKey keeps the existing stored key (edit without re-entry).
  const existing = cfg.providers[idx];
  const updated = parseProviderInput(body, existing);
  if (!updated) return fail(400, 'invalid provider (apiFormat, baseUrl required)');
  cfg.providers[idx] = updated;
  await persistProviders(cfg, deps);
  return ok(200, { provider: toProviderView(updated) });
}

/** `DELETE /providers/:id`. */
export async function deleteProvider(
  deps: ProviderAdminDeps,
  id: string | undefined,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);
  cfg.providers.splice(idx, 1);
  await persistProviders(cfg, deps);
  return ok(200, { ok: true });
}

/**
 * `GET /providers/:id/reveal-key` → the DECRYPTED stored provider key. The
 * secret crosses OUT here BY DESIGN, ONLY on this explicit per-key request
 * (never in the list). Callers gate it (the daemon behind the viewing password).
 */
export function revealProviderKey(
  deps: Pick<ProviderAdminDeps, 'configPath'>,
  id: string | undefined,
): ServiceResult {
  const row = loadConfig(deps.configPath).providers.find((p) => p.id === id);
  if (!row) return fail(404, `provider '${id}' not found`);
  return ok(200, { apiKey: row.apiKey ?? '' });
}

/**
 * Mask a provider's stored `apiKey` so no literal/env secret ever leaves via a
 * GET (design D4). A literal `sk-…wxyz` → `'sk-…wxyz'` (last4 only); a `$ENV_VAR`
 * reference → `'$ENV(•••)'` (the var NAME is masked too, so the indirection
 * never leaks). Empty → empty.
 */
export function maskProviderApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) return '$ENV(•••)';
  const last4 = apiKey.length >= 4 ? apiKey.slice(-4) : apiKey;
  return `sk-…${last4}`;
}

/** The masked provider DTO every read returns. */
export type ProviderView = ReturnType<typeof toProviderView>;

/** Project a provider row to the masked GET shape (literal apiKey never serialized). */
export function toProviderView(row: DaemonProviderConfig): {
  logjev?: DaemonProviderConfig['logjev'];
  id: string;
  name?: string;
  apiFormat: string;
  baseUrl: string;
  models: string[];
  modelConfigs?: DaemonModelConfig[];
  hasApiKey: boolean;
  apiKeyMasked: string;
  enabled: boolean;
  category?: 'other';
  isOfficial?: boolean;
  apiVersion?: string;
  maxConcurrency?: number;
  modelsEndpoint?: string;
  extraHeaders?: Record<string, string>;
  formatVariants?: DaemonProviderConfig['formatVariants'];
  transformer?: DaemonTransformerConfig;
  codingPlan?: { enabled: boolean; baseUrl?: string; hasApiKey: boolean; note?: string };
  apiModes?: Array<{ id: string; label: string; baseUrl: string; hasApiKey: boolean; apiKeyPrefix?: string; note?: string }>;
  selectedApiModeId?: string;
} {
  return {
    id: row.id,
    // app-parity-2 child 1: mutable display name (non-secret) round-trips verbatim;
    // absent stays absent (the app falls back to the id for display).
    name: row.name,
    logjev: row.logjev,
    apiFormat: row.apiFormat,
    baseUrl: row.baseUrl,
    models: row.models ?? [],
    // app-parity child 2: per-model metadata round-trips verbatim (non-secret —
    // no masking; absent stays absent so a flat-models-only row has no key).
    modelConfigs: row.modelConfigs,
    hasApiKey: row.apiKey.length > 0,
    apiKeyMasked: maskProviderApiKey(row.apiKey),
    // app-foundation D8: absent `enabled` reads as enabled (back-compat).
    enabled: row.enabled !== false,
    // Catalog category round-trips verbatim ('other' = non-chat key storage).
    category: row.category,
    // app-parity child 1: non-secret scalar fields round-trip verbatim (no masking).
    isOfficial: row.isOfficial,
    apiVersion: row.apiVersion,
    maxConcurrency: row.maxConcurrency,
    modelsEndpoint: row.modelsEndpoint,
    // Static extra headers round-trip VERBATIM (non-secret identity values;
    // auth/content names were already dropped at the write/load gate).
    extraHeaders: row.extraHeaders,
    formatVariants: row.formatVariants,
    // app-parity child 5: transformer config round-trips VERBATIM (non-secret —
    // transform-rule names + options, no key material; absent stays absent).
    transformer: row.transformer,
    // app-parity-2 child 3: coding-plan endpoint MASKED — the secret `apiKey` is
    // NEVER serialized out (only a `hasApiKey` boolean); enabled/baseUrl/note are
    // non-secret. Absent stays absent.
    codingPlan: row.codingPlan
      ? {
          enabled: row.codingPlan.enabled,
          baseUrl: row.codingPlan.baseUrl,
          hasApiKey: typeof row.codingPlan.apiKey === 'string' && row.codingPlan.apiKey.length > 0,
          note: row.codingPlan.note,
        }
      : undefined,
    // app-parity-2 child 4: API modes MASKED — each mode's secret `apiKey` is
    // NEVER serialized out (only a per-mode `hasApiKey`); id/label/baseUrl/prefix/
    // note are non-secret. Absent stays absent.
    apiModes: row.apiModes
      ? row.apiModes.map((m) => ({
          id: m.id,
          label: m.label,
          baseUrl: m.baseUrl,
          hasApiKey: typeof m.apiKey === 'string' && m.apiKey.length > 0,
          apiKeyPrefix: m.apiKeyPrefix,
          note: m.note,
        }))
      : undefined,
    selectedApiModeId: row.selectedApiModeId,
  };
}

// ── Model discovery ──────────────────────────────────────────────────────────

/** Union of a provider's existing model ids and discovered ones — existing
 *  entries keep their order and lead (the template's first model stays the
 *  provisioned default); discovered ids append deduped. */
export function mergeProviderModels(
  existing: readonly string[] | undefined,
  discovered: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const model of [...(existing ?? []), ...discovered]) {
    const id = model.trim();
    const key = id.toLocaleLowerCase();
    if (id === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(id);
  }
  return merged;
}

/**
 * Candidate OpenAI-wire `/models` URLs for an ANTHROPIC-format row. The
 * dual/tri-format providers (verified keyless 2026-09-24 — a 401 means the
 * route exists behind auth) share one key across wires:
 *   deepseek  https://api.deepseek.com/anthropic   → /models AND /v1/models
 *   mimo      https://api.xiaomimimo.com/anthropic → /v1/models
 *   z.ai      https://api.z.ai/api/anthropic       → /api/paas/v4/models
 * (`/v1/models` on z.ai and bare `/models` on mimo are 404 — hence the
 * candidate LIST, tried in order, first authenticated hit wins.)
 */
export function anthropicModelDiscoveryUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const root = base.toLowerCase().endsWith('/anthropic')
    ? base.slice(0, -'/anthropic'.length)
    : base;
  const candidates = [
    `${root}/v1/models`,
    `${root}/models`,
    // z.ai's OpenAI wire lives under paas/v4 — reached from an /api-rooted
    // anthropic base (`…/api/anthropic` → `…/api/paas/v4/models`); the /api
    // variant covers operators who entered a domain-root base.
    `${root}/paas/v4/models`,
    `${root}/api/paas/v4/models`,
  ];
  return [...new Set(candidates)];
}

/**
 * Scope a LOGJEV row's discovered ids to the Jev family. A logjev provider's
 * model list feeds DECISIONS only, but aggregator upstreams (OpenRouter)
 * answer `/models` with their whole chat catalog — keep just the ids whose
 * model segment is `jev` or `jev-*` (e.g. `typesafe/jev-latest`, `jev-latest`).
 * Non-logjev rows pass through untouched. Pure; exported for tests.
 */
export function scopeDiscoveredIdsToJev(
  row: DaemonProviderConfig,
  ids: readonly string[],
): string[] {
  if (!row.logjev) return [...ids];
  return ids.filter((id) => {
    const model = id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf(':')) + 1);
    return /^jev(-|$)/i.test(model);
  });
}

/** Fetch one `/models` URL; `ids` empty + `error` set on any failure (the
 *  caller tries the next candidate). Shared by the openai-wire path and the
 *  anthropic probe list. Never throws.
 *
 *  The error string names the URL it tried — a gateway that 404s EVERY unknown
 *  route with the same generic message (e.g. "404 Not found. Check the docs…")
 *  otherwise leaves the operator guessing which candidate actually failed. */
async function fetchModelsFromUrl(
  url: string,
  row: DaemonProviderConfig,
  signal?: AbortSignal,
): Promise<{ ids: string[]; error?: string }> {
  try {
    const resolvedKey = resolveEnvKey(row.apiKey);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (resolvedKey) headers['Authorization'] = `Bearer ${resolvedKey}`;
    // Static extra headers (e.g. the Cline identity set) gate the SAME
    // /models surface as completions.
    Object.assign(headers, expandRowExtraHeaders(row));
    applyAdminProbeIdentity(headers, row);
    // upstream-proxy: BYO discovery egress honors the global/provider proxy.
    const response = await fetchUpstream(url, { method: 'GET', headers, signal }, { providerId: 'byo' });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as {
          error?: { message?: string };
          message?: string;
          cause?: string;
        };
        // `cause` first: gateways like commandcode put the actionable detail
        // ("GET <url> is not a registered API route") there, while `message`
        // stays generic ("404 Not found. Check the docs…").
        message = parsed?.cause || parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep the raw text slice
      }
      return {
        ids: [],
        error: `discovery failed (${response.status}) from ${url}${message ? `: ${message}` : ''}`,
      };
    }
    const data = (await response.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    if (!Array.isArray(data?.data)) return { ids: [], error: 'discovery failed: unexpected /models payload' };
    const rawIds = data.data
      .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
      .filter((id) => id.length > 0);
    if (rawIds.length === 0) return { ids: [], error: 'discovery failed: the /models endpoint returned no models' };
    // A logjev row keeps only the Jev-family ids (see scopeDiscoveredIdsToJev).
    const ids = scopeDiscoveredIdsToJev(row, rawIds);
    if (ids.length === 0) {
      return { ids: [], error: 'discovery failed: the /models response carries no Jev-family models (jev / jev-*)' };
    }
    return { ids };
  } catch (err) {
    return { ids: [], error: `discovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Fetch a provider's `/models` ids — the SILENT core reused by create-time
 * provisioning (any failure ⇒ []). OpenAI wires hit their own `{base}/models`;
 * ANTHROPIC-format rows probe the provider's OpenAI wire (dual-format
 * providers share the key across wires).
 */
async function fetchProviderModelIds(
  row: DaemonProviderConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  if (row.apiFormat === 'gemini') return [];
  if (row.apiFormat !== 'openai' && row.apiFormat !== 'openai-response' && row.apiFormat !== 'anthropic') return [];
  for (const url of modelDiscoveryCandidates(row)) {
    const ids = (await fetchModelsFromUrl(url, row, signal)).ids;
    if (ids.length > 0) return ids;
  }
  return [];
}

/**
 * The DISCOVER-MODELS ROUTE's detailed variant: same probing, but the error
 * says which candidate URLs were tried.
 */
async function discoverProviderModelsDetailed(
  row: DaemonProviderConfig,
  signal?: AbortSignal,
): Promise<{ models: string[]; error?: string }> {
  const tried = modelDiscoveryCandidates(row);
  let lastError = '';
  for (const url of tried) {
    const result = await fetchModelsFromUrl(url, row, signal);
    if (result.ids.length > 0) return { models: result.ids };
    lastError = result.error ?? lastError;
  }
  return {
    models: [],
    error: `${lastError || 'no /models endpoint answered'} (tried ${tried.join(', ')})`,
  };
}

/**
 * Candidate `/models` URLs for an OpenAI-wire row, tried in order, first
 * authenticated hit wins. Rows may store EITHER the API base (`…/v1`) or the
 * FULL completion endpoint (`…/v1/chat/completions` — the openai/deepseek
 * preset shape); appending `/models` to the latter produces a 404. The first
 * candidate strips a trailing completion suffix, matching the UI's
 * models-endpoint placeholder and `chatCompletionsUrlForRow`'s normalization.
 * The `/v1/models` fallback covers a bare-root base (`…/provider`).
 */
export function openAiWireModelDiscoveryUrls(baseUrl: string, category?: 'other'): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/(chat\/completions|responses|messages)$/, '');
  const candidates = [
    root === base ? `${base}/models` : `${root}/models`,
    ...(/\/v\d+[a-z]*$/.test(root) ? [] : [`${root}/v1/models`]),
  ];
  if (category === 'other') {
    // 'other' rows are non-chat tool storage: the legacy derivation kept a
    // trailing `/v1/<leaf>` (e.g. an embeddings endpoint) and swapped it for
    // `/v1/models` — preserve that shape as an extra candidate.
    candidates.push(`${root.replace(/\/v1\/[^/]+$/, '/v1')}/models`);
  }
  return [...new Set(candidates)];
}

/**
 * The FINAL candidate list for one row's model discovery: a user-configured
 * `modelsEndpoint` (the "Models Endpoint" field) overrides every derived
 * candidate — tried alone, exactly as typed.
 */
function modelDiscoveryCandidates(row: DaemonProviderConfig): string[] {
  const explicit = row.modelsEndpoint?.trim();
  if (explicit) return [explicit];
  if (row.apiFormat === 'anthropic') return anthropicModelDiscoveryUrls(row.baseUrl);
  return openAiWireModelDiscoveryUrls(row.baseUrl, row.category);
}

/**
 * Zero-config provisioning after a provider is created: model discovery first
 * (merged into the row), then the host's `provisionProviderDefaults` hook (the
 * daemon adds a `* -> <default model>` mapping row and, on the FIRST provider,
 * an onboarding access key bound to every upstream).
 *
 * Best-effort BY DESIGN: the provider itself was already created; onboarding
 * conveniences must never fail (or roll back) the create.
 */
export async function provisionNewProvider(
  deps: ProviderAdminDeps,
  provider: DaemonProviderConfig,
  isFirstProvider: boolean,
): Promise<void> {
  try {
    // MODEL DISCOVERY FIRST (best-effort, time-bounded): a provider created
    // without a model list can neither serve nor enter the upstream catalog —
    // the mapping editor then fails its save with `unknown upstream <id>`.
    // Discovered ids merge INTO the row's list; template-provided models keep
    // their order and lead (so the provisioned default below stays the
    // template's first model when the template configured one).
    let row = provider;
    if (row.apiFormat !== 'gemini') {
      const discovered = await fetchProviderModelIds(row, AbortSignal.timeout(8000)).catch(() => [] as string[]);
      const merged = mergeProviderModels(row.models, discovered);
      if (merged.length !== (row.models?.length ?? 0)) {
        row = { ...row, models: merged };
        const cfg = loadConfig(deps.configPath);
        const index = cfg.providers.findIndex((candidate) => candidate.id === row.id);
        if (index >= 0) {
          cfg.providers[index] = row;
          await persistProviders(cfg, deps);
        }
      }
    }
    await deps.provisionProviderDefaults?.(row, isFirstProvider);
  } catch {
    // Provisioning is a convenience layer — never fail the provider create.
  }
}

/**
 * `POST /admin/api/providers/reorder` (app-foundation D8) — reorder `cfg.providers`
 * to match the body's `{ order: string[] }`. Ids present in `order` are placed
 * first in that order; ids NOT in `order` (omitted) keep their prior relative
 * order, appended after; unknown ids in `order` are ignored. No error, no data
 * loss. Persists + hot-reloads via `persistProviders`, returns the masked DTO.
 */
export async function reorderProviders(
  deps: ProviderAdminDeps,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  const rawOrder = body['order'];
  if (!Array.isArray(rawOrder)) {
    return fail(400, 'reorder requires { order: string[] }');
  }
  const order = rawOrder.filter((x): x is string => typeof x === 'string');
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const reordered: DaemonProviderConfig[] = [];
  // 1) Ordered ids first (unknown ids ignored; duplicates de-duped).
  for (const id of order) {
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      reordered.push(row);
      seen.add(id);
    }
  }
  // 2) Omitted ids appended preserving their prior relative order.
  for (const row of cfg.providers) {
    if (!seen.has(row.id)) {
      reordered.push(row);
      seen.add(row.id);
    }
  }
  cfg.providers = reordered;
  await persistProviders(cfg, deps);
  return ok(200, { ok: true, providers: cfg.providers.map(toProviderView) });
}

/**
 * A provider row's static extra headers with `{{platform}}` expanded — for the
 * admin probe paths (discover-models / test-model) that build headers inline
 * instead of going through core's `getProviderHeaders` funnel.
 */
export function expandRowExtraHeaders(row: DaemonProviderConfig): Record<string, string> {
  return mergeExtraHeaders({}, row.extraHeaders);
}

// ── Discover + test (real upstream calls) ──────────────────────────────────

/**
 * `POST /admin/api/providers/:id/discover-models` (app-foundation D8) — list the
 * upstream models for an OpenAI-format provider via `GET {baseUrl}/models`.
 *
 * SCOPE: openai format only. anthropic/gemini return `{ models: [],
 * unsupportedFormat: true }` (HTTP 200, no upstream call). On any upstream
 * failure the daemon returns `{ models: [], error: <message> }` (HTTP 200) so the
 * UI can show it inline.
 *
 * SECRET SPINE (design D4): the resolved key authenticates the upstream GET but
 * is NEVER serialized into the response. The error message is the upstream's
 * status/parsed-message text only — it never echoes the key or `$ENV` name.
 */
export async function discoverProviderModels(
  deps: Pick<ProviderAdminDeps, 'configPath'>,
  id: string | undefined,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return fail(404, `provider '${id}' not found`);

  // OpenAI wires serve `GET {base}/models`; anthropic-format rows probe the
  // provider's OpenAI wire instead (dual/tri-format providers share the key
  // across wires — see anthropicModelDiscoveryUrls). gemini has no
  // OpenAI-wire equivalent at all, so it stays unsupported.
  if (row.apiFormat === 'gemini') {
    return ok(200, { models: [], unsupportedFormat: true });
  }
  const { models, error } = await discoverProviderModelsDetailed(row, AbortSignal.timeout(15000));
  return ok(200, { models, ...(error ? { error } : {}) });
}

/**
 * `POST /admin/api/providers/:id/test` `{ model }` — issue ONE minimal upstream
 * completion using the provider's stored key, so the per-model "test" button on
 * the Provider page works (parity with the host app's per-model test). Mirrors
 * `handleDiscoverModels`' key-resolution + direct-fetch pattern. The provider's
 * `baseUrl` IS the full completion endpoint (per the preset catalog). Format-aware
 * body/headers for openai + anthropic; gemini is reported unsupported (its request
 * shape puts the model + key in the URL — out of this minimal tester's scope).
 *
 * SECRET-SAFE: the resolved key is used ONLY as the upstream auth header and is
 * NEVER serialized into the response (which carries only ok/status/latency/sample/
 * message).
 */
export async function testProviderModel(
  deps: Pick<ProviderAdminDeps, 'configPath'>,
  id: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return fail(404, `provider '${id}' not found`);

  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  if (!model) return fail(400, 'test requires a { model } string');

  if (row.apiFormat === 'gemini') {
    return ok(200, { ok: false, unsupportedFormat: true });
  }

  const resolvedKey = resolveEnvKey(row.apiKey);
  if (!resolvedKey) {
    return ok(200, { ok: false, message: 'no API key configured for this provider' });
  }
  let url = row.baseUrl.replace(/\/+$/, '');
  const prompt = 'Reply with the single word: OK.';

  // MODEL-AWARE WIRE (multi-format fan-out): a dual/tri-wire provider may
  // serve SOME models only on a non-primary wire — commandcode Claude models
  // accept ONLY the /messages shape (the chat wire 400s: must be called via
  // /provider/v1/messages). When the row declares an anthropic variant AND
  // the model looks Claude-shaped, probe THAT wire instead of the primary.
  // Non-Claude models keep the primary wire verbatim (byte-identical).
  const claudeLikeModel = /^(?:anthropic[/.]|claude[-_.])/i.test(model);
  const anthropicVariant = row.formatVariants?.anthropic;
  const useAnthropicWire = claudeLikeModel && !!anthropicVariant && row.apiFormat !== 'anthropic';
  const effectiveFormat = useAnthropicWire ? 'anthropic' : row.apiFormat;
  if (useAnthropicWire && anthropicVariant) {
    url = anthropicVariant.replace(/\/+$/, '');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let payload: Record<string, unknown>;
  if (effectiveFormat === 'anthropic') {
    headers['x-api-key'] = resolvedKey;
    headers['anthropic-version'] = '2023-06-01';
    payload = { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] };
  } else if (effectiveFormat === 'openai-response') {
    // The Responses wire is NOT chat-shaped: `input`/`max_output_tokens`, and the
    // row stores a BASE (`https://api.openai.com`) rather than the full endpoint
    // the chat rows store — so the path is appended when absent. Previously this
    // fell into the chat branch and POSTed a chat body at the bare base.
    headers['Authorization'] = `Bearer ${resolvedKey}`;
    if (!/\/responses$/.test(url)) url = `${url}/v1/responses`;
    payload = { model, max_output_tokens: 16, stream: false, input: prompt };
  } else {
    // openai chat wire format (also covers azure-openai BYO rows).
    headers['Authorization'] = `Bearer ${resolvedKey}`;
    payload = {
      model,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    };
  }
  // Static extra headers (e.g. the Cline identity set) — same gate as the
  // completion path; without them the probe 403s on gated gateways.
  Object.assign(headers, expandRowExtraHeaders(row));
  // Probe egress identity (product user-agent; opencode.ai session hint) —
  // fill-only after the merge, so row-level extraHeaders still win.
  applyAdminProbeIdentity(headers, row);

  const startedAt = Date.now();
  try {
    // upstream-proxy: BYO test-model egress honors the global/provider proxy.
    // BOUNDED: a hung/black-holed upstream (or proxy) must surface as a
    // failure here — without a signal the await never settles and the dialog
    // spins forever (same bound as the logjev probe below).
    const response = await fetchUpstream(
      url,
      { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) },
      { providerId: 'byo' },
    );
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep the raw slice
      }
      // An HTML page means the request never reached an API route: the
      // provider row's baseUrl points at the vendor's WEBSITE (root or a
      // console path) instead of the completion endpoint. The raw HTML slice
      // is useless in the dialog — say what to fix instead.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/html')) {
        message =
          'The upstream returned an HTML page — the provider base URL points at a website, ' +
          'not the API completion endpoint. Set it to the full endpoint ' +
          '(e.g. https://…/v1/chat/completions).';
      }
      return ok(200, { ok: false, status: response.status, latencyMs, message });
    }
    return ok(200, {
      ok: true,
      status: response.status,
      latencyMs,
      sample: extractSampleText(text, effectiveFormat),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return ok(200, { ok: false, latencyMs: Date.now() - startedAt, message });
  }
}

/** Pull a short reply snippet from an openai/anthropic completion body (best-effort). */
function extractSampleText(text: string, apiFormat: DaemonProviderConfig['apiFormat']): string {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (apiFormat === 'anthropic') {
      const content = (data['content'] as Array<{ text?: unknown }> | undefined)?.[0]?.text;
      return typeof content === 'string' ? content.slice(0, 200) : '';
    }
    const choice = (data['choices'] as Array<{ message?: { content?: unknown } }> | undefined)?.[0];
    const content = choice?.message?.content;
    return typeof content === 'string' ? content.slice(0, 200) : '';
  } catch {
    return '';
  }
}

/**
 * The OpenAI-chat endpoint for a BYO row's baseUrl. Rows store EITHER the full
 * endpoint (`…/v1/chat/completions` — openai/deepseek presets) or a base
 * (`…/v1` — openrouter/nim); normalize both shapes to the endpoint.
 */
export function chatCompletionsUrlForRow(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

// ── Key pool ──────────────────────────────────────────────────────────────

/** The masked, never-secret pool-key DTO the health view projects. */
export interface PoolKeyView {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  apiKeyMasked: string;
  health?: { cooldown?: PoolKeyHealth; autoDisabled?: { status: number; at: number; reason: string } };
  /** Plan-usage windows for providers with a quota adapter (Z.AI, MiniMax…). */
  quota?: ProviderKeyQuota;
}

/**
 * Project the provider's pool (mirroring the loader's D1 synthesis: an explicit
 * `apiKeys[]`, else a single-key 1-key fallback) to the masked health DTO. The
 * key value is ALWAYS run through `maskProviderApiKey` — the literal/`$ENV` name
 * never leaves (design D7). `health` merges the live cooldown map + the
 * in-memory auto-disable record.
 */
function toPoolKeyView(
  row: DaemonProviderConfig,
  cooldown: Record<string, PoolKeyHealth>,
  deps: Pick<ProviderAdminDeps, 'autoDisableStore'>,
): PoolKeyView[] {
  const entries: Array<{ id: string; apiKey: string; label?: string; enabled?: boolean; weight?: number }> =
    row.apiKeys && row.apiKeys.length > 0
      ? row.apiKeys
      : row.apiKey.length > 0
        ? [{ id: `${row.id}:default`, apiKey: row.apiKey, weight: 1, enabled: true }]
        : [];
  return entries.map((e) => {
    const auto = deps.autoDisableStore.get(e.id);
    const cd = cooldown[e.id];
    const health: PoolKeyView['health'] = {};
    if (cd) health.cooldown = cd;
    if (auto) health.autoDisabled = { status: auto.status, at: auto.at, reason: auto.reason };
    return {
      id: e.id,
      label: e.label && e.label.length > 0 ? e.label : e.id,
      // An auto-disabled key reads disabled even when the config flag is true.
      enabled: e.enabled !== false && !deps.autoDisableStore.isDisabled(e.id),
      weight: typeof e.weight === 'number' && Number.isFinite(e.weight) ? e.weight : 1,
      apiKeyMasked: maskProviderApiKey(e.apiKey),
      ...(Object.keys(health).length > 0 ? { health } : {}),
    };
  });
}

/**
 * `GET /admin/api/providers/:id/keys` (key-pool design D7) — read-only masked
 * pool health for one provider. Secret IN-never-OUT: no `apiKey` literal or
 * `$VAR` name is ever serialized (the mask handles both). When a quota service
 * is wired and the row matches a quota adapter, each key view carries its
 * cached usage windows (the service is read-through, so the UI's frequent
 * health polling stays cheap).
 */
export async function listProviderKeys(
  deps: ProviderAdminDeps,
  id: string | undefined,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return fail(404, `provider '${id}' not found`);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  const views = toPoolKeyView(row, cooldown, deps);
  if (deps.providerKeyQuota) {
    const quotas = await Promise.allSettled(
      views.map((view) => deps.providerKeyQuota!.quotaFor(row, view.id)),
    );
    views.forEach((view, index) => {
      const settled = quotas[index];
      if (settled.status === 'fulfilled' && settled.value) view.quota = settled.value;
    });
  }
  return ok(200, { keys: views });
}

/**
 * `POST /admin/api/providers/:id/keys/:keyId/quota/refresh` — force one quota
 * probe past the read-through cache (the per-key refresh button). 404 for an
 * unknown provider/key or a row with no quota adapter.
 */
export async function refreshProviderKeyQuota(
  deps: ProviderAdminDeps,
  id: string | undefined,
  keyId: string | undefined,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!deps.providerKeyQuota) return fail(501, 'provider key quota is not available');
  if (!id || !keyId) return fail(400, 'provider id and key id required in path');
  const row = cfg.providers.find((p) => p.id === id);
  if (!row) return fail(404, `provider '${id}' not found`);
  try {
    const quota = await deps.providerKeyQuota.quotaFor(row, keyId, { force: true });
    if (!quota) return fail(404, `no quota endpoint for key '${keyId}'`);
    return ok(200, { quota });
  } catch {
    // A forced probe failure surfaces as the degraded cached snapshot, not an
    // upstream error body (leak-safe by construction).
    return fail(502, 'quota refresh failed');
  }
}

/**
 * Positive-construction allowlist for ONE pool-key write (app-parity child 3).
 * Mirrors `parseApiKeysInput`'s per-entry discipline at the single-entry level:
 * only `{ label?, weight?, enabled?, apiKey? }` are ever read; every unknown
 * field is dropped (deny-by-default). A blank/omitted `apiKey` keeps the
 * `existing?.apiKey` (the child-1/2 omit→keep contract, per entry); a non-empty
 * `apiKey` replaces it. `id`/`providerId` are NOT taken from the body — the id is
 * minted on add / read from the path on update, the provider from the path.
 */
function parsePoolKeyInput(
  body: Record<string, unknown>,
  existing?: DaemonApiKeyEntry,
): { label?: string; weight?: number; enabled?: boolean; apiKey?: string } {
  const out: { label?: string; weight?: number; enabled?: boolean; apiKey?: string } = {};
  if (typeof body['label'] === 'string' && body['label'].length > 0) out.label = body['label'];
  else if (existing?.label) out.label = existing.label;
  if (typeof body['weight'] === 'number' && Number.isFinite(body['weight'])) out.weight = body['weight'];
  else if (typeof existing?.weight === 'number') out.weight = existing.weight;
  if (typeof body['enabled'] === 'boolean') out.enabled = body['enabled'];
  else if (typeof existing?.enabled === 'boolean') out.enabled = existing.enabled;
  const submitted = typeof body['apiKey'] === 'string' && body['apiKey'].length > 0 ? body['apiKey'] : '';
  const apiKey = submitted || existing?.apiKey || '';
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/**
 * `POST /admin/api/providers/:id/keys` (app-parity child 3) — add one pool key.
 * Server-side read-modify-write on the provider row's `apiKeys[]`: mint a stable
 * id (OQ2 — never accept a client-suggested id), require a non-empty `apiKey`,
 * `persistProviders` (encrypts at rest via the SAME `saveConfig`+SecretBox path +
 * hot-reloads the pool keyCache). Responds ONLY the masked health view.
 *
 * SECRET-IN-never-OUT (design D3): the plaintext key crosses on the request IN
 * only — the response + any log carry ONLY `toPoolKeyView`'s masked output.
 */
export async function addProviderKey(
  deps: ProviderAdminDeps,
  id: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);

  const parsed = parsePoolKeyInput(body);
  if (!parsed.apiKey) return fail(400, 'add requires a non-empty apiKey');

  const keyId = `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: DaemonApiKeyEntry = { id: keyId, apiKey: parsed.apiKey };
  if (parsed.label !== undefined) entry.label = parsed.label;
  if (parsed.enabled !== undefined) entry.enabled = parsed.enabled;
  if (parsed.weight !== undefined) entry.weight = parsed.weight;

  const row = cfg.providers[idx];
  row.apiKeys = [...(row.apiKeys ?? []), entry];
  await persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return ok(201, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `PUT /admin/api/providers/:id/keys/:keyId` (child 3) — update ONE pool key's
 * `{ label?, weight?, enabled?, apiKey? }`. A blank/omitted `apiKey` KEEPS the
 * stored key (omit→keep); a non-empty one replaces it (re-encrypted at rest).
 * Responds ONLY the masked view (secret-IN-never-OUT).
 */
export async function updateProviderKey(
  deps: ProviderAdminDeps,
  id: string | undefined,
  keyId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  if (!keyId) return fail(400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return fail(404, `pool key '${keyId}' not found`);

  const existing = row.apiKeys![keyIdx];
  const parsed = parsePoolKeyInput(body, existing);
  // `apiKey` always resolves (blank keeps `existing.apiKey`); an entry with no
  // key at all is meaningless — keep the stored one defensively.
  const entry: DaemonApiKeyEntry = { id: keyId, apiKey: parsed.apiKey || existing.apiKey };
  if (parsed.label !== undefined) entry.label = parsed.label;
  if (parsed.enabled !== undefined) entry.enabled = parsed.enabled;
  if (parsed.weight !== undefined) entry.weight = parsed.weight;
  row.apiKeys![keyIdx] = entry;

  await persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return ok(200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `DELETE /admin/api/providers/:id/keys/:keyId` (child 3) — remove ONE pool key.
 * If the pool empties, set `apiKeys` to `undefined` (consistent with
 * `validateApiKeys`'s "empty → undefined = single-key fallback"). Responds the
 * masked view of the remaining pool.
 */
export async function deleteProviderKey(
  deps: ProviderAdminDeps,
  id: string | undefined,
  keyId: string | undefined,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  if (!keyId) return fail(400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return fail(404, `pool key '${keyId}' not found`);

  row.apiKeys!.splice(keyIdx, 1);
  if (row.apiKeys!.length === 0) row.apiKeys = undefined;
  await persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return ok(200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * `POST /admin/api/providers/:id/keys/:keyId/enabled` (child 3) — flip ONE pool
 * key's `enabled` flag from `{ enabled: boolean }` (coerced). Responds the masked
 * view (the live pool's auto-disable health still applies post-hot-reload).
 */
export async function setProviderKeyEnabled(
  deps: ProviderAdminDeps,
  id: string | undefined,
  keyId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const cfg = loadConfig(deps.configPath);
  if (!id) return fail(400, 'provider id required in path');
  if (!keyId) return fail(400, 'key id required in path');
  const idx = cfg.providers.findIndex((p) => p.id === id);
  if (idx < 0) return fail(404, `provider '${id}' not found`);
  const row = cfg.providers[idx];
  const keyIdx = (row.apiKeys ?? []).findIndex((k) => k.id === keyId);
  if (keyIdx < 0) return fail(404, `pool key '${keyId}' not found`);

  row.apiKeys![keyIdx].enabled = Boolean(body['enabled']);
  await persistProviders(cfg, deps);
  const cooldown = await deps.apiKeyPool.getKeyHealth(id);
  return ok(200, { keys: toPoolKeyView(row, cooldown, deps) });
}

/**
 * Parse the body's `apiKeys[]` pool (key-pool design D7), reusing the
 * "blank key keeps the stored value" semantics PER pool key id: a submitted
 * entry whose `apiKey` is blank/omitted keeps the matching existing entry's key
 * (matched by `id`). Bad entries (missing id) are skipped. A non-array → keep
 * the existing pool unchanged; an explicit empty array → clear the pool.
 */
function parseApiKeysInput(
  raw: unknown,
  existing: DaemonApiKeyEntry[] | undefined,
): DaemonApiKeyEntry[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((e) => [e.id, e]));
  const out: DaemonApiKeyEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const k = item as Record<string, unknown>;
    const id = typeof k['id'] === 'string' && k['id'].trim() ? k['id'].trim() : '';
    if (!id) continue;
    const prior = byId.get(id);
    const submittedKey = typeof k['apiKey'] === 'string' && k['apiKey'].length > 0 ? k['apiKey'] : '';
    const apiKey = submittedKey || prior?.apiKey || '';
    if (!apiKey) continue; // no key submitted and none stored → drop
    const entry: DaemonApiKeyEntry = { id, apiKey };
    if (typeof k['label'] === 'string' && k['label'].length > 0) entry.label = k['label'];
    else if (prior?.label) entry.label = prior.label;
    if (typeof k['enabled'] === 'boolean') entry.enabled = k['enabled'];
    else if (typeof prior?.enabled === 'boolean') entry.enabled = prior.enabled;
    if (typeof k['weight'] === 'number' && Number.isFinite(k['weight'])) entry.weight = k['weight'];
    else if (typeof prior?.weight === 'number') entry.weight = prior.weight;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the body's `modelConfigs[]` per-model metadata (app-parity child 2),
 * mirroring `parseApiKeysInput`: ARRAY-REPLACE with per-entry prior-id fallback.
 * A non-array → keep the `existing` array unchanged (the caller handles the
 * explicit-`null`-clears contract before calling here). For a submitted entry,
 * the body's fields win; an OMITTED field on a provided entry falls back to the
 * prior same-id entry's value (so metadata the daemon stores but the client did
 * not echo is not silently dropped). Deny-by-default: only the allowlisted
 * allowlisted fields are ever copied; a bad entry (missing id) is skipped. An
 * empty/all-bad array collapses to `undefined` (same as "no metadata").
 */
function parseModelConfigsInput(
  raw: unknown,
  existing: DaemonModelConfig[] | undefined,
): DaemonModelConfig[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((e) => [e.id, e]));
  const out: DaemonModelConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m['id'] === 'string' && m['id'].trim() ? m['id'].trim() : '';
    if (!id) continue;
    const prior = byId.get(id);
    const entry: DaemonModelConfig = { id };
    if (typeof m['name'] === 'string' && m['name'].length > 0) entry.name = m['name'];
    else if (prior?.name) entry.name = prior.name;
    if (typeof m['group'] === 'string' && m['group'].length > 0) entry.group = m['group'];
    else if (prior?.group) entry.group = prior.group;
    if (typeof m['enabled'] === 'boolean') entry.enabled = m['enabled'];
    else if (typeof prior?.enabled === 'boolean') entry.enabled = prior.enabled;
    if (typeof m['vision'] === 'boolean') entry.vision = m['vision'];
    else if (typeof prior?.vision === 'boolean') entry.vision = prior.vision;
    if (typeof m['reasoning'] === 'boolean') entry.reasoning = m['reasoning'];
    else if (typeof prior?.reasoning === 'boolean') entry.reasoning = prior.reasoning;
    const thinkingLevels = validateThinkingLevels(m['thinkingLevels']);
    if (thinkingLevels) entry.thinkingLevels = thinkingLevels;
    else if (prior?.thinkingLevels) entry.thinkingLevels = prior.thinkingLevels;
    const thinkingTokenLimit = validateThinkingTokenLimit(m['thinkingTokenLimit']);
    if (thinkingTokenLimit) entry.thinkingTokenLimit = thinkingTokenLimit;
    else if (prior?.thinkingTokenLimit) entry.thinkingTokenLimit = prior.thinkingTokenLimit;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the body's `transformer` config (app-parity child 5). Mirrors the SAME
 * allowlist as the load guard (`validateTransformer` in config.ts), reusing the
 * shared `validateTransformerEntry` so the two gateways stay LOCKSTEP. On a
 * provided object the BODY WINS (full replace — the app sends the FULL desired
 * `transformer`): keep each well-formed `use[]` entry (non-empty string OR
 * `[string, object]` tuple, drop the rest) + preserve unknown per-model keys
 * VERBATIM only when object/array-shaped (deny-by-default: scalar/garbage at an
 * unknown key is dropped). A non-object → keep `existing`; an empty result
 * collapses to `undefined`. (The caller handles explicit `null` → clear before
 * calling here.) Never throws. NON-SECRET.
 */
function parseTransformerInput(
  raw: unknown,
  existing: DaemonTransformerConfig | undefined,
): DaemonTransformerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return existing;
  const t = raw as Record<string, unknown>;
  const out: DaemonTransformerConfig = {};
  let kept = false;
  if (Array.isArray(t['use'])) {
    const use: DaemonTransformerEntry[] = [];
    for (const item of t['use']) {
      const entry = validateTransformerEntry(item);
      if (entry !== null) use.push(entry);
    }
    if (use.length > 0) {
      out.use = use;
      kept = true;
    }
  }
  for (const key of Object.keys(t)) {
    if (key === 'use') continue;
    const value = t[key];
    if (value && typeof value === 'object') {
      out[key] = value;
      kept = true;
    }
  }
  return kept ? out : undefined;
}

/**
 * Parse a `codingPlan` write body (app-parity-2 child 3). Called ONLY when the
 * body carries a non-null `codingPlan` OBJECT (the null/omit three-way lives in
 * `parseProviderInput`). Deny-by-default allowlist `{enabled,baseUrl,apiKey,note}`.
 * NESTED-SECRET blank-keeps: a non-empty `apiKey` SETS; an empty/absent `apiKey`
 * KEEPS the existing stored coding-plan key (mirrors the main apiKey blank-on-edit,
 * since the masked GET never returns the literal key). `baseUrl`/`note` follow the
 * value/`null`-clear/omit-keep contract. Collapses to undefined when nothing
 * meaningful remains (not enabled + no fields), reading as "no coding-plan".
 */
function parseCodingPlanInput(
  raw: Record<string, unknown>,
  existing: DaemonCodingPlanConfig | undefined,
): DaemonCodingPlanConfig | undefined {
  const enabled = raw['enabled'] === true;
  const baseUrl =
    typeof raw['baseUrl'] === 'string' && raw['baseUrl'].length > 0
      ? (raw['baseUrl'] as string)
      : raw['baseUrl'] === null
        ? undefined
        : existing?.baseUrl;
  // nested-secret blank-keeps: non-empty SETS; empty/absent KEEPS the stored key.
  const apiKey =
    typeof raw['apiKey'] === 'string' && raw['apiKey'].length > 0
      ? (raw['apiKey'] as string)
      : existing?.apiKey;
  const note =
    typeof raw['note'] === 'string' && raw['note'].length > 0
      ? (raw['note'] as string)
      : raw['note'] === null
        ? undefined
        : existing?.note;
  if (!enabled && !baseUrl && !apiKey && !note) return undefined;
  const out: DaemonCodingPlanConfig = { enabled };
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  if (note) out.note = note;
  return out;
}

/**
 * Parse an `apiModes` write body (app-parity-2 child 4). Array-replace via a
 * deny-by-default allowlist `{id,label,baseUrl,apiKey,apiKeyPrefix,note}`, keyed by
 * mode id so each mode's NESTED-SECRET `apiKey` blank-keeps: an empty/absent key
 * keeps the prior stored key for that mode id (the masked view never returns it).
 * An entry missing `id` or `baseUrl` is dropped; a non-array → keep existing.
 */
function parseApiModesInput(
  raw: unknown,
  existing: DaemonApiMode[] | undefined,
): DaemonApiMode[] | undefined {
  if (!Array.isArray(raw)) return existing;
  const byId = new Map((existing ?? []).map((m) => [m.id, m]));
  const out: DaemonApiMode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m['id'] === 'string' && m['id'].trim() ? m['id'].trim() : '';
    const baseUrl = typeof m['baseUrl'] === 'string' && m['baseUrl'].length > 0 ? (m['baseUrl'] as string) : '';
    if (!id || !baseUrl) continue;
    const prior = byId.get(id);
    const label = typeof m['label'] === 'string' && m['label'].length > 0 ? (m['label'] as string) : (prior?.label ?? id);
    const entry: DaemonApiMode = { id, label, baseUrl };
    // nested-secret blank-keeps for the mode key.
    if (typeof m['apiKey'] === 'string' && m['apiKey'].length > 0) entry.apiKey = m['apiKey'];
    else if (prior?.apiKey) entry.apiKey = prior.apiKey;
    const prefix = typeof m['apiKeyPrefix'] === 'string' && m['apiKeyPrefix'].length > 0 ? (m['apiKeyPrefix'] as string) : prior?.apiKeyPrefix;
    if (prefix) entry.apiKeyPrefix = prefix;
    const note = typeof m['note'] === 'string' && m['note'].length > 0 ? (m['note'] as string) : prior?.note;
    if (note) entry.note = note;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate a provider input body. When `existing` is supplied (PUT), a
 * blank/omitted `apiKey`/`id` falls back to the stored value (id is immutable on
 * edit; the key is kept when not re-entered). Returns `null` on a bad shape.
 */
export function parseProviderInput(
  body: Record<string, unknown>,
  existing: DaemonProviderConfig | undefined,
): DaemonProviderConfig | null {
  let logjev = existing?.logjev;
  if (body['logjev'] === null) logjev = undefined;
  else if (body['logjev'] !== undefined) {
    try { logjev = parseLogJevSettings(body['logjev']); }
    catch { return null; }
  }
  // `id` is the IMMUTABLE identity (model refs `"<id>,<model>"`, pool + account
  // keys). On a PUT (existing present) the STORED id ALWAYS wins — a body `id` is
  // ignored, so a mismatched/forged `id` can never silently rename/orphan the row
  // at this slot (the editable display label is the separate `name` field). On a
  // POST (no existing) the body must supply a non-empty `id`.
  const id = existing
    ? existing.id
    : typeof body['id'] === 'string' && body['id'].trim()
      ? body['id'].trim()
      : undefined;
  const apiFormat = body['apiFormat'];
  const baseUrl = body['baseUrl'];
  if (!id) return null;
  // Display name (app-parity-2 child 1): the SAME three-way write contract —
  //   OMIT (key absent)  → keep the stored value;
  //   null               → CLEAR (→ undefined; the app falls back to the id);
  //   non-empty string   → set it.
  const name =
    typeof body['name'] === 'string' && body['name'].length > 0
      ? (body['name'] as string)
      : body['name'] === null
        ? undefined
        : existing?.name;
  if (
    apiFormat !== 'openai' &&
    apiFormat !== 'anthropic' &&
    apiFormat !== 'gemini' &&
    apiFormat !== 'openai-response'
  ) {
    return null;
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  const rawKey = body['apiKey'];
  let apiKey =
    typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : (existing?.apiKey ?? '');
  const models = Array.isArray(body['models'])
    ? (body['models'] as unknown[]).filter((m): m is string => typeof m === 'string')
    : existing?.models;
  // Per-model metadata (app-parity child 2): the same three-way write contract at
  // the ARRAY level — OMIT (key absent) keeps the stored array (no accidental
  // wipe on an unrelated edit); explicit `null` clears it (→ undefined); an array
  // replaces it via the deny-by-default allowlist parse (per-entry prior-id
  // fallback for omitted fields). The app always sends the FULL desired array.
  const modelConfigs =
    body['modelConfigs'] === null
      ? undefined
      : parseModelConfigsInput(body['modelConfigs'], existing?.modelConfigs);
  // Pool keys (key-pool change): edit the row's `apiKeys[]` through the SAME PUT
  // (no new write endpoint, design D7). Absent in the body → keep existing.
  const apiKeys = parseApiKeysInput(body['apiKeys'], existing?.apiKeys);
  // Enable flag (app-foundation D8): a real boolean in the body wins; absent →
  // keep the existing stored value (no accidental re-enable on an unrelated edit).
  const enabled =
    typeof body['enabled'] === 'boolean' ? (body['enabled'] as boolean) : existing?.enabled;
  // Scalar fields (app-parity child 1): deny-by-default (only these allowlisted
  // keys are ever copied) with a uniform three-way write contract per field —
  //   OMIT (key absent)  → keep the existing stored value (no accidental wipe);
  //   null               → CLEAR the stored field (→ undefined);
  //   value (right type) → set it.
  const isOfficial =
    typeof body['isOfficial'] === 'boolean' ? (body['isOfficial'] as boolean) : existing?.isOfficial;
  // Catalog category ('other' = key-storage row for a non-chat tool): the same
  // three-way write contract — 'other' sets, explicit null clears, absent keeps.
  const category =
    body['category'] === 'other'
      ? ('other' as const)
      : body['category'] === null
        ? undefined
        : existing?.category;
  // apiVersion / modelsEndpoint (string): non-empty string sets; explicit `null`
  // clears; absent keeps (the app sends `null`, never `''`, to clear — D4 / OQ2).
  const apiVersion =
    typeof body['apiVersion'] === 'string' && body['apiVersion'].length > 0
      ? (body['apiVersion'] as string)
      : body['apiVersion'] === null
        ? undefined
        : existing?.apiVersion;
  const modelsEndpoint =
    typeof body['modelsEndpoint'] === 'string' && body['modelsEndpoint'].length > 0
      ? (body['modelsEndpoint'] as string)
      : body['modelsEndpoint'] === null
        ? undefined
        : existing?.modelsEndpoint;
  // maxConcurrency (number): a finite number sets; explicit `null` clears; absent keeps.
  const maxConcurrency =
    typeof body['maxConcurrency'] === 'number' && Number.isFinite(body['maxConcurrency'])
      ? (body['maxConcurrency'] as number)
      : body['maxConcurrency'] === null
        ? undefined
        : existing?.maxConcurrency;
  // Static extra headers: the SAME three-way write contract —
  //   OMIT (key absent)  → keep the stored map (no accidental wipe);
  //   null               → CLEAR the stored map (→ undefined);
  //   object             → REPLACE via the load guard's allowlist
  //                        (`validateExtraHeaders` — reserved auth/content names
  //                        dropped, two-gateway lockstep with the load path).
  const extraHeaders =
    body['extraHeaders'] === null
      ? undefined
      : body['extraHeaders'] === undefined
        ? existing?.extraHeaders
        : validateExtraHeaders(body['extraHeaders']);
  // Multi-format fan-out variants: the SAME three-way write contract, guarded
  // by the shared load-edge shape (known wires + http(s) URLs only).
  const formatVariants =
    body['formatVariants'] === null
      ? undefined
      : body['formatVariants'] === undefined
        ? existing?.formatVariants
        : validateFormatVariants(body['formatVariants']);
  // Transformer config (app-parity child 5): the SAME three-way write contract —
  //   OMIT (key absent)  → keep the existing stored value (no accidental wipe);
  //   null               → CLEAR the stored config (→ undefined);
  //   object             → REPLACE via the deny-by-default allowlist parse
  //                        (preserving unknown per-model keys verbatim).
  // PERSISTED-NOT-ENFORCED: stored + round-tripped, but the daemon's transform
  // chain stays apiFormat-keyed (no routing change from a stored transformer).
  const transformer =
    body['transformer'] === null
      ? undefined
      : parseTransformerInput(body['transformer'], existing?.transformer);
  // Coding-plan endpoint (app-parity-2 child 3): the SAME three-way at the object
  // level — `null` clears, omit keeps the stored value, a non-null object merges
  // via `parseCodingPlanInput` (nested-secret blank-keeps for its apiKey). A
  // garbage non-object keeps the stored value (deny-by-default, no wipe).
  const codingPlan =
    body['codingPlan'] === null
      ? undefined
      : body['codingPlan'] === undefined
        ? existing?.codingPlan
        : body['codingPlan'] && typeof body['codingPlan'] === 'object' && !Array.isArray(body['codingPlan'])
          ? parseCodingPlanInput(body['codingPlan'] as Record<string, unknown>, existing?.codingPlan)
          : existing?.codingPlan;
  // API modes (app-parity-2 child 4): array-replace via the allowlist (nested-secret
  // blank-keeps per mode); `null` clears; omit keeps. selectedApiModeId: value sets,
  // `null` clears, omit keeps.
  const apiModes =
    body['apiModes'] === null ? undefined : parseApiModesInput(body['apiModes'], existing?.apiModes);
  const selectedApiModeId =
    typeof body['selectedApiModeId'] === 'string' && body['selectedApiModeId'].length > 0
      ? (body['selectedApiModeId'] as string)
      : body['selectedApiModeId'] === null
        ? undefined
        : existing?.selectedApiModeId;
  // Server-side mode-key sync on a SWITCH (app-parity-2 child 4): the app syncs the
  // selected mode's baseUrl app-side (non-secret) but CANNOT sync the mode's key
  // (masked). So when this PUT switches `selectedApiModeId` (changed vs stored),
  // passes NO explicit `apiKey`, AND the body's `baseUrl` EQUALS the selected mode's
  // baseUrl (a NORMAL switch — "keep customizations" sends the current/custom URL,
  // which won't match), adopt the selected mode's stored key (if it has one) —
  // server-side, where the real decrypted key lives. The baseUrl-match discriminator
  // preserves keepCustomizations (custom URL ≠ mode URL → key untouched).
  if (
    typeof body['selectedApiModeId'] === 'string' &&
    body['selectedApiModeId'].length > 0 &&
    body['selectedApiModeId'] !== existing?.selectedApiModeId &&
    !(typeof rawKey === 'string' && rawKey.length > 0)
  ) {
    const mode = apiModes?.find((m) => m.id === selectedApiModeId);
    if (mode?.apiKey && typeof body['baseUrl'] === 'string' && body['baseUrl'] === mode.baseUrl) {
      apiKey = mode.apiKey;
    }
  }
  // Two-gateway lockstep with the load guard: normalize onto the format axis so a
  // body still using the legacy shape (apiFormat:'openai' + use:['openai-response'])
  // is stored the same way `loadConfig` would store it — exactly one provider-slot
  // encoder, named by apiFormat, with `use[]` left as pure modifiers.
  const migrated = migrateFormatAxis(apiFormat, transformer);
  return {
    id,
    name,
    apiFormat: migrated.apiFormat,
    baseUrl: baseUrl.trim(),
    apiKey,
    models,
    modelConfigs,
    apiKeys,
    enabled,
    category,
    isOfficial,
    apiVersion,
    maxConcurrency,
    modelsEndpoint,
    extraHeaders,
    formatVariants,
    transformer: migrated.transformer,
    logjev,
    codingPlan,
    apiModes,
    selectedApiModeId,
  };
}

// ── Presets (read-only catalog projection; no secrets) ────────────────────────

/**
 * `GET /admin/api/presets` → the curated catalog projected to a minimal
 * whitelist DTO for the dashboard's preset picker. Presets carry NO apiKey, but
 * DTO discipline still holds: only the keys listed below are projected — the
 * full `PresetProviderTemplate` (transformer/searchConfig/apiModes/…) is NEVER
 * serialized. `apiFormat` is the NARROWED daemon format (google→gemini), so a
 * picked preset validates against the provider write path unchanged.
 *
 * The presentation fields (`nameKey`/`icon`/`description`/`features`/`website`)
 * are non-secret catalog metadata the template picker renders on each card —
 * `nameKey` so a Chinese-named built-in renders translated, the rest for the
 * card's icon / blurb / capability tags. `modelsEndpoint` rides along because a
 * preset-prefilled provider needs it to discover models. All are OPTIONAL: a
 * preset that declares none serializes exactly the prior six keys.
 */
export function listPresets(): ServiceResult {
  const { mappable, excluded } = listMappablePresets();
  const presets = mappable.map((p) => ({
    id: p.id,
    presetId: p.presetId,
    name: p.name,
    apiFormat: p.apiFormat,
    baseUrl: p.baseUrl,
    models: p.models,
    nameKey: p.nameKey,
    category: p.category,
    icon: p.icon,
    description: p.description,
    features: p.features,
    website: p.website,
    modelsEndpoint: p.modelsEndpoint,
    // Static extra headers ride along so `addFromPreset` can seed them onto the
    // row (the write gateway re-validates via the shared allowlist).
    extraHeaders: p.extraHeaders,
    // Fan-out variants ride along for the same reason (multi-format providers
    // seed their extra-wire base URLs onto the row).
    formatVariants: p.formatVariants,
    logjev: p.logjev,
  }));
  return ok(200, { presets, excluded });
}
