/**
 * llmConfigAdapter.ts — the daemon ⇄ `LLMProvider` adapter (design D4/D5).
 *
 * Maps the daemon's thin provider DTO to the Provider page's rich `LLMProvider`
 * shape and back. Implements only the LLM-config methods the page calls.
 *
 * Field mapping (page → daemon), per design D4:
 *   - id/baseUrl/models       → direct
 *   - apiFormat               → daemon gemini ⇄ UI google
 *   - api_key (write-only)    → blank-on-edit keeps the stored key
 *   - hasKey                  ← hasApiKey
 *   - enabled                 ← enabled (D8 field; absent = enabled)
 *   - name                    ⇄ mutable display name (app-parity-2 child 1); on
 *                               read falls back to id when the daemon has none
 *   - everything else         → omitted on read/write (rendered disabled-with-tooltip)
 *
 * Secret discipline: the daemon never returns a literal key; the adapter never
 * treats `apiKeyMasked` as a real key and never sends a masked value back.
 */

import type {
  ApiFormat,
  ApiKeyEntry,
  ApiKeyEntryInput,
  KeyHealthMap,
  LLMProvider,
  LLMProviderInput,
  LLMProviderResult,
  LLMProviderUpdateInput,
  ProviderModelDiscoveryEntry,
  ProviderModelDiscoveryResult,
} from '@shared/llm-config';

import { adminClient, AdminApiError } from './adminClient';
import type {
  AgentLLMConfigApi,
  DaemonDiscoverResponse,
  DaemonPoolKeyView,
  DaemonPresetView,
  DaemonProviderView,
  ModelTestResult,
} from './types';

type DaemonFormat = 'openai' | 'anthropic' | 'gemini';

/** daemon `gemini` → UI `google`; openai/anthropic pass through. */
function toUiFormat(fmt: DaemonFormat): ApiFormat {
  return fmt === 'gemini' ? 'google' : fmt;
}

/** UI `google`/`azure-openai`/`openai-response` → daemon format the daemon accepts. */
function toDaemonFormat(fmt: ApiFormat | undefined): DaemonFormat {
  if (fmt === 'google') return 'gemini';
  if (fmt === 'anthropic') return 'anthropic';
  // openai / azure-openai / openai-response all speak the OpenAI wire format to
  // the daemon (the daemon only validates openai/anthropic/gemini).
  return 'openai';
}

