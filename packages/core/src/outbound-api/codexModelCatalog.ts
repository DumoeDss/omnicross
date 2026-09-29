/**
 * codexModelCatalog — build the Codex-native `ModelsResponse` document served
 * at the `model_catalog_url` the managed Codex integration points at.
 *
 * Codex (0.4x+) refreshes a command-auth provider's model catalog at runtime by
 * fetching that URL and merging the response into its bundled catalog by slug
 * (`models-manager`: `apply_remote_models` merges unless the fetch is
 * authoritative). The response must decode as `ModelsResponse` — the SAME
 * schema as `~/.codex/models_cache.json` / a `model_catalog_json` file — so
 * every non-`Option` `ModelInfo` field without a serde default must be present.
 * A decode failure is only a logged refresh error (Codex falls back to the
 * bundled catalog), but we still emit a minimal, schema-valid document.
 *
 * Model-name presentation (model-name-visibility): with `modelNaming.realNames`
 * OFF the route serves `{ models: [] }` — the merge leaves Codex's bundled
 * picker byte-identical to a pre-integration install. With it ON the route
 * serves one entry per REAL routable upstream model id, so terminal-launched
 * Codex shows the actual serving models next to the bundled ones.
 *
 * @module @omnicross/core/outbound-api/codexModelCatalog
 */

import type { ThinkLevel } from '@omnicross/contracts/completion-types';

/**
 * One real, name-addressable upstream model the catalog may advertise.
 * Metadata comes from the provider row's `modelConfigs` merged over the
 * canonical registry (the collector's job); all fields are optional so a
 * metadata-less id still yields a valid entry.
 */
export interface RealModelEntry {
  /** The REAL upstream model id — also the Codex `slug` (the picker's value). */
  readonly id: string;
  /** Human label; the raw id when unknown. */
  readonly displayName?: string;
  /** Context window in tokens (Codex `context_window`). */
  readonly contextWindow?: number;
  /** Supported thinking levels; unknown ⇒ the single-level fallback below. */
  readonly thinkingLevels?: readonly ThinkLevel[];
}

/** Short UI label for a shared thinking level (Codex `description` field). */
const LEVEL_DESCRIPTIONS: Record<string, string> = {
  none: 'No reasoning',
  minimal: 'Minimal reasoning',
  low: 'Low effort',
  medium: 'Balanced effort',
  high: 'Deep reasoning',
  xhigh: 'Extra-deep reasoning',
  max: 'Maximum reasoning',
};

/** The honest fallback when a model's thinking levels are unknown. */
const FALLBACK_THINKING_LEVELS: readonly ThinkLevel[] = ['medium'];

/**
 * Picker priority for generated entries. Codex sorts available models by
 * ascending `priority`; the bundled catalog centers around 0, so a distinctly
 * negative base puts the REAL upstream models at the top of the picker in the
 * collector's configured order (index adds back ordering stability).
 */
const PRIORITY_BASE = -100;

/** `TruncationPolicyConfig` for generated entries (token-bounded, generous). */
const TRUNCATION_POLICY = { mode: 'tokens' as const, limit: 8_000 };

/** Minimal mirror of Codex's `ModelInfo` — only fields the catalog sets. */
export interface CodexModelInfo {
  readonly slug: string;
  readonly display_name: string;
  readonly supported_reasoning_levels: ReadonlyArray<{
    effort: string;
    description: string;
  }>;
  readonly shell_type: 'unified_exec';
  readonly visibility: 'list';
  readonly supported_in_api: boolean;
  readonly priority: number;
  readonly support_verbosity: boolean;
  readonly truncation_policy: { mode: 'tokens'; limit: number };
  readonly experimental_supported_tools: readonly string[];
  /**
   * Required by Codex >= 0.156's ModelInfo deserializer. An empty string keeps
   * Codex's own prompt composition (the client logs a benign warning that the
   * model has neither base_instructions nor model_messages.instructions_template
   * and falls back to its built-in prompt).
   */
  readonly base_instructions: string;
  readonly context_window?: number;
  readonly default_reasoning_level?: string;
}

/** The `ModelsResponse` document: `{ models: [...] }`. */
export interface CodexModelCatalog {
  readonly models: readonly CodexModelInfo[];
}

/** The catalog served when real-name presentation is OFF — merge is a no-op. */
export const EMPTY_CODEX_MODEL_CATALOG: CodexModelCatalog = { models: [] };

/**
 * Build the Codex-native catalog from the collector's real-model entries.
 * Pure: no I/O, no clock — the same entries always produce the same document.
 */
export function buildCodexModelCatalog(entries: readonly RealModelEntry[]): CodexModelCatalog {
  if (entries.length === 0) return EMPTY_CODEX_MODEL_CATALOG;
  return {
    models: entries.map((entry, index) => {
      const levels = entry.thinkingLevels && entry.thinkingLevels.length > 0
        ? entry.thinkingLevels
        : FALLBACK_THINKING_LEVELS;
      const contextWindow =
        entry.contextWindow !== undefined && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
          ? entry.contextWindow
          : undefined;
      const defaultLevel = levels.includes('medium') ? 'medium' : levels[0];
      const info: CodexModelInfo = {
        slug: entry.id,
        display_name: entry.displayName?.trim() || entry.id,
        supported_reasoning_levels: levels.map((level) => ({
          effort: level,
          description: LEVEL_DESCRIPTIONS[level] ?? `${level} effort`,
        })),
        // The CLI-side shell tooling is provider-independent; unified_exec is
        // what every bundled entry ships.
        shell_type: 'unified_exec',
        visibility: 'list',
        supported_in_api: true,
        priority: PRIORITY_BASE + index,
        support_verbosity: false,
        truncation_policy: TRUNCATION_POLICY,
        experimental_supported_tools: [],
        base_instructions: '',
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(defaultLevel !== undefined ? { default_reasoning_level: defaultLevel } : {}),
      };
      return info;
    }),
  };
}
