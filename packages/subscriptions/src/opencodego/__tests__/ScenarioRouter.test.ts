/**
 * ScenarioRouter tests — long-context token boundary + custom threshold
 * overrides, plus the D3 keyword heuristics (`complex` / `think` / `background`)
 * ported from `_others/oc-go-cc/internal/router/scenarios.go`: per-scenario
 * detection, the reference priority order, the case-sensitive `antThinking`
 * marker, the background tool-blocker pre-scan, and the bounded `matchText` source.
 */

import { describe, expect, it } from 'vitest';

import type { SubscriptionRequestSummary } from '../../SubscriptionProviderRegistry';
import { resolveOpenCodeGoScenario } from '../ScenarioRouter';

/** Build a summary with bounded match-text and a (default) under-threshold token
 *  count, so the keyword checks run. */
function summaryWith(
  matchText: string[],
  estimatedInputTokens = 1000,
  messageCount = 1,
): SubscriptionRequestSummary {
  return { messageCount, estimatedInputTokens, matchText };
}

describe('resolveOpenCodeGoScenario — token threshold (long_context)', () => {
  it('returns default for short-context requests with no match text', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 1, estimatedInputTokens: 1000 },
      undefined,
    );
    expect(scenario).toBe('default');
  });

  it('returns long_context when token count exceeds default threshold', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 50, estimatedInputTokens: 85_000 },
      undefined,
    );
    expect(scenario).toBe('long_context');
  });

  it('boundary: token count exactly equals threshold triggers long_context', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 10, estimatedInputTokens: 80_000 },
      undefined,
    );
    expect(scenario).toBe('long_context');
  });

  it('boundary: token count one below threshold stays default', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 10, estimatedInputTokens: 79_999 },
      undefined,
    );
    expect(scenario).toBe('default');
  });

  it('honors user-configured threshold override', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 10, estimatedInputTokens: 25_000 },
      {
        authMethod: 'manual',
        status: 'configured',
        modelMap: {
          long_context: { modelId: 'minimax-m2.5', contextThreshold: 20_000 },
        },
      },
    );
    expect(scenario).toBe('long_context');
  });

  it('falls back to default when modelMap.long_context has no threshold', () => {
    const scenario = resolveOpenCodeGoScenario(
      { messageCount: 10, estimatedInputTokens: 50_000 },
      {
        authMethod: 'manual',
        status: 'configured',
        modelMap: {
          long_context: { modelId: 'minimax-m2.5' },
        },
      },
    );
    // No threshold in override → fall back to default 80,000 → still under
    expect(scenario).toBe('default');
  });
});

describe('resolveOpenCodeGoScenario — keyword detection (D3)', () => {
  it('complex keyword auto-selects the complex scenario', () => {
    expect(resolveOpenCodeGoScenario(summaryWith(['refactor this module']), undefined)).toBe(
      'complex',
    );
  });

  it('think keyword auto-selects the think scenario', () => {
    expect(
      resolveOpenCodeGoScenario(summaryWith(['think step by step about this']), undefined),
    ).toBe('think');
  });

  it('antThinking content marker (exact case) auto-selects think', () => {
    // Mirrors the reference's case-SENSITIVE `strings.Contains(Content,
    // "antThinking")` content-block check.
    expect(
      resolveOpenCodeGoScenario(summaryWith(['<antThinking>private reasoning</antThinking>']), undefined),
    ).toBe('think');
  });

  it('the marker check itself is case-sensitive (a non-exact-case marker misses the marker path)', () => {
    // To isolate the case-SENSITIVE marker path the slice must NOT also trip the
    // lowercase keyword scan. The literal `antThinking` lowercases to
    // `antthinking`, which contains the substring `think` — so the keyword scan
    // would catch it regardless of the marker. We therefore use the probe string
    // `'ANT HINKING marker only'`: it is neither the exact-case marker
    // `antThinking` (the case-sensitive check fails) NOR does its lowercase form
    // (`ant hinking marker only`) contain `think`/`thinking`/any keyword → it
    // must fall through to `default`.
    expect(resolveOpenCodeGoScenario(summaryWith(['ANT HINKING marker only']), undefined)).toBe(
      'default',
    );
    // The exact-case marker, by contrast, fires (via the case-sensitive marker
    // path; its lowercase form would also satisfy the keyword scan):
    expect(resolveOpenCodeGoScenario(summaryWith(['antThinking']), undefined)).toBe('think');
  });

  it('simple read-style request auto-selects background', () => {
    expect(resolveOpenCodeGoScenario(summaryWith(['what is the status here']), undefined)).toBe(
      'background',
    );
  });

  it('background keyword + tool-blocker is NOT background', () => {
    // "show file" is a background keyword, but "write" is a tool-blocker → the
    // pre-scan vetoes background. No complex/think keyword present → default.
    expect(resolveOpenCodeGoScenario(summaryWith(['show file then write the result']), undefined)).toBe(
      'default',
    );
  });

  it('tool-blocker that is also a complex keyword falls through to complex', () => {
    // "what is this — now edit file" matches complex ("edit file") FIRST, so the
    // background veto never gets a turn; the higher-priority complex wins.
    expect(
      resolveOpenCodeGoScenario(summaryWith(['what is this — now edit file foo']), undefined),
    ).toBe('complex');
  });

  it('no keyword falls back to default', () => {
    expect(resolveOpenCodeGoScenario(summaryWith(['hello there, nice weather']), undefined)).toBe(
      'default',
    );
  });
});

