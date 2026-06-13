/**
 * config.ts — the daemon's `config.json` schema + load/save (design D9).
 *
 * The daemon is BYO-key and factory-less: its `config.json` provider rows ARE
 * the provider catalog the `ConfigFileProviderConfigSource` serves. The `server`
 * field is the same `OutboundApiServerConfig` shape `loadServerConfig`
 * normalizes (persisted via `JsonApiServerSettingsStore` under the single
 * `'outboundApiServer.config'` key).
 *
 * `loadConfig(path)` reads + shape-guards; `saveConfig(path, cfg)` writes pretty
 * JSON. The loader is defensive (best-effort, never throws on a partial file) so
 * the CLI surfaces a clear error rather than a stack trace.
 *
 * AT-REST ENCRYPTION (secrets design D5/D7): a MODULE-LEVEL `SecretBox` is
 * injected via `setSecretBox` (by bootstrap + each offline CLI command). When
 * set, `loadConfig` decrypts the secret fields (`apiKey`/`apiKeys[].apiKey`/
 * `admin.token`) AFTER the shape-guard (envelopes are strings → shape-guard
 * passes), and `saveConfig` encrypts them before writing. When NOT set (box =
 * null), both are a no-op passthrough — so the existing pure tests that call
 * `loadConfig`/`saveConfig`/`validateConfig` without a box are byte-unchanged.
 * `$ENV` references are never encrypted (the box's tri-state passthrough).
 *
 * @module @omnicross/daemon/config
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { OutboundApiServerConfig } from '@omnicross/core';

import { decryptConfigSecrets, encryptConfigSecrets, type SecretBox } from './secrets';

/** The wire formats the daemon's BYO providers can speak. */
export type DaemonApiFormat = 'openai' | 'anthropic' | 'gemini';

/**
 * One pool key on a provider row (design D1). Structurally compatible with
 * core's `ApiKeyEntry` (`@omnicross/contracts/llm-config`) — a hand-authored SUBSET: only
 * `id` + `apiKey` are required, the rest carry sensible defaults applied at
 * load time (`pool/loadPoolKeys.ts` normalizes a `DaemonApiKeyEntry` up to the
 * full `ApiKeyEntry` core consumes, filling `providerId`/`label`/`weight`/
 * `enabled`/`sortOrder`). config.json should not have to hand-write core's
 * DB/UI fields (`providerId`/`sortOrder`/`hasKey`/`disabledReason`/…).
 */
export interface DaemonApiKeyEntry {
  /** Stable id — the pool's selection / cooldown / auto-disable key. */
  id: string;
  /** The BYO key (literal, or a `$ENV_VAR` reference resolved at call time). */
  apiKey: string;
  /** Display name (defaults to `id`). */
  label?: string;
  /** Whether this key is selectable (defaults to `true`). */
  enabled?: boolean;
  /** Weighted round-robin weight (defaults to `1`). */
  weight?: number;
}

/**
 * Per-model metadata subset (app-parity child 2). A hand-authored SUBSET of the
 * app's `ModelConfig` (`app/src/shared-types/llm-config.ts`), carrying ONLY the
 * named-five fields the daemon stores + round-trips, keyed by the model `id`:
 * `name` (display name), `enabled`, `group`, `vision`, `reasoning`. The wider
 * `ModelConfig` fields the discovery flow may send (`category`/`contextLength`/
 * `maxTokens`/`functionCall`/`webSearch`/`completionSettings`/`openRouterProvider`/
 * `thinkingLevels`/…) are NOT in this allowlist — they are DROPPED by
 * deny-by-default (`validateModelConfigs`/`parseModelConfigsInput`).
 *
 * ENFORCEMENT (app-parity-2 child 2): `enabled` is now a DISCOVERY/advertisement
 * gate — `toLLMProvider` drops a `enabled: false` model from the routed provider's
 * `models[]`, so the served catalog no longer lists it. HONEST SCOPE: this gates
 * advertisement, NOT a hard per-request block (core does not validate a requested
 * model against `models[]`, so a hardcoded disabled model id still reaches the
 * upstream, which rejects it). The admin management view (`toProviderView`) still
 * lists ALL models. The other fields (`name`/`group`/`vision`/`reasoning`) remain
 * display-only metadata (no core per-model capability binding on the BYO path).
 */