/** daemon provider view → `LLMProvider` (name synthesized from id). */
export function toClientProvider(dto: DaemonProviderView): LLMProvider {
  const apiFormat = toUiFormat(dto.apiFormat);
  const provider: LLMProvider = {
    id: dto.id,
    // app-parity-2 child 1: the daemon now stores a mutable display `name`; fall
    // back to the id when absent (back-compat for rows written before this field).
    name: dto.name ?? dto.id,
    apiFormat,
    api_base_url: dto.baseUrl,
    // The daemon never returns a literal key. Leave `api_key` empty so the UI
    // shows the masked "key is set" state via `hasKey`.
    api_key: '',
    hasKey: dto.hasApiKey,
    models: dto.models ?? [],
    enabled: dto.enabled !== false,
  };
  // app-parity child 1: hydrate the now-backed scalar fields when present.
  if (dto.isOfficial !== undefined) provider.isOfficial = dto.isOfficial;
  if (dto.apiVersion !== undefined) provider.apiVersion = dto.apiVersion;
  if (dto.maxConcurrency !== undefined) provider.maxConcurrency = dto.maxConcurrency;
  if (dto.modelsEndpoint !== undefined) provider.modelsEndpoint = dto.modelsEndpoint;
  // app-parity child 2: hydrate the now-backed per-model metadata when present
  // (the daemon serializes only the named-five fields; absent for a flat-models-
  // only row, so the model controls show defaults). `modelGroups` stays unmapped —
  // the model hook derives groups from `modelConfigs[].group`.
  if (dto.modelConfigs !== undefined) provider.modelConfigs = dto.modelConfigs;
  // app-parity child 5 + child 2 (parity-2): hydrate the backed transformer config
  // when present. This is the CLIENT view of the STORED config (the GET DTO carries
  // the stored `transformer`). As of parity-2 child 2 the daemon ENFORCES it — the
  // custom `use[]` chain is applied in the request pipeline AFTER the format
  // transformer (which `getMainTransformer` supplies, format-first). Absent for a
  // row with no transformer.
  if (dto.transformer !== undefined) provider.transformer = dto.transformer;
  // app-parity-2 child 3: hydrate the coding-plan endpoint (MASKED — the literal
  // key is never returned; `apiKey` stays '' for blank-on-edit, `hasApiKey` drives
  // the "key is set" hint). Enforced by core's `resolveProviderEndpoint`.
  if (dto.codingPlan !== undefined) {
    provider.codingPlan = {
      enabled: dto.codingPlan.enabled,
      baseUrl: dto.codingPlan.baseUrl,
      apiKey: '',
      note: dto.codingPlan.note,
      hasApiKey: dto.codingPlan.hasApiKey,
    };
  }
  // app-parity-2 child 4: hydrate the API modes (MASKED — per-mode keys never
  // returned; the switcher needs only id/label/baseUrl/prefix/note). The selected
  // mode's key is applied server-side on switch + by core's resolver. Enforced by
  // core's `resolveProviderEndpoint` (layer 1).
  if (dto.apiModes !== undefined) {
    provider.apiModes = dto.apiModes.map((m) => ({
      id: m.id,
      label: m.label,
      baseUrl: m.baseUrl,
      apiKeyPrefix: m.apiKeyPrefix,
      note: m.note,
    }));
  }
  if (dto.selectedApiModeId !== undefined) provider.selectedApiModeId = dto.selectedApiModeId;
  return provider;
}

/**
 * Build the daemon write body from a page input/update. Only daemon-backed
 * fields are sent; still-unbacked fields (apiModes/modelGroups/...) are
 * deliberately dropped. `codingPlan` IS now sent (app-parity-2 child 3 — secret
 * apiKey blank-on-edit). `name` IS now sent (app-parity-2 child 1 — mutable
 * display name, separate from the immutable id). `modelConfigs` IS sent (child 2) —
 * group round-trips via `modelConfigs[].group`. `transformer` IS sent
 * (app-parity child 5) and ENFORCED by the daemon (parity-2 child 2: applied
 * after the format transformer). Per-model `enabled` gates the daemon's routed
 * model catalog (parity-2 child 2); name/group/vision/reasoning stay cosmetic.
 *
 * `api_key` is sent ONLY when non-empty (blank-on-edit keeps the stored key); a
 * masked value is never a real key, so an empty field maps to "leave unchanged".
 */
/**
 * The adapter's write input. `LLMProviderInput` and `LLMProviderUpdateInput`
 * disagree on the clearable scalar fields (Input has `string`/`number`, Update
 * has `… | null`); a plain intersection would COLLAPSE them back to the narrow
 * type and hide the clear signal. Drop those keys from the Input half so the
 * Update half's `| null` (the explicit-clear contract) wins.
 */
type ProviderWriteInput = Partial<
  Omit<LLMProviderInput, 'apiVersion' | 'modelsEndpoint' | 'maxConcurrency'> &
    LLMProviderUpdateInput
> & { id?: string };

