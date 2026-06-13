/**
 * OpenCodeGo upstream shape resolver.
 *
 * Classifies a resolved provider model id into one of the upstream wire shapes,
 * keyed on the provider HALF the model lives on (`go` vs `zen`). Mirrors the
 * routing in `_others/oc-go-cc/internal/client/opencode.go`
 * (`ClassifyEndpoint` / `IsAnthropicModel` / `getEndpoint`).
 *
 * - GO half: most models are OpenAI-shape (`chat`); the MiniMax family is
 *   Anthropic-shape `/v1/messages`. (UNCHANGED from the original detector.)
 * - ZEN half: the reference's four-endpoint classifier — `anthropic`
 *   (`claude*` / `minimax*` / explicit `qwen3.7-max`), `gemini` (`gemini-*`),
 *   `responses` (`gpt-5*` / `*-codex`), else `chat`.
 *
 * The shape union widened from `'openai' | 'anthropic'` to the four-member
 * `OpenCodeGoShape`; `'openai'` is renamed to `'chat'` for naming consistency
 * with the zen classifier (both speak the OpenAI Chat Completions wire).
 */

import type { OpenCodeGoModelEntry, OpenCodeGoScenario } from '@omnicross/contracts/subscription-types';

export type OpenCodeGoShape = 'anthropic' | 'chat' | 'responses' | 'gemini';

/** Provider half a model lives on (mirrors the reference `ModelConfig.Provider`). */
export type OpenCodeGoHalf = 'go' | 'zen';

/** Model id prefixes (case-insensitive) that route to the Anthropic-shape upstream
 *  on the GO half. (UNCHANGED — the reference's go-half anthropic family.) */
const GO_ANTHROPIC_SHAPE_PREFIXES: readonly string[] = ['minimax-', 'minimax_'];

/**
 * The reference's `gpt-5*` / `*-codex` Responses family
 * (`_others/oc-go-cc/internal/client/opencode.go` `isResponsesModel`). Ported as
 * a `gpt-5*` PREFIX (covers the whole listed family + near-future ids) plus the
 * `*-codex` suffix rule — strictly a superset of the reference's hard-coded list,
 * so every reference id still classifies as `responses`.
 */
function isZenResponsesModel(modelId: string): boolean {
  return modelId.startsWith('gpt-5') || modelId.endsWith('-codex');
}

/**
 * The reference's gemini family (`isGeminiModel`). The reference hard-codes three
 * ids (`gemini-3.5-flash` / `gemini-3.1-pro` / `gemini-3-flash`); we accept the
 * `gemini-` PREFIX as a forward-compatible superset (a documented deliberate
 * widening — the prefix is the CORRECT endpoint for the whole family, the inverse
 * judgment from the qwen* fix below).
 */
function isZenGeminiModel(modelId: string): boolean {
  return modelId.startsWith('gemini-');
}

/**
 * The reference's Anthropic-shape zen family — WITH the deliberate `qwen*`
 * over-capture FIX (LEAD Q2). The reference's `isZenAnthropicModel` routes ANY
 * `qwen*` prefix to `/v1/messages`, which mis-sends qwen *chat* models. We route
 * ONLY the explicit `qwen3.7-max` (plus `claude*` / `minimax*`); all other qwen
 * ids fall through to `chat`. This is a DOCUMENTED divergence (the reference
 * behavior is a latent bug). `// UNVERIFIED (no live zen key)` — if opencode.ai's
 * real zen backend genuinely expects all `qwen*` on `/v1/messages`, this would
 * misroute; no live key exists to confirm either way, so the documented-correct
 * behavior wins.
 */
function isZenAnthropicModel(modelId: string): boolean {
  if (modelId.startsWith('claude') || modelId.startsWith('minimax')) return true;
  // Explicit single-id only — NOT the reference's `qwen*` prefix.
  return modelId === 'qwen3.7-max';
}

/**
 * Classify a ZEN-half model id into the four wire shapes — ported from the
 * reference `ClassifyEndpoint` (anthropic → gemini → responses → chat order).
 * Case-insensitive (lower-cased before matching) to mirror the rest of the
 * resolver.
 */
export function classifyZenShape(modelId: string): OpenCodeGoShape {
  const normalized = modelId.toLowerCase();
  if (isZenAnthropicModel(normalized)) return 'anthropic';
  if (isZenGeminiModel(normalized)) return 'gemini';
  if (isZenResponsesModel(normalized)) return 'responses';
  return 'chat';
}

/**
 * The SINGLE classification site keyed on `(provider ?? 'go', modelId)`. GO half
 * preserves the existing rule (`minimax-*` → `anthropic`, else → `chat`); ZEN half
 * runs `classifyZenShape`. The `entry` is the resolved `OpenCodeGoModelEntry`
 * (the scenario mapper already returns one), so `provider` rides along.
 */
export function resolveOpenCodeGoShape(entry: {
  provider?: OpenCodeGoHalf;
  modelId: string;
}): OpenCodeGoShape {
  const half: OpenCodeGoHalf = entry.provider ?? 'go';
  if (half === 'zen') return classifyZenShape(entry.modelId);
  const normalized = entry.modelId.toLowerCase();
  if (GO_ANTHROPIC_SHAPE_PREFIXES.some((p) => normalized.startsWith(p))) {
    return 'anthropic';
  }
  return 'chat';
}

/**
 * Thin GO-only shape detector retained for back-compat. Equivalent to
 * `resolveOpenCodeGoShape({ modelId })` (go half). Returns the four-member union
 * but only ever yields `'anthropic'` | `'chat'` on the go half. Prefer
 * `resolveOpenCodeGoShape` in new code.
 */
export function detectOpenCodeGoShape(modelId: string): OpenCodeGoShape {
  return resolveOpenCodeGoShape({ modelId });
}

/**
 * Minimal config shape the half resolver scans. Structural subset of
 * `OpenCodeGoTokenConfig` — kept narrow so callers can pass the opaque config
 * without it being the full contract type.
 */
interface ModelMapConfig {
  modelMap?: Partial<Record<OpenCodeGoScenario, OpenCodeGoModelEntry>>;
  fallbacks?: Partial<Record<OpenCodeGoScenario, OpenCodeGoModelEntry[]>>;
}

/**
 * Resolve the provider HALF for a RESOLVED model id, given the user's per-account
 * config. The dispatch profile's `resolveUpstreamUrl(model, config)` receives only
 * the resolved model STRING (the scenario mapper already collapsed the entry to its
 * `modelId`), so the half must be recovered by scanning the config's `modelMap` +
 * `fallbacks` for the entry whose `modelId` matches and reading its `provider`.
 *
 * The built-in defaults are entirely go-half (no `provider` field) and zen is
 * reachable ONLY via an explicit user entry (Q1 strict user-only parity), so a
 * model id that appears in NO user entry resolves to `'go'` — preserving the
 * pre-change go-half behavior byte-identically. First match wins (modelMap before
 * fallbacks); if the same id appears on both halves in user config, the modelMap
 * entry's half is authoritative (a documented, unlikely edge).
 */
export function resolveOpenCodeGoHalf(
  modelId: string,
  config: ModelMapConfig | undefined,
): OpenCodeGoHalf {
  if (!config) return 'go';
  for (const entry of Object.values(config.modelMap ?? {})) {
    if (entry?.modelId === modelId) return entry.provider ?? 'go';
  }
  for (const list of Object.values(config.fallbacks ?? {})) {
    for (const entry of list ?? []) {
      if (entry?.modelId === modelId) return entry.provider ?? 'go';
    }
  }
  return 'go';
}