export interface DaemonModelConfig {
  /** Model id — the metadata key (parallels an entry in the flat `models[]`). */
  id: string;
  /** Display name (display/management only; not consumed by routing). */
  name?: string;
  /** Enable flag — DISCOVERY GATE (parity-2 child 2): `false` drops the model from
   *  the routed/advertised catalog; not a hard per-request block. */
  enabled?: boolean;
  /** Display group label (app derives groups from this — no separate daemon array). */
  group?: string;
  /** Vision-capable hint (display only; not consumed by routing). */
  vision?: boolean;
  /** Reasoning-capable hint (display only; not consumed by routing). */
  reasoning?: boolean;
}

/**
 * One transformer chain entry (app-parity child 5). Mirrors the app's
 * `TransformerEntry`: either a bare transform-rule NAME (`string`), or a
 * `[name, options]` tuple carrying that rule's options. NON-SECRET (rule names +
 * options — no key material).
 */
export type DaemonTransformerEntry = string | [string, Record<string, unknown>];

/**
 * Provider transformer config subset (app-parity child 5). Mirrors the app's
 * `TransformerConfig` PROVIDER-LEVEL portion: `use[]` is the provider-level
 * transform chain. The index signature preserves any per-model transformer keys
 * (`[modelName]`) VERBATIM as an opaque value so a round-trip is non-lossy — the
 * minimal editor only edits `use[]`, but stored per-model keys are not dropped.
 *
 * ENFORCED (app-parity-2 child 2): the daemon APPLIES this `use[]` chain in the
 * request pipeline. `ConfigFileProviderConfigSource.resolveTransformerChain`
 * resolves the custom `use[]` into the provider chain, composed FORMAT-FIRST — the
 * format transformer (anthropic/gemini, supplied by `getMainTransformer` and
 * prepended by core's `resolveProviderChain`) runs before the custom transformers,
 * preserving the load-bearing wire-format conversion. An unknown transformer name
 * is warned + skipped (lenient). Additive + back-compat: absent (or empty `use[]`)
 * reads as undefined and resolves to the format transformer alone — byte-identical
 * to before. NON-SECRET — round-trips verbatim on GET (no masking).
 */
export interface DaemonTransformerConfig {
  /** Provider-level transform chain (the UI count + the minimal editor surface). */
  use?: DaemonTransformerEntry[];
  /** Per-model transformer keys preserved verbatim (opaque — not edited here). */
  [modelName: string]: unknown;
}

/**
 * Coding-plan endpoint config (app-parity-2 child 3). The provider's "coding-plan"
 * subscription endpoint (e.g. domestic providers' 编程套餐 — Zhipu GLM Coding Plan,
 * DashScope, DeepSeek, Kimi …): an OPTIONAL alternate endpoint with its OWN
 * `baseUrl` + `apiKey`, distinct from the pay-as-you-go API key. Structurally
 * identical to the contracts `CodingPlanConfig` (`@omnicross/contracts/provider-presets`)
 * so a daemon row's `codingPlan` assigns straight onto `LLMProvider.codingPlan`.
 *
 * SECRET-BEARING: `apiKey` is encrypted at rest (registered in
 * `secretFields.transformProvider`) and NEVER serialized back out — the masked GET
 * view returns only a `hasApiKey` boolean.
 *
 * ENFORCED BY CORE, NOT THE DAEMON: the daemon does NOT contain its own endpoint
 * resolver. It only POPULATES `LLMProvider.codingPlan` in `toLLMProvider`; the
 * shared `resolveProviderEndpoint` (`@omnicross/contracts/endpoint-resolver`, layer
 * 2: `apiModes > codingPlan > plain`) — already wired into core's `buildProviderApiUrl`
 * (URL) and the BYO proxy key path — does the actual routing (when `enabled` AND a
 * `baseUrl` is set, the request uses this `baseUrl` + `apiKey`, key falling back to
 * the provider's main key when empty). Additive + back-compat: absent → undefined.
 */