function fromClientInput(input: ProviderWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.id !== undefined) body['id'] = input.id;
  // app-parity-2 child 1: forward the mutable display name when present (the form
  // + inline-rename always send a non-empty string). The daemon keeps it separate
  // from the immutable id (a body `id` on a PUT is ignored daemon-side).
  if (typeof input.name === 'string' && input.name.length > 0) body['name'] = input.name;
  if (input.apiFormat !== undefined) body['apiFormat'] = toDaemonFormat(input.apiFormat);
  if (input.api_base_url !== undefined) body['baseUrl'] = input.api_base_url;
  if (input.models !== undefined) body['models'] = input.models;
  // app-parity child 2: forward per-model metadata when the input carries it (the
  // model-management hook always sends the FULL desired `modelConfigs[]` on every
  // model write via `persistModelChanges`). The daemon array-replaces it through
  // its named-five allowlist (deny-by-default drops the wider ModelConfig fields).
  // `modelGroups` stays DROPPED — group round-trips via `modelConfigs[].group`.
  if (input.modelConfigs !== undefined) body['modelConfigs'] = input.modelConfigs;
  // Only send a key the user actually typed (non-empty, not a masked placeholder).
  if (typeof input.api_key === 'string' && input.api_key.trim().length > 0) {
    body['apiKey'] = input.api_key;
  }
  if (typeof input.enabled === 'boolean') body['enabled'] = input.enabled;
  // app-parity child 1: the now-backed scalar fields follow a uniform three-way
  // write contract — value→set, `null`→clear, `undefined`(omit)→keep. The inline
  // editors emit `null` to clear; we forward it so the daemon removes the stored
  // value (the daemon treats explicit null as clear, absent as keep — D4/OQ2).
  if (typeof input.isOfficial === 'boolean') body['isOfficial'] = input.isOfficial;
  if (typeof input.apiVersion === 'string') body['apiVersion'] = input.apiVersion;
  else if (input.apiVersion === null) body['apiVersion'] = null;
  if (typeof input.modelsEndpoint === 'string') body['modelsEndpoint'] = input.modelsEndpoint;
  else if (input.modelsEndpoint === null) body['modelsEndpoint'] = null;
  if (typeof input.maxConcurrency === 'number') body['maxConcurrency'] = input.maxConcurrency;
  else if (input.maxConcurrency === null) body['maxConcurrency'] = null;
  // app-parity child 5: forward the transformer config when the input carries it.
  // The form sends the FULL desired `transformer` (the daemon replaces the stored
  // value via its allowlist parse, preserving unknown per-model keys verbatim).
  // ENFORCED as of parity-2 child 2 — the daemon applies the custom `use[]` chain
  // after the format transformer (it no longer routes by `apiFormat` alone).
  if (input.transformer !== undefined) body['transformer'] = input.transformer;
  // app-parity-2 child 3: forward the coding-plan endpoint. Send enabled/baseUrl/
  // note; the nested secret `apiKey` ONLY when non-empty (blank-on-edit keeps the
  // stored key — the masked view never returns it). `hasApiKey` is a read-only view
  // hint and is NOT sent (the daemon allowlist would drop it anyway). Enforced by
  // core's `resolveProviderEndpoint`.
  if (input.codingPlan) {
    const cp: Record<string, unknown> = { enabled: Boolean(input.codingPlan.enabled) };
    if (typeof input.codingPlan.baseUrl === 'string') cp['baseUrl'] = input.codingPlan.baseUrl;
    if (typeof input.codingPlan.note === 'string') cp['note'] = input.codingPlan.note;
    if (typeof input.codingPlan.apiKey === 'string' && input.codingPlan.apiKey.trim().length > 0) {
      cp['apiKey'] = input.codingPlan.apiKey;
    }
    body['codingPlan'] = cp;
  }
  // app-parity-2 child 4: forward the SELECTED api-mode id (the app writes only the
  // selection on switch). `apiModes` themselves are config-defined mode definitions
  // (read-only on the app side) — NOT sent, so the daemon keeps the stored modes.
  // The selected mode's secret key is synced server-side on a normal switch.
  if (typeof input.selectedApiModeId === 'string') body['selectedApiModeId'] = input.selectedApiModeId;
  else if (input.selectedApiModeId === null) body['selectedApiModeId'] = null;
  return body;
}

function ok(provider?: LLMProvider): LLMProviderResult {
  return { success: true, provider };
}

function fail(err: unknown): LLMProviderResult {
  const message = err instanceof Error ? err.message : 'request failed';
  return { success: false, message };
}

