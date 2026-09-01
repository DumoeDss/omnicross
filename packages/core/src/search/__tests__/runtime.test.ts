/**
 * The runtime facade: default assembly, host round-trip, and event privacy.
 *
 * These tests go through `createSearchRuntime` rather than the registry or the
 * orchestrator directly — a Phase-2 host and 阶段5's frontends only ever see
 * this surface, so it is the one that has to be sufficient on its own.
 */

import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderId,
  SearchResult,
  SearchRuntimeEvent,
} from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { HTTP_SEARCH_CAPABILITIES } from '../http';
import { hashSearchQuery } from '../orchestrator';
import { SearchRegistryError } from '../registry';
import { createSearchRuntime } from '../runtime';

const HOST_CAPABILITIES: SearchProviderCapabilities = {
  requiresApiKey: false,
  supportsRegion: true,
  supportsLanguage: true,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: false,
};

function hostContribution(
  id: SearchProviderId,
  search: SearchProviderContribution['provider']['search'],
): SearchProviderContribution {
  return {
    id,
    source: 'host',
    kind: 'local-browser',
    provider: { id, search },
    capabilities: HOST_CAPABILITIES,
  };
}

function stubResults(id: string): SearchResult[] {
  return [{ title: `From ${id}`, url: `https://example.com/${id}`, content: 'snippet' }];
}

describe('default assembly', () => {
  it('registers the builtin HTTP providers and describes them', () => {
    const runtime = createSearchRuntime();

    expect(runtime.listProviders()).toEqual([
      {
        id: 'http-bing',
        source: 'builtin',
        kind: 'http',
        capabilities: { ...HTTP_SEARCH_CAPABILITIES },
      },
      {
        id: 'http-duckduckgo',
        source: 'builtin',
        kind: 'http',
        capabilities: { ...HTTP_SEARCH_CAPABILITIES },
      },
    ]);
  });

  it('hands out descriptors that carry no provider instance and cannot be reached through', () => {
    const runtime = createSearchRuntime();

    const [descriptor] = runtime.listProviders();
    expect(Object.keys(descriptor).sort()).toEqual(['capabilities', 'id', 'kind', 'source']);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);

    descriptor.capabilities.requiresApiKey = true;
    expect(runtime.listProviders()[0].capabilities.requiresApiKey).toBe(false);
  });

  it('accepts an explicit contribution list, including an empty one', async () => {
    const empty = createSearchRuntime({ contributions: [] });

    expect(empty.listProviders()).toEqual([]);
    await expect(empty.search({ query: 'q' })).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
  });
});

describe('host contribution round-trip (Phase-2 readiness)', () => {
  it('registers, searches pinned, and unregisters through the facade alone', async () => {
    const search = vi.fn(async () => stubResults('acme'));
    const runtime = createSearchRuntime({ contributions: [] });

    runtime.registerContribution(hostContribution('acme:internal', search), { hostId: 'elftia' });
    expect(runtime.listProviders()).toEqual([
      {
        id: 'acme:internal',
        source: 'host',
        kind: 'local-browser',
        capabilities: { ...HOST_CAPABILITIES },
      },
    ]);

    const response = await runtime.search({ query: 'q', provider: 'acme:internal' });
    expect(response.providerId).toBe('acme:internal');
    expect(response.results).toEqual(stubResults('acme'));
    expect(search).toHaveBeenCalledTimes(1);

    expect(runtime.unregisterContribution('acme:internal')).toBe(true);
    expect(runtime.listProviders()).toEqual([]);
    await expect(runtime.search({ query: 'q', provider: 'acme:internal' })).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
  });

  it('denies a host override of a builtin unless the runtime was built to allow it', () => {
    const strict = createSearchRuntime();
    const shadow = hostContribution('http-bing', async () => []);

    expect(() => strict.registerContribution(shadow)).toThrow(SearchRegistryError);

    const permissive = createSearchRuntime({ allowBuiltinOverride: true });
    permissive.registerContribution(hostContribution('http-bing', async () => []));
    expect(permissive.listProviders()[0]).toMatchObject({ id: 'http-bing', source: 'host' });
  });

  it('puts a host provider into the auto-mode walk in registration order', async () => {
    const first = vi.fn(async () => {
      throw new SearchProviderError('timeout', 'slow');
    });
    const second = vi.fn(async () => stubResults('second'));
    const runtime = createSearchRuntime({
      contributions: [hostContribution('first', first)],
    });
    runtime.registerContribution(hostContribution('second', second));

    const response = await runtime.search({ query: 'q' });

    expect(response.providerId).toBe('second');
    expect(response.attempts.map((attempt) => attempt.providerId)).toEqual(['first', 'second']);
  });
});