export interface DaemonCodingPlanConfig {
  /** Whether the coding-plan endpoint is active (core routes via baseUrl/apiKey below). */
  enabled: boolean;
  /** Dedicated base URL — when set AND enabled, core overrides the provider's baseUrl. */
  baseUrl?: string;
  /** Dedicated key (SECRET; literal or `$ENV`). Empty → core falls back to the main key. */
  apiKey?: string;
  /** Free-text plan note (display/management only). */
  note?: string;
}

/**
 * One API mode (app-parity-2 child 4). The provider's selectable endpoint "mode"
 * (e.g. `standard` / `coding-plan` / `token-plan` for domestic providers): each
 * carries its own `baseUrl` + an OPTIONAL `apiKey`. Structurally identical to the
 * contracts `ApiMode` so a daemon row's `apiModes` assigns straight onto
 * `LLMProvider.apiModes`. SECRET-BEARING: `apiKey` is encrypted at rest
 * (`secretFields`) + masked on GET (`hasApiKey` only) — never serialized out.
 * ENFORCED BY CORE: `toLLMProvider` populates `apiModes`/`selectedApiModeId`; the
 * shared `resolveProviderEndpoint` (layer 1) reports `source:'api-mode'` and uses
 * `api_base_url || mode.baseUrl`. The row's `baseUrl`/`apiKey` hold the EFFECTIVE
 * endpoint (synced on switch — baseUrl app-side, the secret key server-side).
 */
export interface DaemonApiMode {
  /** Stable mode id within the provider. */
  id: string;
  /** i18n key or display label. */
  label: string;
  /** This mode's endpoint base URL. */
  baseUrl: string;
  /** This mode's OPTIONAL key (SECRET; literal or `$ENV`). */
  apiKey?: string;
  /** Optional API-key prefix hint (e.g. `sk-tp-`). Non-secret. */
  apiKeyPrefix?: string;
  /** Optional note (i18n key). Non-secret. */
  note?: string;
}

