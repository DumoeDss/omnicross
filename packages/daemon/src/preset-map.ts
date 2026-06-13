/**
 * preset-map.ts — pure mapping from a provider preset to a daemon
 * provider row. Pure (no IO), unit-tested, and every fold/drop/exclusion is
 * human-visible (a `reason` string) rather than a silent transform.
 *
 * The preset `apiFormat` union (5 values, schema-pinned) is WIDER than the
 * daemon's (`openai | anthropic | gemini`). `FORMAT_MAP` is the single explicit
 * narrowing/translation table:
 *   openai          → openai
 *   anthropic       → anthropic
 *   google          → gemini      (NAME TRANSLATION, not a passthrough — D3)
 *   openai-response → EXCLUDED     (daemon row can't carry a Responses transformer chain)
 *   azure-openai    → EXCLUDED     (needs apiVersion + deployment-name-as-model URL template)
 *
 * `apiKey` is NEVER sourced from the preset — it is supplied by the caller
 * (CLI `--key` / admin body), literal or `$ENV_VAR` (resolved at call time by core).
 *
 * @module @omnicross/daemon/preset-map
 */

import type { DaemonApiFormat, DaemonProviderConfig } from './config';
import { getCatalog, type PresetProviderTemplate } from './preset-catalog';

/**
 * The preset `apiFormat` union (the schema-pinned 5 values, mirrored locally —
 * `PresetProviderTemplate['apiFormat']` is `ApiFormat | undefined`, so we narrow
 * here to the concrete set the catalog actually carries).
 */
export type PresetApiFormat =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure-openai'
  | 'openai-response';

/** Human-readable reasons for each excluded preset format (design D6). */
export const EXCLUSION_REASONS = {
  'openai-response':
    'daemon rows have no openai-response format; the Responses API needs a ' +
    'transformer chain that a BYO daemon provider row cannot express.',
  'azure-openai':
    'Azure needs an apiVersion + a deployment-name-as-model URL template + an ' +
    'empty baseUrl; a daemon provider row cannot express that shape.',
} as const;

/**
 * Explicit narrowing/translation table. `null` means the format cannot be
 * expressed as a daemon row (excluded with a reason).
 */
export const FORMAT_MAP: Record<PresetApiFormat, DaemonApiFormat | null> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'gemini',
  'openai-response': null,
  'azure-openai': null,
};

/** Options for {@link mapPresetToProvider} — the apiKey + optional overrides. */
export interface MapPresetOptions {
  /** BYO key (literal or `$ENV_VAR`); the ONLY source of `apiKey`. */
  key: string;
  /** Override the row id (defaults to `preset.id`). */
  id?: string;
  /** Override the base URL (defaults to `preset.api_base_url`). */
  baseUrlOverride?: string;
}

/** The discriminated result of mapping one preset. */
export type MapPresetResult =
  | { provider: DaemonProviderConfig }
  | { excluded: { id: string; reason: string } }
  | { missingKey: true };

/**
 * Resolve a preset's `apiFormat` to a daemon format, or to an exclusion reason.
 * An unknown/new format (not in `FORMAT_MAP`) is treated as excluded — never a
 * crash (design "目录格式全覆盖" + drift mitigation).
 */
function resolveFormat(
  raw: PresetProviderTemplate['apiFormat'],
): { format: DaemonApiFormat } | { excludedReason: string } {
  const fmt = raw as PresetApiFormat | undefined;
  if (fmt === undefined || !(fmt in FORMAT_MAP)) {
    return {
      excludedReason: `unknown/unsupported preset apiFormat '${String(raw)}'; no daemon format mapping.`,
    };
  }
  const mapped = FORMAT_MAP[fmt];
  if (mapped === null) {
    return { excludedReason: EXCLUSION_REASONS[fmt as keyof typeof EXCLUSION_REASONS] };
  }
  return { format: mapped };
}

/**
 * Map one preset → a daemon provider row, narrowing/translating/excluding the
 * format. Pure. `apiKey` comes ONLY from `opts.key`; an empty key yields
 * `{ missingKey: true }` (no fake empty-key row). Carries `id`/`apiFormat`/
 * `baseUrl`/`models`; every other preset field is dropped (daemon rows have no slot).
 */
export function mapPresetToProvider(
  preset: PresetProviderTemplate,
  opts: MapPresetOptions,
): MapPresetResult {
  const resolved = resolveFormat(preset.apiFormat);
  if ('excludedReason' in resolved) {
    return { excluded: { id: opts.id ?? preset.id, reason: resolved.excludedReason } };
  }
  if (!opts.key) {
    return { missingKey: true };
  }
  const provider: DaemonProviderConfig = {
    id: opts.id ?? preset.id,
    apiFormat: resolved.format,
    baseUrl: opts.baseUrlOverride ?? preset.api_base_url,
    apiKey: opts.key,
    models: Array.isArray(preset.models) ? preset.models : undefined,
  };
  return { provider };
}

/** A mappable preset's view (post-narrowing) for CLI/admin listing. */
export interface MappablePreset {
  id: string;
  presetId: string;
  name: string;
  apiFormat: DaemonApiFormat;
  baseUrl: string;
  models: string[];
}

/** The split of the whole catalog into mappable + excluded. */
export interface ListMappableResult {
  mappable: MappablePreset[];
  excluded: { id: string; reason: string }[];
}

/**
 * Walk the whole catalog, splitting it into the presets that map to a daemon row
 * (with the NARROWED format) and the ones excluded (with a reason). Shared by the
 * `providers presets` CLI and the admin `GET /admin/api/presets`.
 */
export function listMappablePresets(): ListMappableResult {
  const mappable: MappablePreset[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const preset of getCatalog()) {
    const resolved = resolveFormat(preset.apiFormat);
    if ('excludedReason' in resolved) {
      excluded.push({ id: preset.id, reason: resolved.excludedReason });
      continue;
    }
    mappable.push({
      id: preset.id,
      presetId: preset.presetId,
      name: preset.name,
      apiFormat: resolved.format,
      baseUrl: preset.api_base_url,
      models: Array.isArray(preset.models) ? preset.models : [],
    });
  }
  return { mappable, excluded };
}
