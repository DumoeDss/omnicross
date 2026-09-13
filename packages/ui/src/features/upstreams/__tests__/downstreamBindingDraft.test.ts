/**
 * `bindingFromDraft` key-scope regression — the routes-workspace draft editor
 * has NO key picker, so a freshly created binding must default to the resolver's
 * legacy `keyScope: 'all'`. The previous `'selected'` default minted bindings
 * with NO `apiKeyIds` — invisible to every client key (dead on arrival): the
 * route served nothing and `GET /v1/models` listed nothing from it, with no
 * warning anywhere in the UI.
 */

import { describe, expect, it } from 'vitest';

import type { GatewayBinding } from '@/daemon/types';

import {
  bindingFromDraft,
  type DownstreamResourceOption,
  newDraft,
} from '../DownstreamRoutesWorkspace';

const RESOURCE: DownstreamResourceOption = {
  key: 'provider:fake',
  label: 'Fake',
  detail: 'provider',
  target: { kind: 'provider', providerId: 'fake' },
  egressProtocol: 'openai',
  modelSuggestions: [],
};

function draft(over: Partial<ReturnType<typeof newDraft>> = {}): ReturnType<typeof newDraft> {
  return {
    ...newDraft(),
    name: 'route',
    resourceKey: RESOURCE.key,
    ...over,
  };
}

describe('bindingFromDraft key scope', () => {
  it('a NEW binding serves every key (all scope, no ids) — never dead on arrival', () => {
    const binding = bindingFromDraft(draft(), RESOURCE);
    expect(binding.keyScope).toBe('all');
    expect(binding.apiKeyIds).toBeUndefined();
  });

  it('inherits an existing binding scope and ids when editing', () => {
    const previous: GatewayBinding = {
      id: 'b1',
      name: 'route',
      enabled: true,
      keyScope: 'selected',
      apiKeyIds: ['oak_1'],
      endpoint: 'messages',
      target: { kind: 'provider', providerId: 'fake' },
      fallback: 'fail',
      modelMode: 'passthrough',
    };
    const binding = bindingFromDraft(draft({ id: 'b1' }), RESOURCE, previous);
    expect(binding.keyScope).toBe('selected');
    expect(binding.apiKeyIds).toEqual(['oak_1']);
  });

  it('an explicitly all-scoped previous binding stays all', () => {
    const previous: GatewayBinding = {
      id: 'b1',
      name: 'route',
      enabled: true,
      keyScope: 'all',
      endpoint: 'messages',
      target: { kind: 'provider', providerId: 'fake' },
      fallback: 'fail',
      modelMode: 'passthrough',
    };
    const binding = bindingFromDraft(draft({ id: 'b1' }), RESOURCE, previous);
    expect(binding.keyScope).toBe('all');
    expect(binding.apiKeyIds).toBeUndefined();
  });
});