/** One BYO provider row — the unit the `ProviderConfigSource` serves. */
export interface DaemonProviderConfig {
  /** Stable id referenced by the per-endpoint `"<id>,<model>"` model refs. */
  id: string;
  /**
   * OPTIONAL mutable display name (app-parity-2 child 1), SEPARATE from the
   * immutable `id`. The `id` stays the identity key (model refs, pool, accounts);
   * `name` is a free-text label the rename UI edits. Additive + back-compat:
   * absent reads as undefined and the app falls back to displaying the `id`.
   * NON-SECRET — round-trips verbatim on GET (no masking).
   */
  name?: string;
  /** The provider's wire format (drives the transformer chain). */
  apiFormat: DaemonApiFormat;
  /** The upstream base URL (e.g. `https://api.openai.com/v1`). */
  baseUrl: string;
  /** The BYO API key (literal, or a `$ENV_VAR` reference resolved at call time). */
  apiKey: string;
  /** Optional advertised model list (informational; routing uses the model ref). */
  models?: string[];
  /**
   * OPTIONAL per-model metadata (app-parity child 2), keyed by model id, PARALLEL
   * to the flat `models[]`. Additive + back-compat: a row with only `models[]`
   * (no `modelConfigs`) loads unchanged and reads as undefined metadata; the flat
   * `models[]` stays AUTHORITATIVE for the model catalog. ENFORCEMENT (parity-2
   * child 2): `enabled` is a DISCOVERY GATE — `toLLMProvider` drops a
   * `enabled: false` model from the routed `models[]` (advertisement-scoped, not a
   * hard per-request block; the admin view still lists all). `name`/`group`/
   * `vision`/`reasoning` stay display-only. Group lives here as `modelConfigs[].group`
   * (no separate daemon `modelGroups[]`). None of the fields are secrets — verbatim on GET.
   */
  modelConfigs?: DaemonModelConfig[];
  /**
   * OPTIONAL multi-key pool (design D1, key-pool change). When present, the
   * `ApiKeyPoolService` loads these for observable health + (future) failover.
   * **Absent `apiKeys` = single-key behavior byte-identical to before** — the
   * pool synthesizes a 1-key pool from `apiKey` and the outbound take-key path
   * is unchanged. The single `apiKey` field is RETAINED as the fallback.
   */
  apiKeys?: DaemonApiKeyEntry[];
  /**
   * OPTIONAL enable flag (app-foundation D8). When absent, the provider reads as
   * ENABLED (back-compat: existing `config.json` rows with no `enabled` field are
   * treated as enabled). Surfaced on the admin GET DTO (`enabled: row.enabled !==
   * false`) and accepted by the provider write path (PUT). Purely a management-UI
   * concern — the routing/outbound paths do not consume it yet.
   */
  enabled?: boolean;
  /**
   * OPTIONAL "official provider" management flag (app-parity child 1). Additive +
   * back-compat: absent reads as the prior default (undefined). NON-SECRET —
   * round-trips verbatim on GET (no masking). Management-UI only; the
   * routing/outbound paths do not consume it.
   */
  isOfficial?: boolean;
  /**
   * OPTIONAL API version (e.g. an Azure `api-version`) (app-parity child 1).
   * Additive + back-compat: absent reads as the prior default (undefined).
   * NON-SECRET — round-trips verbatim on GET. Management-UI only (not yet consumed
   * by the outbound path).
   */
  apiVersion?: string;
  /**
   * OPTIONAL max-concurrency hint (app-parity child 1). Additive + back-compat:
   * absent reads as the prior default (undefined). NON-SECRET — round-trips
   * verbatim on GET. Management-UI only (not yet enforced by the routing path).
   */
  maxConcurrency?: number;
  /**
   * OPTIONAL custom models endpoint URL (app-parity child 1). Additive +
   * back-compat: absent reads as the prior default (undefined). NON-SECRET —
   * round-trips verbatim on GET. Management-UI only.
   */
  modelsEndpoint?: string;
  /**
   * OPTIONAL provider transformer config (app-parity child 5). Additive +
   * back-compat: absent reads as the prior default (undefined). NON-SECRET —
   * round-trips verbatim on GET (no masking). ENFORCED (parity-2 child 2): the
   * daemon APPLIES the custom `use[]` chain in the request pipeline, FORMAT-FIRST
   * (see `DaemonTransformerConfig`); absent/empty resolves to the format
   * transformer alone (byte-identical to before).
   */
  transformer?: DaemonTransformerConfig;
  /**
   * OPTIONAL coding-plan endpoint (app-parity-2 child 3). SECRET-BEARING (its
   * `apiKey` is encrypted at rest + masked on GET). Populated onto
   * `LLMProvider.codingPlan` by `toLLMProvider`; ENFORCED by core's shared
   * `resolveProviderEndpoint` (the daemon does not resolve endpoints itself).
   * Additive + back-compat: absent reads as undefined.
   */
  codingPlan?: DaemonCodingPlanConfig;
  /**
   * OPTIONAL API modes (app-parity-2 child 4) — selectable endpoint modes. Each
   * mode's `apiKey` is SECRET (encrypted at rest, masked on GET). Populated onto
   * `LLMProvider.apiModes` by `toLLMProvider`; the SELECTED mode drives core's
   * `resolveProviderEndpoint` (layer 1). Additive + back-compat: absent → undefined.
   */
  apiModes?: DaemonApiMode[];
  /** OPTIONAL id of the active API mode (app-parity-2 child 4). */
  selectedApiModeId?: string;
}

