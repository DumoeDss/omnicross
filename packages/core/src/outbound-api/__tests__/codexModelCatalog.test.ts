/**
 * Tests for the Codex-native `ModelsResponse` builder (model-name-visibility).
 *
 * The builder is pure: the same entries always produce the same document. The
 * load-bearing contract is SCHEMA VALIDITY — every non-Option `ModelInfo` field
 * without a serde default must be present (a malformed catalog is only a logged
 * refresh error client-side, but a valid one keeps the picker merge working).
 *
 * @module outbound-api/__tests__/codexModelCatalog.test
 */
import { describe, expect, it } from 'vitest';

import {
  buildCodexModelCatalog,
  EMPTY_CODEX_MODEL_CATALOG,
  type RealModelEntry,
} from '../codexModelCatalog';

describe('buildCodexModelCatalog', () => {
  it('no entries yields the frozen empty catalog (realNames off ⇒ merge is a no-op)', () => {
    expect(buildCodexModelCatalog([])).toBe(EMPTY_CODEX_MODEL_CATALOG);
    expect(EMPTY_CODEX_MODEL_CATALOG).toEqual({ models: [] });
  });

  it('emits every serde-required ModelInfo field for each entry', () => {
    const catalog = buildCodexModelCatalog([{ id: 'deepseek-flash' }]);
    expect(catalog.models).toHaveLength(1);
    const model = catalog.models[0] as Record<string, unknown>;
    // Non-Option fields without serde defaults — all MUST be present.
    for (const key of [
      'slug',
      'display_name',
      'supported_reasoning_levels',
      'shell_type',
      'visibility',
      'supported_in_api',
      'priority',
      'support_verbosity',
      'truncation_policy',
      'experimental_supported_tools',
    ]) {
      expect(model[key], `missing required field ${key}`).toBeDefined();
    }
    expect(model['slug']).toBe('deepseek-flash');
    // Unknown display name falls back to the raw id.
    expect(model['display_name']).toBe('deepseek-flash');
    expect(model['visibility']).toBe('list');
    expect(model['supported_in_api']).toBe(true);
    expect(model['shell_type']).toBe('unified_exec');
  });

  it('carries metadata: display name, context window, mapped thinking levels', () => {
    const entry: RealModelEntry = {
      id: 'kimi-k3',
      displayName: 'Kimi K3',
      contextWindow: 262_144,
      thinkingLevels: ['low', 'high'],
    };
    const catalog = buildCodexModelCatalog([entry]);
    const model = catalog.models[0];
    expect(model.display_name).toBe('Kimi K3');
    expect(model.context_window).toBe(262_144);
    expect(model.supported_reasoning_levels).toEqual([
      { effort: 'low', description: expect.any(String) },
      { effort: 'high', description: expect.any(String) },
    ]);
    // The first known level becomes the default (medium preferred when present).
    expect(model.default_reasoning_level).toBe('low');
  });

  it('unknown thinking levels fall back to a single medium preset; medium wins the default', () => {
    const catalog = buildCodexModelCatalog([
      { id: 'a' },
      { id: 'b', thinkingLevels: ['minimal', 'medium', 'max'] },
    ]);
    expect(catalog.models[0].supported_reasoning_levels).toEqual([
      { effort: 'medium', description: expect.any(String) },
    ]);
    expect(catalog.models[0].default_reasoning_level).toBe('medium');
    expect(catalog.models[1].default_reasoning_level).toBe('medium');
  });

  it('priorities are index-ordered below the bundled catalog (picker order stays stable)', () => {
    const catalog = buildCodexModelCatalog([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const priorities = catalog.models.map((m) => m.priority);
    expect(priorities).toEqual([-100, -99, -98]);
  });

  it('non-finite or non-positive context windows are omitted, not clamped', () => {
    const catalog = buildCodexModelCatalog([
      { id: 'a', contextWindow: Number.NaN },
      { id: 'b', contextWindow: 0 },
      { id: 'c', contextWindow: -5 },
    ]);
    for (const model of catalog.models) {
      expect(model.context_window).toBeUndefined();
    }
  });
});
