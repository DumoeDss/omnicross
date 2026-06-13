/**
 * ScenarioRouter — pick the OpenCodeGo scenario for an incoming request.
 *
 * Mirrors the reference `DetectScenario`
 * (`_others/oc-go-cc/internal/router/scenarios.go`). Priority order (first match
 * wins): `long_context` (token-count over threshold) → `complex` → `think` →
 * `background` → `default`. The token check is text-free; the three keyword
 * checks run only when the request is UNDER the long-context threshold and scan
 * a BOUNDED text slice (`summary.matchText` — the system prompt + most recent
 * user/system messages, per-message-capped by the builders) rather than the full
 * concatenated history.
 *
 * This is an inherently HEURISTIC, documented-substring match (case-insensitive
 * except the `antThinking` content marker, which is case-sensitive as in the
 * reference). It is faithfully mirrored — not "improved": the keyword lists are
 * crude and have known false positives (e.g. `complex`'s `"create"`/`"build"`).
 * The streaming `fast` preference (`RouteForStreaming`) is intentionally NOT
 * ported here — DEFERRED per design.md §4 (no `isStream` is threaded into this
 * resolver).
 */

import type { OpenCodeGoScenario, OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';

import type { SubscriptionRequestSummary } from '../SubscriptionProviderRegistry';

import { DEFAULT_OPENCODEGO_LONG_CONTEXT_THRESHOLD } from './defaults';

// ── Keyword tables (verbatim from `scenarios.go`) ───────────────────────────
// Source: `_others/oc-go-cc/internal/router/scenarios.go`
// `hasComplexPattern` (scenarios.go:93-117), `hasThinkingPattern`
// (scenarios.go:121-142), `hasBackgroundPattern` (scenarios.go:147-181).

/** Complex operations needing a more capable model (architectural + tool-related). */
const COMPLEX_KEYWORDS: readonly string[] = [
  // Architectural
  'architect',
  'architecture',
  'refactor',
  'redesign',
  'complex',
  'difficult',
  'challenging',
  'optimize',
  'performance',
  'efficiency',
  'design pattern',
  'best practice',
  // Tool-related keywords indicate complex operations
  'execute',
  'run command',
  'bash',
  'shell',
  'implement',
  'build',
  'create',
  'add feature',
  'write to',
  'edit file',
  'create file',
];

/** Reasoning / thinking keywords. */
const THINKING_KEYWORDS: readonly string[] = [
  'think',
  'thinking',
  'plan',
  'reason',
  'reasoning',
  'analyze',
  'analysis',
  'step by step',
];

/** Case-SENSITIVE content marker for thinking content blocks (no `ToLower` in
 *  the reference — `strings.Contains(msg.Content, "antThinking")`). */
const ANT_THINKING_MARKER = 'antThinking';

/** If ANY of these appear, the request is NOT a background task (tool-blocker
 *  pre-scan — checked before the positive background keywords). */
const TOOL_BLOCKERS: readonly string[] = [
  'tool',
  'function',
  'execute',
  'run command',
  'write',
  'edit',
  'create',
  'delete',
  'remove',
  'implement',
  'build',
  'add',
  'modify',
];

/** Truly-simple operations that qualify as background tasks. */
const BACKGROUND_KEYWORDS: readonly string[] = [
  'list directory',
  'ls -',
  'dir',
  'show file',
  'view file',
  'cat file',
  'what is',
  "what's",
  'tell me about',
  'check status',
  'show status',
];

/** Lowercase each bounded text slice once, for case-insensitive matching. */
function toLowerSlices(matchText: string[] | undefined): string[] {
  if (!matchText || matchText.length === 0) return [];
  return matchText.map((s) => s.toLowerCase());
}

/** True if any lowered slice contains any of the (lowercase) keywords. */
function containsAny(loweredSlices: string[], keywords: readonly string[]): boolean {
  for (const slice of loweredSlices) {
    for (const kw of keywords) {
      if (slice.includes(kw)) return true;
    }
  }
  return false;
}

/** Complex pattern — architectural OR tool-related keyword present. */
function hasComplexPattern(loweredSlices: string[]): boolean {
  return containsAny(loweredSlices, COMPLEX_KEYWORDS);
}

/** Thinking pattern — a reasoning keyword (case-insensitive) OR the
 *  case-SENSITIVE `antThinking` content marker. */
function hasThinkingPattern(loweredSlices: string[], rawSlices: string[]): boolean {
  if (containsAny(loweredSlices, THINKING_KEYWORDS)) return true;
  for (const slice of rawSlices) {
    if (slice.includes(ANT_THINKING_MARKER)) return true;
  }
  return false;
}

/** Background pattern — NO tool-blocker keyword AND ≥1 background keyword.
 *  Conservative by design: any tool mention vetoes background. */
function hasBackgroundPattern(loweredSlices: string[]): boolean {
  if (containsAny(loweredSlices, TOOL_BLOCKERS)) return false;
  return containsAny(loweredSlices, BACKGROUND_KEYWORDS);
}

/**
 * Resolve the OpenCodeGo scenario for a request summary. Callers already hold a
 * tokenized body; the bounded match text rides on `summary.matchText`.
 */
export function resolveOpenCodeGoScenario(
  summary: SubscriptionRequestSummary,
  config: OpenCodeGoTokenConfig | undefined,
): OpenCodeGoScenario {
  const longContextThreshold =
    config?.modelMap?.long_context?.contextThreshold ??
    DEFAULT_OPENCODEGO_LONG_CONTEXT_THRESHOLD;

  // 1. Long context first (token-only, text-free) — outranks every keyword check.
  if (summary.estimatedInputTokens >= longContextThreshold) {
    return 'long_context';
  }

  // 2-4. Keyword heuristics over the bounded match-text slice, in the reference
  //      priority order `complex → think → background`. When the summary carries
  //      no match text (caller omitted the optional field), all three degrade to
  //      no-match and we fall through to `default` — a graceful degrade that
  //      preserves the prior token-threshold-only behavior.
  const rawSlices = summary.matchText ?? [];
  const loweredSlices = toLowerSlices(summary.matchText);

  if (hasComplexPattern(loweredSlices)) return 'complex';
  if (hasThinkingPattern(loweredSlices, rawSlices)) return 'think';
  if (hasBackgroundPattern(loweredSlices)) return 'background';

  // 5. Default.
  return 'default';
}