/**
 * The admin-dashboard config block (RT3 design D8). All fields optional;
 * defaults are applied at read time by `resolveAdminConfig`.
 *
 * SECURITY: `token` is a SEPARATE secret (NOT a named outbound key). It is never
 * serialized back out by any management-API GET — the masking spine treats it
 * like every other secret (in, never out).
 */
export interface DaemonAdminConfig {
  /** Dashboard on by default; `false` opts out (same as `--no-dashboard`). */
  enabled?: boolean;
  /** Admin server port (default 8766; distinct from the 8765 outbound server). */
  port?: number;
  /** Bind `0.0.0.0` (LAN) instead of `127.0.0.1`. Requires `token` (fail-closed). */
  networkBinding?: boolean;
  /** Optional bearer secret; when set every `/admin/*` request must carry it. */
  token?: string;
}

/** Resolved admin config with defaults applied (read-time view). */
export interface ResolvedAdminConfig {
  enabled: boolean;
  port: number;
  networkBinding: boolean;
  token: string | undefined;
}

/** The default admin port (distinct from the 8765 outbound server). */
export const DEFAULT_ADMIN_PORT = 8766;

/** The full daemon config. */
export interface DaemonConfig {
  providers: DaemonProviderConfig[];
  /** Persisted outbound-API server config (same shape `loadServerConfig` normalizes). */
  server?: OutboundApiServerConfig;
  /** Optional admin-dashboard config (RT3). */
  admin?: DaemonAdminConfig;
}

/** Shape-guard the optional `admin` block — defensive, never throws on a
 *  partial/missing value (an empty/garbage `admin` collapses to `undefined`). */
function validateAdmin(raw: unknown): DaemonAdminConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  const out: DaemonAdminConfig = {};
  if (typeof a['enabled'] === 'boolean') out.enabled = a['enabled'];
  if (typeof a['port'] === 'number' && Number.isFinite(a['port'])) out.port = a['port'];
  if (typeof a['networkBinding'] === 'boolean') out.networkBinding = a['networkBinding'];
  if (typeof a['token'] === 'string' && a['token'].length > 0) out.token = a['token'];
  return out;
}

/** Apply defaults to a (possibly absent) admin block: enabled, port 8766,
 *  loopback, no token. NOTE: an EXPLICIT `port: 0` is honored as "bind an
 *  ephemeral port" (it is NOT coerced to the default); only an absent/undefined
 *  port falls back to `DEFAULT_ADMIN_PORT`. */
export function resolveAdminConfig(admin: DaemonAdminConfig | undefined): ResolvedAdminConfig {
  return {
    enabled: admin?.enabled !== false,
    port: typeof admin?.port === 'number' ? admin.port : DEFAULT_ADMIN_PORT,
    networkBinding: admin?.networkBinding === true,
    token: typeof admin?.token === 'string' && admin.token.length > 0 ? admin.token : undefined,
  };
}

const VALID_FORMATS: readonly DaemonApiFormat[] = ['openai', 'anthropic', 'gemini'];

/**
 * Shape-guard the optional `apiKeys` pool array (design D1). Mirrors the
 * `models` filtering style: a non-array collapses to `undefined`; each entry
 * MUST carry a non-empty string `id` + `apiKey`, with `enabled`/`weight`/`label`
 * type-coerced to their defaults; a bad entry is SKIPPED (never throws). An
 * empty/all-bad array also collapses to `undefined` so the single-key fallback
 * path stays byte-identical to today.
 */
function validateApiKeys(raw: unknown): DaemonApiKeyEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DaemonApiKeyEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const k = item as Record<string, unknown>;
    const id = k['id'];
    const apiKey = k['apiKey'];
    if (typeof id !== 'string' || !id.trim()) continue;
    if (typeof apiKey !== 'string' || apiKey.length === 0) continue;
    const entry: DaemonApiKeyEntry = { id, apiKey };
    if (typeof k['label'] === 'string' && k['label'].length > 0) entry.label = k['label'];
    if (typeof k['enabled'] === 'boolean') entry.enabled = k['enabled'];
    if (typeof k['weight'] === 'number' && Number.isFinite(k['weight'])) entry.weight = k['weight'];
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Shape-guard the optional `modelConfigs` array (app-parity child 2). Mirrors
 * `validateApiKeys` EXACTLY: a non-array collapses to `undefined`; each entry
 * MUST carry a non-empty string `id` (skip a bad entry — never throws); only the
 * named-five allowlisted fields are copied (`name`/`group` = non-empty-string-or-
 * omit, `enabled`/`vision`/`reasoning` = boolean-or-omit) — deny-by-default drops
 * anything else; an empty/all-bad array also collapses to `undefined` so a row
 * with only flat `models[]` reads byte-identical to today (no metadata).
 */
