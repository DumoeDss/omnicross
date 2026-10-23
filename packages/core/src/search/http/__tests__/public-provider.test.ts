import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchOrchestrator } from '../../orchestrator';
import { SearchProviderRegistry } from '../../registry';

import { builtinHttpSearchContributions } from '../contributions';
import { HttpPublicSearchProvider, type HttpPublicChildId } from '../HttpPublicSearchProvider';
import type { SearchHttpRequest, SearchHttpResource, SearchHttpTransport } from '../types';

function startpageRow(title: string, url: string): string {
  return `<div class="result"><a class="result-link" href="${url}"><h2>${title}</h2></a><p class="description">Startpage snippet</p></div>`;
}

function ecosiaRow(title: string, url: string): string {
  return `<article data-test-id="organic-result"><a href="${url}"><h2 data-test-id="result-title">${title}</h2></a><p data-test-id="web-result-description">Ecosia snippet</p></article>`;
}

function mojeekRow(title: string, url: string): string {
  return `<ul class="results-standard"><li><h2><a class="title" href="${url}">${title}</a></h2><p class="s">Mojeek snippet</p></li></ul>`;
}

function page(url: string, html: string): SearchHttpResource {
  return { finalUrl: url, rawText: html, status: 200, contentType: 'text/html' };
}

afterEach(() => { vi.useRealTimers(); });

