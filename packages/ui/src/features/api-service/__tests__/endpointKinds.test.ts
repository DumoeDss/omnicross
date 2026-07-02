/**
 * endpointKinds tests — the model-KIND vocabulary mirror + the client-side
 * completeness derivation that drives the routing editor's per-kind pickers and
 * the "service can't start" banner (model-kind-mapping surface).
 *
 * Covers: the kind counts (4 messages / 2 responses; none for chat/gemini), the
 * kind-mapped narrowing, per-endpoint missing-kind derivation (blank/absent/
 * whitespace all count as missing), and the whole-config summary.
 */
import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_MODEL_KINDS,
  isKindMappedEndpoint,
  missingKindsByEndpoint,
  missingKindsForEndpoint,
  modelKindsForEndpoint,
} from '../endpointKinds';

import type { EndpointRoutingConfig } from '../../../daemon/types';

describe('ENDPOINT_MODEL_KINDS vocabulary', () => {
  it('declares four messages kinds and two responses kinds', () => {
    // DRIFT GUARD: this UI mirror must match core's `@omnicross/core` outbound-api
    // `ENDPOINT_MODEL_KINDS` SSOT. If core's kinds change, update the mirror in
    // endpointKinds.ts and this pin together (the ui package has no core dep).
    expect(ENDPOINT_MODEL_KINDS.messages).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(ENDPOINT_MODEL_KINDS.responses).toEqual(['codex', 'mini']);
    // The editor renders one picker per kind, so the count is load-bearing.
    expect(modelKindsForEndpoint('messages')).toHaveLength(4);
    expect(modelKindsForEndpoint('responses')).toHaveLength(2);
  });

  it('narrows only messages/responses as kind-mapped', () => {
    expect(isKindMappedEndpoint('messages')).toBe(true);
    expect(isKindMappedEndpoint('responses')).toBe(true);
    expect(isKindMappedEndpoint('chat')).toBe(false);
    expect(isKindMappedEndpoint('gemini')).toBe(false);
  });
});

describe('missingKindsForEndpoint', () => {
  it('returns every declared kind when the modelMap is absent', () => {
    const ep: EndpointRoutingConfig = { endpoint: 'messages', useSubscription: false };
    expect(missingKindsForEndpoint(ep)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('treats blank and whitespace-only refs as missing', () => {
    const ep: EndpointRoutingConfig = {
      endpoint: 'responses',
      modelMap: { codex: 'p,gpt-5-codex', mini: '   ' },
      useSubscription: false,
    };
    expect(missingKindsForEndpoint(ep)).toEqual(['mini']);
  });

  it('is empty when every declared kind has a non-blank ref', () => {
    const ep: EndpointRoutingConfig = {
      endpoint: 'responses',
      modelMap: { codex: 'p,gpt-5-codex', mini: 'p,gpt-5-mini' },
      useSubscription: false,
    };
    expect(missingKindsForEndpoint(ep)).toEqual([]);
  });

  it('ignores unknown extra keys and returns [] for role-based endpoints', () => {
    const kindMapped: EndpointRoutingConfig = {
      endpoint: 'messages',
      modelMap: { fable: 'a,b', opus: 'a,b', sonnet: 'a,b', haiku: 'a,b', bogus: 'x,y' },
      useSubscription: false,
    };
    expect(missingKindsForEndpoint(kindMapped)).toEqual([]);

    const roleBased: EndpointRoutingConfig = {
      endpoint: 'chat',
      defaultModel: '',
      backgroundModel: '',
      useSubscription: false,
    };
    expect(missingKindsForEndpoint(roleBased)).toEqual([]);
  });
});

describe('missingKindsByEndpoint', () => {
  it('summarizes only the incomplete kind-mapped endpoints', () => {
    const endpoints: EndpointRoutingConfig[] = [
      { endpoint: 'chat', defaultModel: '', backgroundModel: '', useSubscription: false },
      { endpoint: 'responses', modelMap: { codex: 'p,c', mini: 'p,m' }, useSubscription: false },
      { endpoint: 'messages', modelMap: { fable: 'p,f', opus: '', sonnet: 'p,s', haiku: '' }, useSubscription: false },
      { endpoint: 'gemini', defaultModel: '', backgroundModel: '', useSubscription: false },
    ];
    expect(missingKindsByEndpoint(endpoints)).toEqual([
      { endpoint: 'messages', missingKinds: ['opus', 'haiku'] },
    ]);
  });

  it('treats a fully-blank kind-mapped endpoint as UNUSED (no banner)', () => {
    const endpoints: EndpointRoutingConfig[] = [
      { endpoint: 'messages', modelMap: { fable: 'a,b', opus: 'a,b', sonnet: 'a,b', haiku: 'a,b' }, useSubscription: false },
      { endpoint: 'responses', modelMap: { codex: '', mini: '' }, useSubscription: false },
    ];
    expect(missingKindsByEndpoint(endpoints)).toEqual([]);
  });

  it('is empty when all kind-mapped endpoints are fully configured', () => {
    const endpoints: EndpointRoutingConfig[] = [
      { endpoint: 'messages', modelMap: { fable: 'a,b', opus: 'a,b', sonnet: 'a,b', haiku: 'a,b' }, useSubscription: false },
      { endpoint: 'responses', modelMap: { codex: 'a,b', mini: 'a,b' }, useSubscription: false },
    ];
    expect(missingKindsByEndpoint(endpoints)).toEqual([]);
  });
});