function validateModelConfigs(raw: unknown): DaemonModelConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DaemonModelConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = m['id'];
    if (typeof id !== 'string' || !id.trim()) continue;
    const entry: DaemonModelConfig = { id };
    if (typeof m['name'] === 'string' && m['name'].length > 0) entry.name = m['name'];
    if (typeof m['group'] === 'string' && m['group'].length > 0) entry.group = m['group'];
    if (typeof m['enabled'] === 'boolean') entry.enabled = m['enabled'];
    if (typeof m['vision'] === 'boolean') entry.vision = m['vision'];
    if (typeof m['reasoning'] === 'boolean') entry.reasoning = m['reasoning'];
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Shape-guard ONE transformer `use[]` entry (app-parity child 5). An entry is
 * well-formed iff it is a NON-EMPTY string, OR a `[string, object]` tuple
 * (a non-empty string name + an options object). Anything else → null (dropped).
 * Exported so the admin write gateway (`parseTransformerInput`) reuses the SAME
 * allowlist as the load guard (the two-gateway lockstep invariant).
 */
export function validateTransformerEntry(item: unknown): DaemonTransformerEntry | null {
  if (typeof item === 'string') return item.length > 0 ? item : null;
  if (Array.isArray(item) && item.length === 2) {
    const [name, opts] = item as [unknown, unknown];
    if (typeof name === 'string' && name.length > 0 && opts && typeof opts === 'object' && !Array.isArray(opts)) {
      return [name, opts as Record<string, unknown>];
    }
  }
  return null;
}

/**
 * Shape-guard the optional `transformer` config (app-parity child 5). Mirrors
 * `validateApiKeys`/`validateModelConfigs`:
 * - a non-object (or array) → `undefined`.
 * - `use`: when an array, keep each well-formed entry (non-empty string OR
 *   `[string, object]` tuple) and DROP the rest; a non-array `use` → omit `use`.
 * - extra (per-model) keys are PRESERVED VERBATIM only when object/array-shaped
 *   (deny-by-default: a scalar/garbage value at an unknown key is DROPPED).
 * - an EMPTY result (`{ use: [] }` with nothing else, or all-bad) collapses to
 *   `undefined` — reads as "no transformer", byte-identical to absent (back-compat).
 * Never throws. NON-SECRET.
 */
function validateTransformer(raw: unknown): DaemonTransformerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
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
    // Preserve per-model keys verbatim ONLY when object/array-shaped (deny-by-
    // default: scalar/garbage at an unknown key is dropped).
    if (value && typeof value === 'object') {
      out[key] = value;
      kept = true;
    }
  }
  return kept ? out : undefined;
}

/**
 * Shape-guard the optional `codingPlan` (app-parity-2 child 3). A non-object (or
 * array) → undefined. `enabled` is a strict boolean (defaults false); `baseUrl`/
 * `apiKey`/`note` are non-empty-string-or-omit. An all-empty result (not enabled,
 * no fields) collapses to undefined (back-compat: reads as absent). Never throws.
 * NOTE: `apiKey` here may be a literal, a `$ENV` ref, OR an `enc:` envelope at
 * LOAD time (validate runs before `decryptConfigSecrets`) — any non-empty string
 * is accepted; the box decrypts it afterwards (same as the main `apiKey`).
 */