describe('public aggregate host policy', () => {
  it('fails closed without an explicit child allow-list, even with a working transport', async () => {
    const transport = vi.fn<SearchHttpTransport>();
    await expect(new HttpPublicSearchProvider(transport).search('example')).rejects.toMatchObject({
      code: 'config_missing', providerId: 'public',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('reads enabled children on each search and never contacts disabled engines', async () => {
    const calls: string[] = [];
    let enabled: readonly HttpPublicChildId[] = ['http-startpage'];
    const transport: SearchHttpTransport = async (url, request) => {
      calls.push(request.providerId ?? '');
      return page(url, request.providerId === 'http-startpage'
        ? startpageRow('Startpage', 'https://source.example/startpage')
        : ecosiaRow('Ecosia', 'https://source.example/ecosia'));
    };
    const aggregate = new HttpPublicSearchProvider(transport, { allowedChildIds: () => enabled });
    expect((await aggregate.search('example'))[0].title).toBe('Startpage');
    enabled = ['http-ecosia'];
    expect((await aggregate.search('example'))[0].title).toBe('Ecosia');
    enabled = [];
    await expect(aggregate.search('example')).rejects.toMatchObject({ code: 'config_missing' });
    expect(calls).toEqual(['http-startpage', 'http-ecosia']);
  });

  it('intersects host children with per-request runtime policy, ignoring widening through caller options', async () => {
    const calls: string[] = [];
    const transport: SearchHttpTransport = async (url, request) => {
      calls.push(request.providerId ?? '');
      return page(url, '<ol id="b_results"><li class="b_algo"><h2><a href="https://source.example/">Example source</a></h2><p>Actual source snippet</p></li></ol>');
    };
    const registry = new SearchProviderRegistry();
    for (const contribution of builtinHttpSearchContributions(transport, {
      allowedChildIds: ['http-bing', 'http-duckduckgo'],
    })) {
      registry.register(contribution);
    }
    const orchestrator = new SearchOrchestrator(registry, {
      policy: { allowed: ['public', 'http-bing', 'http-duckduckgo'] },
    });
    const options = {
      maxResults: 3,
      allowedProviderIds: ['public', 'http-bing', 'http-duckduckgo'],
      allowedChildIds: ['http-bing', 'http-duckduckgo'],
    };
    await expect(orchestrator.search({
      query: 'example', provider: 'public', options,
    }, { allowed: ['public'] })).rejects.toMatchObject({
      code: 'policy_denied', providerId: 'public',
    });
    expect(calls).toEqual([]);

    const response = await orchestrator.search({
      query: 'example', provider: 'public', options,
    }, { allowed: ['public', 'http-bing'] });
    expect(response.providerId).toBe('public');
    expect(response.results.map((result) => result.url)).toEqual(['https://source.example/']);
    expect(calls).toEqual(['http-bing']);
  });

  it('does not let runtime context enable a child absent from the configured host allow-list', async () => {
    const transport = vi.fn<SearchHttpTransport>();
    const aggregate = new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-bing'],
    });
    await expect(aggregate.search('example', {}, {
      allowedProviderIds: ['public', 'http-ecosia'],
    })).rejects.toMatchObject({ code: 'policy_denied', providerId: 'public' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses all five Node HTTP engines when explicitly allowed, without a browser path', async () => {
    const calls: string[] = [];
    const transport: SearchHttpTransport = async (url, request) => {
      calls.push(request.providerId ?? '');
      switch (request.providerId) {
        case 'http-bing':
          return page(url, readFileSync(new URL('../../../../test-fixtures/http-search/bing/bing-serp-normal.html', import.meta.url), 'utf8'));
        case 'http-duckduckgo':
          return page(url, readFileSync(new URL('../../../../test-fixtures/http-search/duckduckgo/ddg-html-serp.html', import.meta.url), 'utf8'));
        case 'http-startpage': return page(url, startpageRow('Startpage', 'https://source.example/startpage'));
        case 'http-ecosia': return page(url, ecosiaRow('Ecosia', 'https://source.example/ecosia'));
        case 'http-mojeek': return page(url, mojeekRow('Mojeek', 'https://source.example/mojeek'));
        default: throw new Error('unexpected provider');
      }
    };
    const allowedChildIds: HttpPublicChildId[] = ['http-bing', 'http-duckduckgo', 'http-startpage', 'http-ecosia', 'http-mojeek'];
    const aggregate = builtinHttpSearchContributions(transport, { allowedChildIds }).find((entry) => entry.id === 'public');
    expect((await aggregate!.provider.search('mozilla developer network http headers', { maxResults: 10 })).length).toBeGreaterThan(0);
    expect(calls).toEqual(allowedChildIds);
  });
});

describe('public result fusion', () => {
  it('ranks consensus above isolated hits and deduplicates fragments/tracking query parameters', async () => {
    const transport: SearchHttpTransport = async (url, request) => {
      if (request.providerId === 'http-startpage') {
        return page(url,
          startpageRow('Isolated', 'https://source.example/isolated') +
          startpageRow('Consensus', 'https://source.example/shared?utm_source=startpage#part') +
          startpageRow('Duplicate vote', 'https://source.example/shared?utm_source=again'));
      }
      if (request.providerId === 'http-ecosia') {
        return page(url,
          ecosiaRow('Consensus again', 'https://source.example/shared?fbclid=tracking') +
          ecosiaRow('Other consensus', 'https://source.example/other'));
      }
      return page(url,
        mojeekRow('Other consensus', 'https://source.example/other#part') +
        mojeekRow('Consensus third', 'https://source.example/shared'));
    };
    const aggregate = new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage', 'http-ecosia', 'http-mojeek'],
    });
    const results = await aggregate.search('example', { maxResults: 2 });
    expect(results.map((result) => result.url)).toEqual(['https://source.example/shared', 'https://source.example/other']);
    expect(results[0].title).toBe('Consensus');
  });

  it('keeps successful source rows when another engine is blocked or returns an empty shell', async () => {
    const transport: SearchHttpTransport = async (url, request) => {
      if (request.providerId === 'http-startpage') return page(url, '<title>Captcha</title>');
      if (request.providerId === 'http-mojeek') return page(url, '<ul class="results-standard"></ul>');
      return page(url, ecosiaRow('Actual source', 'https://source.example/'));
    };
    expect(await new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage', 'http-ecosia', 'http-mojeek'],
    }).search('example')).toEqual([
      { title: 'Actual source', url: 'https://source.example/', content: 'Ecosia snippet' },
    ]);
  });

  it('drops unresolved engine tracking links instead of presenting them as source URLs', async () => {
    const transport: SearchHttpTransport = async (url) => page(url,
      '<ol id="b_results">' +
      '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=invalid">Example wrapper</a></h2><p>Example</p></li>' +
      '<li class="b_algo"><h2><a href="https://source.example/">Example source</a></h2><p>Actual source snippet</p></li>' +
      '</ol>');
    const results = await new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-bing'],
    }).search('example');
    expect(results.map((result) => result.url)).toEqual(['https://source.example/']);
  });

  it('filters legacy-engine sources locally before fusion and the aggregate output limit', async () => {
    const transport: SearchHttpTransport = async (url) => page(url,
      '<ol id="b_results">' +
      '<li class="b_algo"><h2><a href="https://blocked.example/">Example blocked source</a></h2><p>Example</p></li>' +
      '<li class="b_algo"><h2><a href="https://sub.blocked.example/">Example blocked subdomain</a></h2><p>Example</p></li>' +
      '<li class="b_algo"><h2><a href="https://other.example/">Example other exclusion</a></h2><p>Example</p></li>' +
      '<li class="b_algo"><h2><a href="https://notblocked.example/">Example allowed source</a></h2><p>Actual source</p></li>' +
      '</ol>');
    const aggregate = new HttpPublicSearchProvider(transport, { allowedChildIds: ['http-bing'] });
    const results = await aggregate.search('example -site:blocked.example -site:other.example', { maxResults: 1 });
    expect(results.map((result) => result.url)).toEqual(['https://notblocked.example/']);
  });

  it('does not reintroduce excluded sources when every aggregate child hit is filtered', async () => {
    const transport: SearchHttpTransport = async (url) => page(url,
      '<ol id="b_results"><li class="b_algo"><h2><a href="https://sub.blocked.example/">Example blocked source</a></h2><p>Example</p></li></ol>');
    await expect(new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-bing'],
    }).search('example -site:blocked.example')).rejects.toMatchObject({
      code: 'upstream_unavailable', providerId: 'public',
    });
  });

  it('fails if no child produces usable source rows rather than inventing an answer', async () => {
    const transport: SearchHttpTransport = async (url) => page(url, '<html><main>Search</main></html>');
    await expect(new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage', 'http-ecosia'],
    }).search('example')).rejects.toMatchObject({ code: 'upstream_unavailable', providerId: 'public' });
  });
});

