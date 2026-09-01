/**
 * Registry semantics: conflict rules, lifecycle, and the one ordering answer.
 */

import type {
  SearchProvider,
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderId,
} from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { SearchProviderRegistry, SearchRegistryError } from '../registry';

const CAPABILITIES: SearchProviderCapabilities = {
  requiresApiKey: false,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
};

function fakeProvider(id: SearchProviderId): SearchProvider {
  return { id, search: async () => [] };
}

function contribution(
  id: SearchProviderId,
  overrides: Partial<SearchProviderContribution> = {},
): SearchProviderContribution {
  return {
    id,
    source: 'builtin',
    kind: 'http',
    provider: fakeProvider(id),
    capabilities: CAPABILITIES,
    ...overrides,
  };
}

describe('SearchProviderRegistry — conflict rules', () => {
  it('rejects a blank id', () => {
    const registry = new SearchProviderRegistry();

    expect(() => registry.register(contribution(''))).toThrow(SearchRegistryError);
    expect(() => registry.register(contribution('   '))).toThrow(/non-blank id/);
    expect(registry.list()).toEqual([]);
  });

  it('rejects a duplicate id and leaves the original registration intact', () => {
    const registry = new SearchProviderRegistry();
    const first = contribution('http-bing');
    registry.register(first);

    const second = contribution('http-bing');
    expect(() => registry.register(second)).toThrow(SearchRegistryError);
    expect(() => registry.register(second)).toThrow(/already registered/);

    expect(registry.get('http-bing')).toBe(first);
    expect(registry.list()).toHaveLength(1);
  });

  it('denies a host override of a builtin by default', () => {
    const registry = new SearchProviderRegistry();
    const builtin = contribution('http-bing');
    registry.register(builtin);

    const host = contribution('http-bing', { source: 'host', kind: 'local-browser' });
    expect(() => registry.register(host)).toThrow(/allowBuiltinOverride/);
    expect(registry.get('http-bing')).toBe(builtin);
  });

  it('allows the same override when the registry was built with the admin flag', () => {
    const registry = new SearchProviderRegistry({ allowBuiltinOverride: true });
    registry.register(contribution('http-bing'));

    const host = contribution('http-bing', { source: 'host', kind: 'local-browser' });
    registry.register(host);

    expect(registry.get('http-bing')).toBe(host);
    expect(registry.list()).toHaveLength(1);
  });

  it('does not let the admin flag excuse every collision', () => {
    const registry = new SearchProviderRegistry({ allowBuiltinOverride: true });
    registry.register(contribution('local-google', { source: 'host', kind: 'local-browser' }));

    // host-over-host is still a duplicate: the flag permits shadowing a
    // BUILTIN, which is the decision plan 7.2 gates, and nothing else.
    expect(() =>
      registry.register(contribution('local-google', { source: 'host', kind: 'local-browser' })),
    ).toThrow(/already registered/);

    // ...and so is builtin-over-host.
    expect(() => registry.register(contribution('local-google'))).toThrow(/already registered/);
  });

  it('throws SearchRegistryError, never a taxonomy-coded search error', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('http-bing'));

    let thrown: unknown;
    try {
      registry.register(contribution('http-bing'));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SearchRegistryError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(SearchProviderError);
    // A registration bug must never wear a code a fallback policy can act on.
    expect((thrown as { code?: unknown }).code).toBeUndefined();
    expect((thrown as Error).name).toBe('SearchRegistryError');
  });

  it('decides on declared fields, never on how an id is spelled', () => {
    const registry = new SearchProviderRegistry();

    // `local-`-prefixed but declared builtin, and `http-`-prefixed but declared
    // host: if any rule read the prefix, these two would swap behavior.
    registry.register(contribution('local-google', { source: 'builtin', kind: 'http' }));
    registry.register(contribution('http-elsewhere', { source: 'host', kind: 'api' }));

    const overridable = new SearchProviderRegistry({ allowBuiltinOverride: true });
    overridable.register(contribution('local-google', { source: 'builtin', kind: 'http' }));
    overridable.register(contribution('local-google', { source: 'host', kind: 'local-browser' }));

    expect(registry.list().map((entry) => entry.id)).toEqual(['local-google', 'http-elsewhere']);
    expect(overridable.get('local-google')?.source).toBe('host');
  });

  it('accepts a registration context without letting it change any rule', () => {
    const registry = new SearchProviderRegistry();

    registry.register(contribution('local-google', { source: 'host' }), { hostId: 'elftia' });
    expect(registry.has('local-google')).toBe(true);

    // A different host is not a different namespace — ids are global.
    expect(() =>
      registry.register(contribution('local-google', { source: 'host' }), { hostId: 'other' }),
    ).toThrow(SearchRegistryError);
  });
});

describe('SearchProviderRegistry — lifecycle and ordering', () => {
  it('round-trips an unregister', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('tavily'));

    expect(registry.unregister('tavily')).toBe(true);
    expect(registry.has('tavily')).toBe(false);
    expect(registry.get('tavily')).toBeUndefined();

    // The id is free again — a host that reconnects re-registers cleanly.
    expect(() => registry.register(contribution('tavily'))).not.toThrow();
    expect(registry.has('tavily')).toBe(true);
  });

  it('reports an unknown unregister as false instead of throwing', () => {
    const registry = new SearchProviderRegistry();
    expect(registry.unregister('never-registered')).toBe(false);
  });

  it('orders by priorityHint, then by registration order', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('hint-2', { priorityHint: 2 }));
    registry.register(contribution('unhinted-first'));
    registry.register(contribution('hint-1', { priorityHint: 1 }));
    registry.register(contribution('unhinted-second'));

    expect(registry.list().map((entry) => entry.id)).toEqual([
      'hint-1',
      'hint-2',
      'unhinted-first',
      'unhinted-second',
    ]);
  });

  it('breaks a tie on equal hints with registration order', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('second', { priorityHint: 5 }));
    registry.register(contribution('first', { priorityHint: 5 }));

    expect(registry.list().map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('keeps registration order for the hintless builtin HTTP contributions', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('http-bing'));
    registry.register(contribution('http-duckduckgo'));

    expect(registry.list().map((entry) => entry.id)).toEqual(['http-bing', 'http-duckduckgo']);
    expect(registry.list().every((entry) => entry.priorityHint === undefined)).toBe(true);
  });

  it('gives a re-registered id the position of its new registration', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('a'));
    registry.register(contribution('b'));

    registry.unregister('a');
    registry.register(contribution('a'));

    expect(registry.list().map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('lets an override replace a builtin in place rather than demoting it', () => {
    const registry = new SearchProviderRegistry({ allowBuiltinOverride: true });
    registry.register(contribution('http-bing'));
    registry.register(contribution('http-duckduckgo'));

    const shadow = contribution('http-bing', { source: 'host', kind: 'local-browser' });
    registry.register(shadow);

    // Substituting an implementation must not silently reorder the fallback
    // walk — the shadowed provider keeps the slot it had.
    expect(registry.list().map((entry) => entry.id)).toEqual(['http-bing', 'http-duckduckgo']);
    expect(registry.get('http-bing')).toBe(shadow);
  });

  it('hands out a mutable snapshot, not the live ordering', () => {
    const registry = new SearchProviderRegistry();
    registry.register(contribution('http-bing'));

    const listed = registry.list();
    listed.pop();

    expect(registry.list()).toHaveLength(1);
  });
});