function validateCodingPlan(raw: unknown): DaemonCodingPlanConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const enabled = c['enabled'] === true;
  const baseUrl =
    typeof c['baseUrl'] === 'string' && c['baseUrl'].length > 0 ? (c['baseUrl'] as string) : undefined;
  const apiKey =
    typeof c['apiKey'] === 'string' && c['apiKey'].length > 0 ? (c['apiKey'] as string) : undefined;
  const note =
    typeof c['note'] === 'string' && c['note'].length > 0 ? (c['note'] as string) : undefined;
  if (!enabled && !baseUrl && !apiKey && !note) return undefined;
  const out: DaemonCodingPlanConfig = { enabled };
  if (baseUrl) out.baseUrl = baseUrl;
  if (apiKey) out.apiKey = apiKey;
  if (note) out.note = note;
  return out;
}

/**
 * Shape-guard the optional `apiModes` array (app-parity-2 child 4). A non-array →
 * undefined. Each entry MUST carry a non-empty `id` AND `baseUrl` (skip otherwise);
 * `label` defaults to the id; `apiKey`/`apiKeyPrefix`/`note` are non-empty-or-omit.
 * An empty/all-bad array collapses to undefined (back-compat). Never throws. NOTE:
 * `apiKey` may be a literal / `$ENV` / `enc:` envelope at load time (validate runs
 * before decrypt) — any non-empty string is accepted; the box decrypts afterwards.
 */
function validateApiModes(raw: unknown): DaemonApiMode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DaemonApiMode[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = typeof m['id'] === 'string' && m['id'].trim() ? m['id'].trim() : '';
    const baseUrl = typeof m['baseUrl'] === 'string' && m['baseUrl'].length > 0 ? (m['baseUrl'] as string) : '';
    if (!id || !baseUrl) continue;
    const label = typeof m['label'] === 'string' && m['label'].length > 0 ? (m['label'] as string) : id;
    const entry: DaemonApiMode = { id, label, baseUrl };
    if (typeof m['apiKey'] === 'string' && m['apiKey'].length > 0) entry.apiKey = m['apiKey'];
    if (typeof m['apiKeyPrefix'] === 'string' && m['apiKeyPrefix'].length > 0) entry.apiKeyPrefix = m['apiKeyPrefix'];
    if (typeof m['note'] === 'string' && m['note'].length > 0) entry.note = m['note'];
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** Shape-guard one provider row, throwing a clear error on a malformed entry. */
function validateProvider(raw: unknown, index: number): DaemonProviderConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`config: providers[${index}] is not an object`);
  }
  const p = raw as Record<string, unknown>;
  const id = p['id'];
  const apiFormat = p['apiFormat'];
  const baseUrl = p['baseUrl'];
  const apiKey = p['apiKey'];
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`config: providers[${index}].id is required`);
  }
  if (typeof apiFormat !== 'string' || !VALID_FORMATS.includes(apiFormat as DaemonApiFormat)) {
    throw new Error(
      `config: providers[${index}].apiFormat must be one of ${VALID_FORMATS.join(', ')}`,
    );
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error(`config: providers[${index}].baseUrl is required`);
  }
  if (typeof apiKey !== 'string') {
    throw new Error(`config: providers[${index}].apiKey is required`);
  }
  const models = p['models'];
  // Optional display name (app-parity-2 child 1): non-empty string or undefined
  // (collapse-to-undefined guard, never throws). Mutable; separate from `id`.
  const name =
    typeof p['name'] === 'string' && p['name'].length > 0 ? (p['name'] as string) : undefined;
  // Optional enable flag (app-foundation D8): only a real boolean is carried;
  // anything else (absent/garbage) collapses to `undefined` → read as enabled.
  const enabled = typeof p['enabled'] === 'boolean' ? (p['enabled'] as boolean) : undefined;
  // Optional scalar fields (app-parity child 1): collapse-to-undefined guards,
  // never throw on a bad/absent value (mirrors `models`/`enabled`). Non-secret.
  const isOfficial = typeof p['isOfficial'] === 'boolean' ? (p['isOfficial'] as boolean) : undefined;
  const apiVersion =
    typeof p['apiVersion'] === 'string' && p['apiVersion'].length > 0
      ? (p['apiVersion'] as string)
      : undefined;
  const maxConcurrency =
    typeof p['maxConcurrency'] === 'number' && Number.isFinite(p['maxConcurrency'])
      ? (p['maxConcurrency'] as number)
      : undefined;
  const modelsEndpoint =
    typeof p['modelsEndpoint'] === 'string' && p['modelsEndpoint'].length > 0
      ? (p['modelsEndpoint'] as string)
      : undefined;
  return {
    id,
    name,
    apiFormat: apiFormat as DaemonApiFormat,
    baseUrl,
    apiKey,
    models: Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : undefined,
    // Per-model metadata (app-parity child 2): load-guard, collapse-to-undefined.
    modelConfigs: validateModelConfigs(p['modelConfigs']),
    apiKeys: validateApiKeys(p['apiKeys']),
    enabled,
    isOfficial,
    apiVersion,
    maxConcurrency,
    modelsEndpoint,
    // Provider transformer config (app-parity child 5): load-guard, collapse-to-
    // undefined; non-secret; ENFORCED via resolveTransformerChain (parity-2 child 2).
    transformer: validateTransformer(p['transformer']),
    // Coding-plan endpoint (app-parity-2 child 3): load-guard, collapse-to-undefined.
    // SECRET-bearing (apiKey encrypted at rest); enforced by core's resolveProviderEndpoint.
    codingPlan: validateCodingPlan(p['codingPlan']),
    // API modes (app-parity-2 child 4): load-guard, collapse-to-undefined. Each
    // mode's apiKey is SECRET (encrypted at rest); enforced by core (layer 1).
    apiModes: validateApiModes(p['apiModes']),
    selectedApiModeId:
      typeof p['selectedApiModeId'] === 'string' && p['selectedApiModeId'].length > 0
        ? (p['selectedApiModeId'] as string)
        : undefined,
  };
}