describe('public deadline and cancellation', () => {
  it('returns completed sources at the total deadline and aborts an uncooperative straggler', async () => {
    vi.useFakeTimers();
    let straggler: SearchHttpRequest | undefined;
    const transport: SearchHttpTransport = async (url, request) => {
      if (request.providerId === 'http-startpage') return page(url, startpageRow('Source', 'https://source.example/'));
      straggler = request;
      // Intentionally ignores cancellation: aggregate completion must not depend on cooperation.
      return new Promise<SearchHttpResource>(() => {});
    };
    const promise = new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage', 'http-ecosia'],
    }).search('example', { timeout: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toEqual([
      { title: 'Source', url: 'https://source.example/', content: 'Startpage snippet' },
    ]);
    expect(straggler?.timeoutMs).toBeLessThanOrEqual(50);
    expect(straggler?.signal?.aborted).toBe(true);
  });

  it('reports timeout, not cancellation, if the deadline produces no completed source rows', async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const transport: SearchHttpTransport = async (_url, request) => {
      childSignal = request.signal;
      return new Promise<SearchHttpResource>(() => {});
    };
    const promise = new HttpPublicSearchProvider(transport, { allowedChildIds: ['http-ecosia'] }).search('example', { timeout: 20 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout', providerId: 'public' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(childSignal?.aborted).toBe(true);
  });

  it('caller cancellation wins over partial success and aborts all unfinished engines', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const transport: SearchHttpTransport = async (url, request) => {
      if (request.signal) signals.push(request.signal);
      if (request.providerId === 'http-startpage') return page(url, startpageRow('Source', 'https://source.example/'));
      return new Promise<SearchHttpResource>(() => {});
    };
    const promise = new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage', 'http-ecosia'],
    }).search('example', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'cancelled', providerId: 'public' });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('never starts transport for an already-cancelled aggregate call', async () => {
    const transport = vi.fn<SearchHttpTransport>();
    await expect(new HttpPublicSearchProvider(transport, {
      allowedChildIds: ['http-startpage'],
    }).search('example', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
    expect(transport).not.toHaveBeenCalled();
  });
});
