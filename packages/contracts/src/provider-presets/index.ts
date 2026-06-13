/**
 * Provider Presets — Unified registry of LLM provider preset templates
 * (directory module; the loader/barrel for `@omnicross/contracts/provider-presets`).
 *
 * This module is the single source of truth for "Quick Add Provider" UI and
 * for cold-boot seeding. The exported list `LLM_PROVIDER_PRESETS` is a single
 * flat array — no regional grouping, no sub-arrays. The preset DATA lives in
 * `presets/<id>.json` (one file per preset); this loader imports them in the
 * exact source order, validates each against the Zod `presetSchema` at module
 * init (fail-fast in dev), and assembles `LLM_PROVIDER_PRESETS`. Types, derived
 * maps, and helpers stay TypeScript (`types.ts` / `schema.ts` / `defaults.ts`).
 *
 * Per-preset defaults that vary by category (e.g. `maxConcurrency`) live in
 * dedicated maps such as {@link MAX_CONCURRENCY_DEFAULTS}.
 *
 * Adding a new preset: add `presets/<id>.json`, wire its import into
 * `manifest.ts` at the right position, add a row to the relevant default map if
 * it diverges from the baseline, and update i18n.
 */
import catalog from './catalog.json';
import {
  CODING_PLAN_URL_PRESETS,
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_DEFAULTS,
  PROVIDER_MODEL_MAPPINGS,
  PROVIDER_SEARCH_CONFIGS,
} from './defaults';
import { RAW_PRESETS_IN_ORDER } from './manifest';
import { presetSchema } from './schema';
import type { PresetProviderTemplate, ProviderSearchConfig } from './types';

// Re-export the full type surface + the API_MODE_IDS const.
export type {
  ApiMode,
  ApiModeId,
  CodingPlanConfig,
  PresetProviderTemplate,
  ProviderModelMapping,
  ProviderSearchConfig,
  SearchCapability,
} from './types';
export { API_MODE_IDS } from './types';

// Re-export the derived maps + seed-id const (verbatim public API).
export {
  CODING_PLAN_URL_PRESETS,
  DEFAULT_SEED_PRESET_IDS,
  MAX_CONCURRENCY_DEFAULTS,
  PROVIDER_MODEL_MAPPINGS,
  PROVIDER_SEARCH_CONFIGS,
} from './defaults';

// ----------------------------------------------------------------------------
// Loader — validate every preset JSON at module init, assemble the flat array.
// ----------------------------------------------------------------------------

/** Top-level catalog version (additive metadata; reserved, inert). */
export const CATALOG_VERSION: number = catalog.version;

/**
 * Per-preset revision metadata, keyed by preset id. Defaults to `1` when the
 * JSON omits `revision` (design D2). Reserved for future overlay/remote-refresh;
 * intentionally NOT merged into the returned preset objects so the public API
 * surface stays byte-identical to the prior flat array.
 */
const PRESET_REVISIONS: Record<string, number> = {};

function loadPresets(): PresetProviderTemplate[] {
  return RAW_PRESETS_IN_ORDER.map((raw) => {
    // Throws at module init on a malformed preset, identifying the field.
    const parsed = presetSchema.parse(raw);
    PRESET_REVISIONS[parsed.id] = parsed.revision ?? 1;
    // Strip the reserved `revision` field so the returned object matches the
    // prior flat literal exactly (no extra keys). JSON omits it today, so this
    // is defensive — keeps the invariant if a revision is ever added to a file.
    if ('revision' in parsed) {
      const { revision: _revision, ...rest } = parsed as Record<string, unknown>;
      void _revision;
      return rest as unknown as PresetProviderTemplate;
    }
    return parsed as unknown as PresetProviderTemplate;
  });
}

/**
 * LLM provider presets — single flat list, assembled from `presets/<id>.json`
 * in source order. Deep-equal to the prior flat TS array (golden-tested).
 */
export const LLM_PROVIDER_PRESETS: PresetProviderTemplate[] = loadPresets();

/** Resolve a preset's revision (default 1). Reserved; no current consumer. */
export function getPresetRevision(id: string): number {
  return PRESET_REVISIONS[id] ?? 1;
}

// ============================================================================
// Public API — helpers (verbatim semantics from the prior flat file)
// ============================================================================

/**
 * Resolve follow-provider model for a given provider.
 * Returns the mapped model ref string ("providerId,modelId") or undefined.
 */
export function resolveFollowProviderModel(
  providerId: string,
  presetId: string | undefined,
  type: 'background' | 'vision',
): string | undefined {
  const key = presetId || providerId;
  const mapping = PROVIDER_MODEL_MAPPINGS[key];
  if (!mapping) return undefined;

  const modelId = type === 'background' ? mapping.background : mapping.vision;
  if (!modelId) return undefined;

  return `${providerId},${modelId}`;
}

/**
 * Get all provider presets as a flat list (international + Chinese + local + fast-inference).
 * Client preset pickers consume this directly with no grouping.
 */
export function getAllProviderPresets(): PresetProviderTemplate[] {
  return LLM_PROVIDER_PRESETS.map((p) => ({
    maxConcurrency: MAX_CONCURRENCY_DEFAULTS[p.id] ?? DEFAULT_MAX_CONCURRENCY,
    ...p,
  }));
}

/**
 * Find a preset by its unique `id` first, then by `presetId` as fallback.
 *
 * `id` is the unique key — for variants that share `presetId` (e.g. xiaomi-mimo
 * OpenAI vs Anthropic), use `id` to disambiguate. Callers passing a `presetId`
 * value (legacy code) still resolve to the first matching variant.
 */
export function getPresetById(idOrPresetId: string): PresetProviderTemplate | undefined {
  const all = getAllProviderPresets();
  return all.find((p) => p.id === idOrPresetId) ?? all.find((p) => p.presetId === idOrPresetId);
}

/**
 * Get the Coding Plan base URL for a preset.
 * Looks up by preset's own `id` first (so Xiaomi double-variant resolves
 * each side correctly), then falls back to CODING_PLAN_URL_PRESETS map.
 */
export function getCodingPlanBaseUrl(idOrPresetId: string): string | undefined {
  const preset = getPresetById(idOrPresetId);
  if (preset?.codingPlanBaseUrl) return preset.codingPlanBaseUrl;
  return CODING_PLAN_URL_PRESETS[idOrPresetId]?.baseUrl;
}

/**
 * Get the search configuration for a provider by its preset ID.
 * Checks the preset's inline searchConfig first, then falls back to PROVIDER_SEARCH_CONFIGS.
 */
export function getProviderSearchConfig(presetId: string): ProviderSearchConfig | undefined {
  const preset = getPresetById(presetId);
  if (preset?.searchConfig) return preset.searchConfig;
  return PROVIDER_SEARCH_CONFIGS[presetId];
}