/** Validate a parsed config object into a typed `DaemonConfig`. */
export function validateConfig(raw: unknown): DaemonConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config: top-level value must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const providersRaw = obj['providers'];
  if (!Array.isArray(providersRaw)) {
    throw new Error("config: 'providers' must be an array");
  }
  const providers = providersRaw.map((p, i) => validateProvider(p, i));
  const server = obj['server'] as OutboundApiServerConfig | undefined;
  const admin = validateAdmin(obj['admin']);
  return { providers, server, admin };
}

/**
 * Module-level at-rest `SecretBox` (secrets design D7). `null` ⇒ load/save do
 * NO encryption (passthrough) — the legacy/pure behavior. bootstrap + each
 * offline CLI command set it at entry; tests may set it explicitly + reset to
 * `null` in `afterEach`.
 */
let secretBox: SecretBox | null = null;

/** Inject (or clear, with `null`) the module-level at-rest `SecretBox`. */
export function setSecretBox(box: SecretBox | null): void {
  secretBox = box;
}

/** Read + validate the config.json at `path`. When a `SecretBox` is set, the
 *  secret fields are decrypted AFTER shape-guarding (envelopes are strings, so
 *  the guard passes); the returned config carries DECRYPTED values. */
export function loadConfig(path: string): DaemonConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`config: cannot read file at '${path}'`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`config: '${path}' is not valid JSON`);
  }
  const validated = validateConfig(parsed);
  return secretBox ? decryptConfigSecrets(validated, secretBox) : validated;
}

/** Write `cfg` to `path` as pretty JSON. When a `SecretBox` is set, the secret
 *  fields are encrypted-on-write (legacy plaintext → `enc:v1:`; `$ENV`/already-
 *  `enc:` untouched) before serializing. */
export function saveConfig(path: string, cfg: DaemonConfig): void {
  const toWrite = secretBox ? encryptConfigSecrets(cfg, secretBox) : cfg;
  writeFileSync(path, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
}
