/**
 * ScenarioRouter — pick the OpenCodeGo scenario for an incoming request.
 *
 * Priority order (first match wins): `long_context` (token-count over threshold)
 * → `complex` → `think` → `background` → `default`. The token check is text-free; the three keyword
 * checks run only when the request is UNDER the long-context threshold and scan
 * a BOUNDED text slice (`summary.matchText` — the system prompt + most recent
 * user/system messages, per-message-capped by the builders) rather than the full
 * concatenated history.
 *
 * This is an inherently heuristic substring match (case-insensitive except the
 * `antThinking` content marker, which is case-sensitive). The keyword lists are
 * crude and have known false positives (e.g. `complex`'s `"create"`/`"build"`).
 * A streaming-specific `fast` preference is intentionally deferred because no
 * `isStream` flag is threaded into this resolver.
 */

import type { OpenCodeGoScenario, OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';

import type { SubscriptionRequestSummary } from '../SubscriptionProviderRegistry';

import { DEFAULT_OPENCODEGO_LONG_CONTEXT_THRESHOLD } from './defaults';

// ── Bounded keyword tables used by Omnicross scenario selection ─────────────

/** Complex operations needing a more capable model (architectural + tool-related). */
const COMPLEX_KEYWORDS: readonly string[] = [
  'architecture',
  'refactor',
  'redesign',
  'optimize',
  'performance',
  'implement',
  'build',
  'edit file',
  'debug',
  'migrate',
  'benchmark',
];

/** Reasoning / thinking keywords. */
const THINKING_KEYWORDS: readonly string[] = [
  'think',
  'plan',
  'reason',
  'analyze',
  'step by step',
  'evaluate',
  'compare tradeoffs',
];

/** Case-sensitive content marker for thinking content blocks. */
const ANT_THINKING_MARKER = 'antThinking';

/** If ANY of these appear, the request is NOT a background task (tool-blocker
 *  pre-scan — checked before the positive background keywords). */
const TOOL_BLOCKERS: readonly string[] = [
  'tool',
  'function',
  'command',
  'write',
  'edit',
  'delete',
  'implement',
  'build',
  'modify',
];

/** Truly-simple operations that qualify as background tasks. */
const BACKGROUND_KEYWORDS: readonly string[] = [
  'list directory',
  'show file',
  'read file',
  'what is',
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

  // 2-4. Keyword heuristics over the bounded match-text slice, in the
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
