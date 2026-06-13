/**
 * preset-catalog.ts — the single seam onto the curated provider-preset
 * catalog (`@omnicross/contracts/provider-presets`) (design D1).
 *
 * This is the ONLY place in the daemon that VALUE-imports the contracts catalog
 * (everything else is `import type`, compile-time-erased). It exists because the
 * catalog is a directory barrel whose module can resolve to a different SHAPE
 * under the daemon's runtimes:
 *   - vitest-from-root (Vite transform): named exports live directly on the
 *     namespace object.
 *   - CJS interop (the built `dist/cli.cjs` require path, or a dev `tsx`
 *     invocation that treats the module as CJS): the named exports hang off
 *     `.default`.
 * `normalizeCatalogModule` picks whichever side carries `LLM_PROVIDER_PRESETS`,
 * collapsing both runtimes into one clean, typed access surface. It fails fast
 * (throws) rather than silently returning an empty catalog.
 *
 * The rest of the daemon (`preset-map.ts`, CLI, admin) only imports THIS file.
 *
 * @module @omnicross/daemon/preset-catalog
 */

import type { PresetProviderTemplate } from '@omnicross/contracts/provider-presets';
import * as presetsModule from '@omnicross/contracts/provider-presets';

/** The subset of the catalog module surface the daemon consumes. */
interface CatalogShape {
  LLM_PROVIDER_PRESETS: PresetProviderTemplate[];
  getAllProviderPresets: () => PresetProviderTemplate[];
  getPresetById: (idOrPresetId: string) => PresetProviderTemplate | undefined;
}

/**
 * Interop-normalize the imported namespace: vitest exposes the named exports on
 * the namespace itself; tsx (CJS) hangs them off `.default`. Pick the side that
 * actually carries `LLM_PROVIDER_PRESETS`. Fail fast (clear error) if neither
 * does, so a resolution regression never degrades into a silent empty catalog.
 */
function normalizeCatalogModule(m: unknown): CatalogShape {
  const ns = (m ?? {}) as Record<string, unknown>;
  const fromDefault = ns['default'] as Record<string, unknown> | undefined;
  const picked = (Array.isArray(ns['LLM_PROVIDER_PRESETS']) ? ns : fromDefault) ?? ns;
  if (!Array.isArray(picked['LLM_PROVIDER_PRESETS'])) {
    throw new Error(
      'preset-catalog: @omnicross/contracts/provider-presets did not resolve a usable catalog ' +
        '(no LLM_PROVIDER_PRESETS array on the namespace or its .default)',
    );
  }
  return picked as unknown as CatalogShape;
}

const catalog: CatalogShape = normalizeCatalogModule(presetsModule);

/** The full curated catalog (flat array; preset order preserved). */
export function getCatalog(): PresetProviderTemplate[] {
  return catalog.getAllProviderPresets();
}

/** Resolve a single preset by its unique `id` first, then by `presetId`. */
export function getPresetById(idOrPresetId: string): PresetProviderTemplate | undefined {
  return catalog.getPresetById(idOrPresetId);
}

export type { PresetProviderTemplate };