/** Map a daemon discover response → the page's `ProviderModelDiscoveryResult`. */
function toDiscoveryResult(
  endpoint: string,
  resp: DaemonDiscoverResponse,
  unsupportedMessage: string,
): ProviderModelDiscoveryResult {
  if (resp.unsupportedFormat) {
    return {
      success: false,
      source: 'network',
      endpoint,
      models: [],
      unsupportedFormat: true,
      error: unsupportedMessage,
    };
  }
  if (resp.error) {
    return { success: false, source: 'network', endpoint, models: [], error: resp.error };
  }
  const models: ProviderModelDiscoveryEntry[] = (resp.models ?? []).map((id) => ({ id, name: id }));
  return { success: true, source: 'network', endpoint, models, fetchedAt: new Date().toISOString() };
}

/**
 * Build the daemon-backed LLM-config adapter. `unsupportedDiscoveryMessage` is
 * the i18n-resolved string shown for non-OpenAI discovery (passed in so the
 * adapter stays i18n-agnostic).
 */
export function createLlmConfigAdapter(unsupportedDiscoveryMessage: string): AgentLLMConfigApi {
  return {
    async getProviders(): Promise<LLMProvider[]> {
      const data = await adminClient.get<{ providers: DaemonProviderView[] }>('/providers');
      return (data.providers ?? []).map(toClientProvider);
    },

    async getProvider(id: string): Promise<LLMProvider | null> {
      try {
        const data = await adminClient.get<{ providers: DaemonProviderView[] }>('/providers');
        const row = (data.providers ?? []).find((p) => p.id === id);
        return row ? toClientProvider(row) : null;
      } catch {
        return null;
      }
    },

    async revealProviderKey(id: string): Promise<{ success: boolean; apiKey?: string; message?: string }> {
      try {
        const data = await adminClient.get<{ apiKey: string }>(
          `/providers/${encodeURIComponent(id)}/reveal-key`,
        );
        return { success: true, apiKey: data.apiKey ?? '' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to reveal key' };
      }
    },

    async addProvider(payload: LLMProviderInput): Promise<LLMProviderResult> {
      try {
        const body = fromClientInput(payload);
        // The daemon requires `baseUrl`; create needs an explicit id (the page
        // does not collect a separate id, so we mint one from the name).
        if (!body['id']) {
          body['id'] = slugifyId(payload.name) || `provider-${Date.now()}`;
        }
        const data = await adminClient.post<{ provider: DaemonProviderView }>('/providers', body);
        return ok(toClientProvider(data.provider));
      } catch (err) {
        if (err instanceof AdminApiError && err.status === 409) {
          return { success: false, message: err.message };
        }
        return fail(err);
      }
    },

    async updateProvider(payload: LLMProviderUpdateInput & { id: string }): Promise<LLMProviderResult> {
      try {
        const body = fromClientInput(payload);
        delete body['id']; // id is immutable + lives in the path
        // The daemon does a FULL-REPLACE PUT and rejects any body missing
        // apiFormat/baseUrl (400 "invalid provider (apiFormat, baseUrl
        // required)"). Partial callers (inline field edits, toggles) send only
        // the changed field, so backfill the provider's identity from the
        // current row when absent — mirrors `toggleProvider`. Without this every
        // partial update 400s and is silently swallowed (e.g. an inline API-key
        // edit never persists).
        if (body['apiFormat'] === undefined || body['baseUrl'] === undefined) {
          const current = await this.getProvider(payload.id);
          if (current) {
            if (body['apiFormat'] === undefined) body['apiFormat'] = toDaemonFormat(current.apiFormat);
            if (body['baseUrl'] === undefined) body['baseUrl'] = current.api_base_url;
          }
        }
        const data = await adminClient.put<{ provider: DaemonProviderView }>(
          `/providers/${encodeURIComponent(payload.id)}`,
          body,
        );
        return ok(toClientProvider(data.provider));
      } catch (err) {
        return fail(err);
      }
    },

    async deleteProvider(id: string): Promise<{ success: boolean; message?: string }> {
      try {
        await adminClient.delete(`/providers/${encodeURIComponent(id)}`);
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'delete failed' };
      }
    },

    async toggleProvider(id: string, enabled: boolean): Promise<LLMProviderResult> {
      try {
        // Fold into the PUT write path (D8 — no separate /toggle endpoint). The
        // daemon needs apiFormat+baseUrl on a PUT, so read the current row first.
        const current = await this.getProvider(id);
        if (!current) return { success: false, message: `provider '${id}' not found` };
        const data = await adminClient.put<{ provider: DaemonProviderView }>(
          `/providers/${encodeURIComponent(id)}`,
          {
            apiFormat: toDaemonFormat(current.apiFormat),
            baseUrl: current.api_base_url,
            enabled,
          },
        );
        return ok(toClientProvider(data.provider));
      } catch (err) {
        return fail(err);
      }
    },

    async reorderProviders(orderedIds: string[]): Promise<{ success: boolean; message?: string }> {
      try {
        await adminClient.post('/providers/reorder', { order: orderedIds });
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'reorder failed' };
      }
    },

    async resetProvider(id: string): Promise<LLMProviderResult> {
      // The daemon has no userOverrides overlay (that is an upstream-only
      // feature). Reset re-reads the provider as-is — a no-op that refreshes it.
      try {
        const provider = await this.getProvider(id);
        if (!provider) return { success: false, message: `provider '${id}' not found` };
        return ok(provider);
      } catch (err) {
        return fail(err);
      }
    },

    async discoverModels(
      id: string,
      _options?: { forceRefresh?: boolean },
    ): Promise<ProviderModelDiscoveryResult> {
      const endpoint = `/providers/${id}/discover-models`;
      try {
        const resp = await adminClient.post<DaemonDiscoverResponse>(
          `/providers/${encodeURIComponent(id)}/discover-models`,
        );
        return toDiscoveryResult(endpoint, resp, unsupportedDiscoveryMessage);
      } catch (err) {
        return {
          success: false,
          source: 'network',
          endpoint,
          models: [],
          error: err instanceof Error ? err.message : 'discovery failed',
        };
      }
    },

    async testModel(providerId: string, model: string): Promise<ModelTestResult> {
      try {
        return await adminClient.post<ModelTestResult>(
          `/providers/${encodeURIComponent(providerId)}/test`,
          { model },
        );
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'test failed' };
      }
    },

    async addFromPreset({
      presetId,
      apiKey,
      enabled,
    }: {
      presetId: string;
      apiKey?: string;
      enabled?: boolean;
    }): Promise<LLMProviderResult> {
      try {
        const presets = await this.getPresets();
        const preset = presets.find((p) => p.presetId === presetId || p.id === presetId);
        if (!preset) return { success: false, message: `preset '${presetId}' not found` };
        // Materialize with the preset's OWN id (no minting) — the provider list
        // merges in a synthesized row keyed by this id, and it must dedup against
        // the materialized provider so the row flips in place (no duplicate).
        const body: Record<string, unknown> = {
          id: preset.id,
          apiFormat: preset.apiFormat,
          baseUrl: preset.baseUrl,
          models: preset.models ?? [],
        };
        // Carry the user-supplied key + enable state from the inline configure
        // flow (a masked/blank value is never sent — same discipline as edits).
        if (typeof apiKey === 'string' && apiKey.trim().length > 0) body['apiKey'] = apiKey;
        if (typeof enabled === 'boolean') body['enabled'] = enabled;
        const data = await adminClient.post<{ provider: DaemonProviderView }>('/providers', body);
        return ok(toClientProvider(data.provider));
      } catch (err) {
        if (err instanceof AdminApiError && err.status === 409) {
          return { success: false, message: err.message };
        }
        return fail(err);
      }
    },

    async getApiKeys(providerId: string): Promise<ApiKeyEntry[]> {
      try {
        const data = await adminClient.get<{ keys: DaemonPoolKeyView[] }>(
          `/providers/${encodeURIComponent(providerId)}/keys`,
        );
        return (data.keys ?? []).map((k, idx) => toApiKeyEntry(providerId, k, idx));
      } catch {
        return [];
      }
    },

    async getKeyHealth(providerId: string): Promise<KeyHealthMap> {
      try {
        const data = await adminClient.get<{ keys: DaemonPoolKeyView[] }>(
          `/providers/${encodeURIComponent(providerId)}/keys`,
        );
        const map: KeyHealthMap = {};
        for (const k of data.keys ?? []) {
          if (k.health?.cooldown) {
            map[k.id] = {
              until: k.health.cooldown.until,
              errors: k.health.cooldown.errors,
              lastStatus: k.health.cooldown.lastStatus,
            };
          }
        }
        return map;
      } catch {
        return {};
      }
    },

    // ── Key-pool MUTATIONS — daemon-backed (app-parity child 3). ──
    // Each maps a provider-scoped pool-key write endpoint and returns ONLY the
    // masked health view; the adapter never receives (and never echoes) a literal
    // key. On failure each returns `{ success: false }` (never fake success).

    async addApiKey(input: ApiKeyEntryInput) {
      try {
        const data = await adminClient.post<{ keys: DaemonPoolKeyView[] }>(
          `/providers/${encodeURIComponent(input.providerId)}/keys`,
          {
            label: input.label,
            weight: input.weight,
            enabled: input.enabled,
            apiKey: input.apiKey,
          },
        );
        const keys = data.keys ?? [];
        // The daemon mints the id and APPENDS the new entry to `apiKeys[]`, so the
        // new key is the LAST entry in the returned (full-pool) masked view.
        const last = keys[keys.length - 1];
        const entry = last ? toApiKeyEntry(input.providerId, last, keys.length - 1) : undefined;
        return { success: true, entry };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'add key failed' };
      }
    },

    async updateApiKey(
      providerId: string,
      id: string,
      updates: { label?: string; weight?: number; enabled?: boolean; apiKey?: string },
    ) {
      try {
        // Forward only the provided fields (a masked/blank apiKey is never sent —
        // the daemon's blank→keep contract preserves the stored key).
        const body: Record<string, unknown> = {};
        if (updates.label !== undefined) body['label'] = updates.label;
        if (updates.weight !== undefined) body['weight'] = updates.weight;
        if (updates.enabled !== undefined) body['enabled'] = updates.enabled;
        if (typeof updates.apiKey === 'string' && updates.apiKey.trim().length > 0) {
          body['apiKey'] = updates.apiKey;
        }
        const data = await adminClient.put<{ keys: DaemonPoolKeyView[] }>(
          `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(id)}`,
          body,
        );
        const keys = data.keys ?? [];
        const idx = keys.findIndex((k) => k.id === id);
        const entry = idx >= 0 ? toApiKeyEntry(providerId, keys[idx], idx) : undefined;
        return { success: true, entry };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'update key failed' };
      }
    },

    async deleteApiKey(providerId: string, id: string) {
      try {
        await adminClient.delete(
          `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(id)}`,
        );
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'delete key failed' };
      }
    },

    async toggleApiKey(providerId: string, id: string, enabled: boolean) {
      try {
        await adminClient.post(
          `/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(id)}/enabled`,
          { enabled },
        );
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'toggle key failed' };
      }
    },

    async getPresets(): Promise<DaemonPresetView[]> {
      try {
        const data = await adminClient.get<{ presets: DaemonPresetView[] }>('/presets');
        return data.presets ?? [];
      } catch {
        return [];
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** daemon pool-key view → `ApiKeyEntry` (read-only; key never present). */
function toApiKeyEntry(providerId: string, k: DaemonPoolKeyView, idx: number): ApiKeyEntry {
  const auto = k.health?.autoDisabled;
  return {
    id: k.id,
    providerId,
    label: k.label,
    apiKey: '', // never returned
    hasKey: Boolean(k.apiKeyMasked),
    keyHint: k.apiKeyMasked || undefined,
    enabled: k.enabled,
    weight: k.weight,
    sortOrder: idx,
    disabledReason: auto?.reason === 'auth_failure' ? 'auth_failure' : auto ? 'auto_disabled' : null,
    lastErrorStatus: auto?.status ?? null,
    lastErrorAt: auto?.at ?? null,
  };
}

function slugifyId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