describe('resolveOpenCodeGoScenario — priority order (mirrors DetectScenario)', () => {
  it('complex outranks think when both keywords present', () => {
    expect(
      resolveOpenCodeGoScenario(summaryWith(['please refactor and think step by step']), undefined),
    ).toBe('complex');
  });

  it('think outranks background when both present (think checked first)', () => {
    // "what is" (background) + "analyze" (think) → think wins.
    expect(
      resolveOpenCodeGoScenario(summaryWith(['what is this, analyze it for me']), undefined),
    ).toBe('think');
  });

  it('long_context outranks all keyword scenarios (token check runs first)', () => {
    // Over-threshold tokens AND a complex keyword → long_context still wins.
    expect(
      resolveOpenCodeGoScenario(summaryWith(['refactor this module'], 85_000, 50), undefined),
    ).toBe('long_context');
  });

  it('background IS auto-selectable from a background-keyword summary (D4→D3 handoff)', () => {
    // Replaces the retired D4 "NEVER auto-returns the dormant background scenario"
    // guard: D3 flips `background` from dormant to keyword-driven auto-selectable.
    // A clean read-style request (no tool-blocker) now routes to `background`.
    expect(resolveOpenCodeGoScenario(summaryWith(['tell me about the project']), undefined)).toBe(
      'background',
    );
    expect(resolveOpenCodeGoScenario(summaryWith(['check status of the build']), undefined)).not.toBe(
      'background',
    ); // "build" is a tool-blocker → vetoed (and a complex keyword → complex)
  });
});

describe('resolveOpenCodeGoScenario — graceful degrade (no/empty matchText)', () => {
  it('omitted matchText behaves as token-threshold + default', () => {
    expect(
      resolveOpenCodeGoScenario({ messageCount: 1, estimatedInputTokens: 1000 }, undefined),
    ).toBe('default');
    expect(
      resolveOpenCodeGoScenario({ messageCount: 1, estimatedInputTokens: 90_000 }, undefined),
    ).toBe('long_context');
  });

  it('empty matchText array yields no keyword match → default', () => {
    expect(resolveOpenCodeGoScenario(summaryWith([]), undefined)).toBe('default');
  });
});

describe('resolveOpenCodeGoScenario — bounded match-text source', () => {
  it('keyword inside the bounded slice matches', () => {
    // Simulates a summary the builder produced where the recent-message bound
    // INCLUDES the instruction carrying the keyword.
    expect(
      resolveOpenCodeGoScenario(summaryWith(['system prompt', 'please refactor the auth layer']), undefined),
    ).toBe('complex');
  });

  it('keyword the builder excluded from the bound does NOT match', () => {
    // Simulates the builder having dropped an out-of-bound (older / over-cap)
    // message: the keyword never reaches `matchText`, so the matcher cannot see
    // it and the request degrades to `default` (the documented safe failure mode).
    const boundedSummary = summaryWith(['recent harmless chit-chat', 'and more small talk']);
    expect(resolveOpenCodeGoScenario(boundedSummary, undefined)).toBe('default');
  });
});
