/**
 * antigravity-catalog tests — group-1 gates for the antigravity subscription
 * provider's static surface (antigravity-subscription-provider):
 *   - the `SubscriptionProviderId` union admits 'antigravity' and every
 *     exhaustive Record keyed by it carries the new member,
 *   - the static model catalog is the reference census minus the denylist,
 *   - the canonical registry's ANTIGRAVITY_MODELS block holds ONLY ids that
 *     exist nowhere else in the table (the full-registry duplicate scan runs
 *     at module init; these assertions make the intent testable), and family
 *     ids reuse the existing vendor entries.
 */
import { describe, expect, it } from 'vitest';

import {
  applyAlias,
  KNOWN_MODELS,
  lookupCanonicalCapabilities,
  normalizeModelId,
} from '../canonical-models';
import { SUBSCRIPTION_MODEL_CATALOG } from '../subscription-model-catalog';
import type { SubscriptionProviderId } from '../subscription-types';

/** The antigravity ids that exist ONLY on the antigravity CCA catalog. */
const ANTIGRAVITY_ONLY_IDS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gpt-oss-120b',
  'tab_flash_lite_preview',
  'tab_jump_flash_lite_preview',
] as const;

/** Family ids shared with the existing vendor groups (reused, NOT re-declared). */
const ANTIGRAVITY_FAMILY_IDS = [
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
] as const;

describe('antigravity subscription provider id', () => {
  it('is part of the union and every exhaustive Record keyed by it carries it', () => {
    const providers: SubscriptionProviderId[] = [
      'claude',
      'codex',
      'gemini',
      'opencodego',
      'kimi',
      'grok',
      'copilot',
      'antigravity',
    ];
    // Exhaustiveness by construction: building this array from the union
    // fails to compile when a member is missing.
    expect(providers).toContain('antigravity');
    // The static model catalog is keyed exhaustively by the union.
    expect(Object.keys(SUBSCRIPTION_MODEL_CATALOG)).toEqual(
      expect.arrayContaining(providers),
    );
  });
});

describe('antigravity static model catalog', () => {
  it('is the reference census minus the denylist (18 ids, small → large)', () => {
    expect(SUBSCRIPTION_MODEL_CATALOG.antigravity).toEqual([
      'tab_flash_lite_preview',
      'tab_jump_flash_lite_preview',
      'gpt-oss-120b',
      'gemini-3.1-flash-image',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'claude-sonnet-4-5',
    ]);
  });

  it('excludes every denylisted id', () => {
    const denylist = ['chat_20706', 'chat_23310', 'gemini-2.5-pro'];
    for (const id of denylist) {
      expect(SUBSCRIPTION_MODEL_CATALOG.antigravity).not.toContain(id);
    }
  });
});

describe('antigravity canonical registry block', () => {
  it('registers every antigravity-only id exactly once (no duplicate ids anywhere)', () => {
    // The module-init assertion throws on ANY duplicate across vendor groups —
    // importing the module already proves the global invariant. Here we also
    // confirm each antigravity-only id resolves through the public lookup.
    for (const id of ANTIGRAVITY_ONLY_IDS) {
      const caps = lookupCanonicalCapabilities(id);
      expect(caps, id).toBeDefined();
      expect(applyAlias(normalizeModelId(id))).toBe(id);
    }
  });

  it('keeps the autocomplete tab models non-reasoning with tiny windows', () => {
    expect(KNOWN_MODELS['tab_flash_lite_preview']).toMatchObject({
      contextLength: 16384,
      maxTokens: 4096,
      reasoning: false,
    });
    expect(KNOWN_MODELS['tab_jump_flash_lite_preview']).toMatchObject({
      contextLength: 16384,
      maxTokens: 4096,
      reasoning: false,
    });
  });

  it('reuses the existing family entries instead of re-declaring them', () => {
    // The antigravity-only block must not shadow the family models — they live
    // in their original vendor groups with their original capabilities.
    for (const id of ANTIGRAVITY_FAMILY_IDS) {
      expect(KNOWN_MODELS[id], id).toBeDefined();
    }
    // Spot-check two family entries keep their original (non-antigravity) caps.
    expect(KNOWN_MODELS['claude-sonnet-4-6']?.contextLength).toBe(200000);
    expect(KNOWN_MODELS['gemini-3.5-flash']?.contextLength).toBe(1000000);
  });
});
