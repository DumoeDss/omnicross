/**
 * rewriteBodyModel tests (subscription-account-model-map, task 3.3).
 *
 * The same-format relay rewrites the outbound `body.model` to the selected
 * account's ACTUAL model ONLY when a per-account remap was reported; a map-less /
 * array-form / no-mapping account reports `undefined` and the body is forwarded
 * BYTE-FOR-BYTE (never routed through this helper). The rewrite is parse-safe: an
 * unparseable or non-object body is returned unchanged so a remap never breaks a
 * relayable request.
 */

import { describe, expect, it } from 'vitest';

import { outboundRemapApplies, rewriteBodyModel } from '../anthropicSubscriptionPlan';

describe('outboundRemapApplies (remap is claude-scoped)', () => {
  it('applies to the claude subscription provider (model-independent upstream URL)', () => {
    expect(outboundRemapApplies({ isSubscription: true, transformerProvider: { name: 'claude' } })).toBe(true);
  });

  it('does NOT apply to opencodego (per-model URL — OQ3 deferred; skip-only still works)', () => {
    // An opencodego object-map account still routes via the allow-list, but its
    // body.model is NOT rewritten (its upstream URL was resolved from the logical
    // model, so a bare body rewrite would be a half-mismatch).
    expect(outboundRemapApplies({ isSubscription: true, transformerProvider: { name: 'opencodego' } })).toBe(false);
    expect(outboundRemapApplies({ isSubscription: true, transformerProvider: { name: 'codex' } })).toBe(false);
    expect(outboundRemapApplies({ isSubscription: true, transformerProvider: { name: 'gemini' } })).toBe(false);
  });

  it('does NOT apply to a BYO plan', () => {
    expect(outboundRemapApplies({ isSubscription: false, transformerProvider: { name: 'claude' } })).toBe(false);
  });
});

describe('rewriteBodyModel', () => {
  it('rewrites the model field of a JSON object body', () => {
    const body = JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'hi' }] });
    const out = JSON.parse(rewriteBodyModel(body, 'claude-opus-4-20250514'));
    expect(out.model).toBe('claude-opus-4-20250514');
    // Other fields are preserved.
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('adds a model field when absent (still a valid object body)', () => {
    const out = JSON.parse(rewriteBodyModel(JSON.stringify({ messages: [] }), 'actual-model'));
    expect(out.model).toBe('actual-model');
  });

  it('returns the raw body unchanged on unparseable / non-object input', () => {
    expect(rewriteBodyModel('not json', 'x')).toBe('not json');
    expect(rewriteBodyModel('[1,2,3]', 'x')).toBe('[1,2,3]');
    expect(rewriteBodyModel('"a string"', 'x')).toBe('"a string"');
  });
});
