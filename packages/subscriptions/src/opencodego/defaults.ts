/**
 * Built-in default OpenCodeGo model map + fallback chain.
 *
 * Users may override per-scenario entries via `OpenCodeGoTokenConfig.modelMap` /
 * `OpenCodeGoTokenConfig.fallbacks`; unset entries fall back to these.
 */

import type { OpenCodeGoModelEntry, OpenCodeGoScenario } from '@omnicross/contracts/subscription-types';

/** Default cl100k_base token threshold for the `long_context` scenario. */
export const DEFAULT_OPENCODEGO_LONG_CONTEXT_THRESHOLD = 80_000;

export const DEFAULT_OPENCODEGO_MODEL_MAP: Record<OpenCodeGoScenario, OpenCodeGoModelEntry> = {
  default: {
    modelId: 'kimi-k2.6',
    temperature: 0.7,
    maxTokens: 4096,
  },
  long_context: {
    modelId: 'minimax-m2.5',
    contextThreshold: DEFAULT_OPENCODEGO_LONG_CONTEXT_THRESHOLD,
  },
  think: {
    modelId: 'glm-5',
  },
  complex: {
    // Complex tasks use the higher-capability GLM variant by default.
    modelId: 'glm-5.1',
  },
  fast: {
    modelId: 'qwen3.6-plus',
  },
  // AUTO-SELECTABLE (D3): the scenario router auto-selects `background` via the
  // keyword heuristics in `ScenarioRouter.resolveOpenCodeGoScenario` (NO
  // tool-blocker keyword AND ≥1 background keyword). It also remains reachable via
  // an explicit user `modelMap.background` key. Mirrors config.example.json:9-15.
  background: {
    modelId: 'qwen3.5-plus',
    temperature: 0.5,
    maxTokens: 2048,
  },
};

// Built-in fallback order for each scenario (modelId-only entries).
export const DEFAULT_OPENCODEGO_FALLBACKS: Record<OpenCodeGoScenario, OpenCodeGoModelEntry[]> = {
  default: [
    { modelId: 'mimo-v2-pro' },
    { modelId: 'qwen3.6-plus' },
  ],
  long_context: [
    { modelId: 'minimax-m2.7' },
    { modelId: 'kimi-k2.6' },
  ],
  think: [
    { modelId: 'kimi-k2.6' },
    { modelId: 'mimo-v2-pro' },
  ],
  complex: [
    { modelId: 'glm-5' },
    { modelId: 'kimi-k2.6' },
  ],
  fast: [
    { modelId: 'qwen3.5-plus' },
    { modelId: 'minimax-m2.5' },
  ],
  // AUTO-SELECTABLE (D3) — see DEFAULT_OPENCODEGO_MODEL_MAP.background. Mirrors
  // config.example.json:69-73.
  background: [
    { modelId: 'qwen3.6-plus' },
    { modelId: 'minimax-m2.5' },
  ],
};