describe('policy and options composition', () => {
  it('applies the runtime default policy to every search', async () => {
    const bing = vi.fn(async () => stubResults('bing'));
    const ddg = vi.fn(async () => stubResults('ddg'));
    const runtime = createSearchRuntime({
      contributions: [hostContribution('a', bing), hostContribution('b', ddg)],
      policy: { preferred: 'b' },
    });

    const response = await runtime.search({ query: 'q' });

    expect(response.providerId).toBe('b');
    expect(bing).not.toHaveBeenCalled();
  });

  it('lets a per-request pin override the default preference', async () => {
    const a = vi.fn(async () => stubResults('a'));
    const b = vi.fn(async () => stubResults('b'));
    const runtime = createSearchRuntime({
      contributions: [hostContribution('a', a), hostContribution('b', b)],
      policy: { preferred: 'b' },
    });

    const response = await runtime.search({ query: 'q', provider: 'a' });

    expect(response.providerId).toBe('a');
    expect(b).not.toHaveBeenCalled();
  });

  it('enforces a single-provider egress policy', async () => {
    const a = vi.fn(async () => {
      throw new SearchProviderError('timeout', 'slow');
    });
    const b = vi.fn(async () => stubResults('b'));
    const runtime = createSearchRuntime({
      contributions: [hostContribution('a', a), hostContribution('b', b)],
      policy: { fallbackEnabled: false },
    });

    await expect(runtime.search({ query: 'q' })).rejects.toMatchObject({ code: 'timeout' });
    // The query never reached the second provider — plan §11.3's whole point.
    expect(b).not.toHaveBeenCalled();
  });

  it('passes per-request options through to the provider and the result cap', async () => {
    const many = Array.from({ length: 8 }, (_unused, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      content: '',
    }));
    const search = vi.fn(async () => many);
    const runtime = createSearchRuntime({ contributions: [hostContribution('a', search)] });

    const response = await runtime.search({ query: 'q', options: { maxResults: 2, timeout: 999 } });

    expect(search).toHaveBeenCalledWith('q', { maxResults: 2, timeout: 999 });
    expect(response.results).toHaveLength(2);
  });
});

describe('event privacy and inertness', () => {
  it('emits events that carry no query text, URL, or result content', async () => {
    const query = 'qqx-distinctive-user-question';
    const events: SearchRuntimeEvent[] = [];
    const runtime = createSearchRuntime({
      contributions: [
        hostContribution('a', async () => {
          throw new SearchProviderError('parse_failed', 'markup drifted');
        }),
        hostContribution('b', async () => [
          { title: 'Confidential memo', url: 'https://intranet.example/memo', content: 'body' },
        ]),
      ],
      onEvent: (event) => events.push(event),
    });

    await runtime.search({ query });

    const serialized = JSON.stringify(events);
    for (const secret of ['qqx-distinctive', 'intranet.example', 'Confidential memo', 'body']) {
      expect(serialized).not.toContain(secret);
    }
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.queryHash === hashSearchQuery(query))).toBe(true);
  });

  it('completes the search when the listener throws every time', async () => {
    const onEvent = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const runtime = createSearchRuntime({
      contributions: [hostContribution('a', async () => stubResults('a'))],
      onEvent,
    });

    await expect(runtime.search({ query: 'q' })).resolves.toMatchObject({
      providerId: 'a',
      results: stubResults('a'),
    });
    expect(onEvent).toHaveBeenCalled();
  });

  it('stays silent when no listener is supplied', async () => {
    const runtime = createSearchRuntime({
      contributions: [hostContribution('a', async () => stubResults('a'))],
    });

    await expect(runtime.search({ query: 'q' })).resolves.toMatchObject({ providerId: 'a' });
  });
});

describe('module boundaries', () => {
  it('imports no Elftia package and no Electron', () => {
    // The `search/http` tree has its own version of this check; this one covers
    // the runtime modules beside it. Matching SPECIFIERS rather than prose lets
    // the documentation name Electron while explaining why it is not used.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const sources = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => readFileSync(`${root}/${entry.name}`, 'utf8'));
    expect(sources.length).toBe(6);

    const specifierPatterns = [
      /(?:^|\s)(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm,
      /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    const allowedBareImports = new Set([
      '@omnicross/contracts/search-types',
      '@omnicross/contracts/search-compat',
      '@omnicross/contracts/websearch-types',
    ]);

    const specifiers = sources.flatMap((source) =>
      specifierPatterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])),
    );
    // Guards against a silently non-matching regex passing this test vacuously.
    expect(specifiers.length).toBeGreaterThan(10);

    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/elftia|electron/i);
      if (specifier.startsWith('.')) continue;
      expect(allowedBareImports.has(specifier) || specifier.startsWith('node:')).toBe(true);
    }
  });
});
