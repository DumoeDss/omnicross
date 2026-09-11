/**
 * downstreamTargets.test.ts — the binding-target catalog rules
 * (downstream-selector-stability):
 *  - account-pool resources are never offered as a binding target;
 *  - a binding whose saved target matches nothing selectable gets a PRESERVING
 *    option carrying its target verbatim — the editor must never silently
 *    re-display a binding as the first selectable resource (the bug that
 *    rewrote targets to the Claude account pool whenever only the model
 *    mappings were edited);
 *  - a NEW draft starts with no preselected target.
 */

import { describe, expect, it } from 'vitest';

import type { GatewayBinding, GatewayBindingTarget } from '@/daemon/types';
import type { TFunction } from '@/shared/state/LocaleContext';

import {
  bindingFromDraft,
  buildResourceCatalog,
  canSave,
  draftFromBinding,
  newDraft,
  type DownstreamResourceOption,
} from '../DownstreamRoutesWorkspace';

/** A stub translator covering exactly the keys the catalog composes. */
const t: TFunction = (key, opts) => {
  if (key === 'upstreams.accountPool' && opts && typeof opts === 'object') {
    return `${String((opts as Record<string, unknown>)['provider'])} account pool`;
  }
  if (key === 'upstreams.downstreams.legacyTarget') return 'legacy target';
  if (key === 'accounts.provider.claude.title') return 'Claude';
  if (key === 'accounts.provider.opencodego.title') return 'OpenCodeGo';
  return key;
};

const option = (
  key: string,
  target: GatewayBindingTarget,
  label = key,
): DownstreamResourceOption => ({
  key,
  label,
  detail: target.providerId,
  target,
  egressProtocol: 'anthropic',
  modelSuggestions: [],
});

const binding = (target: GatewayBindingTarget, id = 'b1'): GatewayBinding => ({
  id,
  name: 'route',
  enabled: true,
  endpoint: 'messages',
  target,
  fallback: 'fail',
  modelMode: 'mapped',
  modelMappings: [{ source: '*', target: 'glm-5.3-flash' }],
});

// A resource list shaped like the page used to build: pools FIRST (the sort
// that made the old fallback always land on the Claude pool), then groups.
const RESOURCES = [
  option('pool:claude', { kind: 'account-pool', providerId: 'claude' }, 'Claude account pool'),
  option('pool:opencodego', { kind: 'account-pool', providerId: 'opencodego' }, 'OpenCodeGo account pool'),
  option('group:opencodego:opencodego', { kind: 'account-group', providerId: 'opencodego', group: 'opencodego' }, 'opencodego'),
  option('provider:z-ai', { kind: 'provider', providerId: 'z-ai' }, 'z-ai'),
];

describe('buildResourceCatalog', () => {
  it('never offers an account-pool resource as a binding target', () => {
    const catalog = buildResourceCatalog(RESOURCES, [], t);
    expect(catalog.map((resource) => resource.key)).toEqual([
      'group:opencodego:opencodego',
      'provider:z-ai',
    ]);
  });

  it('appends ONE preserving option per binding whose target matches nothing selectable', () => {
    const catalog = buildResourceCatalog(
      RESOURCES,
      [
        binding({ kind: 'account-pool', providerId: 'claude' }, 'legacy-pool'),
        binding({ kind: 'account-group', providerId: 'opencodego', group: 'opencodego' }, 'live-group'),
      ],
      t,
    );
    expect(catalog.filter((resource) => resource.key.startsWith('legacy:')).map((r) => r.key))
      .toEqual(['legacy:legacy-pool']);
    const legacy = catalog.find((resource) => resource.key === 'legacy:legacy-pool');
    // Target carried VERBATIM and labeled with the pool label the removed
    // option used to carry.
    expect(legacy?.target).toEqual({ kind: 'account-pool', providerId: 'claude' });
    expect(legacy?.label).toContain('Claude account pool');
    expect(legacy?.label).toContain('legacy target');
  });
});

describe('draftFromBinding (no silent re-targeting)', () => {
  it('shows a legacy pool binding as its OWN preserving option — never the first selectable resource', () => {
    const legacy = binding({ kind: 'account-pool', providerId: 'claude' }, 'legacy-pool');
    const catalog = buildResourceCatalog(RESOURCES, [legacy], t);
    const draft = draftFromBinding(legacy, catalog);
    expect(draft.resourceKey).toBe('legacy:legacy-pool');
    expect(draft.resourceKey).not.toBe(catalog[0]?.key);
  });

  it('an unmatched draft with no catalog entry stays EMPTY rather than borrowing another resource', () => {
    const legacy = binding({ kind: 'account-pool', providerId: 'claude' });
    const draft = draftFromBinding(legacy, RESOURCES.filter((r) => r.target.kind !== 'account-pool'));
    expect(draft.resourceKey).toBe('');
  });

  it('round-trips: saving through the preserving option keeps the target byte-identical', () => {
    const legacy = binding({ kind: 'account-pool', providerId: 'claude' }, 'legacy-pool');
    const catalog = buildResourceCatalog(RESOURCES, [legacy], t);
    const draft = draftFromBinding(legacy, catalog);
    const resource = catalog.find((item) => item.key === draft.resourceKey);
    expect(resource).toBeDefined();
    const saved = bindingFromDraft(draft, resource!, legacy);
    expect(saved.target).toEqual(legacy.target);
  });
});

describe('newDraft', () => {
  it('starts with NO preselected target and cannot be saved until one is picked', () => {
    const draft = { ...newDraft(), name: 'route' };
    expect(draft.resourceKey).toBe('');
    expect(canSave(draft)).toBe(false);
    expect(canSave({ ...draft, resourceKey: 'group:opencodego:opencodego' })).toBe(true);
  });
});
