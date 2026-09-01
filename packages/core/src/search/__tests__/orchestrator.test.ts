/**
 * The one fallback implementation: modes, policy knobs, and the walk semantics
 * that plan 阶段3 exists to make singular.
 */

import type {
  SearchOptions,
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderId,
  SearchResult,
  SearchRuntimeEvent,
} from '@omnicross/contracts/search-types';
import { SearchProviderError } from '@omnicross/contracts/search-types';
import { describe, expect, it, vi } from 'vitest';

import { SearchOrchestrator, hashSearchQuery } from '../orchestrator';
import { SearchProviderRegistry } from '../registry';

const CAPABILITIES: SearchProviderCapabilities = {
  requiresApiKey: false,
  supportsRegion: false,
  supportsLanguage: false,
  supportsTimeRange: false,
  supportsUrlRead: false,
  supportsCancellation: true,
};

interface FakeProviderSpec {
  /** What the provider resolves to, or the error it throws. */
  results?: SearchResult[];
  error?: unknown;
}

function hit(id: string): SearchResult {
  return { title: `Result from ${id}`, url: `https://example.com/${id}`, content: 'snippet' };
}

/** A contribution whose provider records its calls. */
function fake(
  id: SearchProviderId,
  spec: FakeProviderSpec = {},
  overrides: Partial<SearchProviderContribution> = {},
): SearchProviderContribution & { calls: { query: string; options?: SearchOptions }[] } {
  const calls: { query: string; options?: SearchOptions }[] = [];
  const contribution: SearchProviderContribution = {
    id,
    source: 'builtin',
    kind: 'http',
    capabilities: CAPABILITIES,
    provider: {
      id,
      async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        calls.push({ query, options });
        if (spec.error !== undefined) throw spec.error;
        return spec.results ?? [hit(id)];
      },
    },
    ...overrides,
  };
  return Object.assign(contribution, { calls });
}

function registryOf(...contributions: SearchProviderContribution[]): SearchProviderRegistry {
  const registry = new SearchProviderRegistry();
  for (const contribution of contributions) registry.register(contribution);
  return registry;
}

describe('pinned mode is strict', () => {
  it('attempts exactly the pinned provider and never another', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('parse_failed', 'bad html') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    await expect(orchestrator.search({ query: 'q', provider: 'http-bing' })).rejects.toMatchObject({
      code: 'parse_failed',
    });

    expect(bing.calls).toHaveLength(1);
    expect(ddg.calls).toHaveLength(0);
  });

  it('surfaces the pinned provider own error, diagnostics intact', async () => {
    const thrown = new SearchProviderError('upstream_unavailable', 'server returned a bot-challenge response (HTTP 202)', {
      providerId: 'http-duckduckgo',
      details: { stage: 'challenge', status: '202' },
    });
    const ddg = fake('http-duckduckgo', { error: thrown });
    const orchestrator = new SearchOrchestrator(registryOf(ddg));

    await expect(
      orchestrator.search({ query: 'q', provider: 'http-duckduckgo' }),
    ).rejects.toBe(thrown);
  });

  it('rejects an unregistered pin as upstream_unavailable without calling anyone', async () => {
    const bing = fake('http-bing');
    const orchestrator = new SearchOrchestrator(registryOf(bing));

    await expect(orchestrator.search({ query: 'q', provider: 'tavily' })).rejects.toMatchObject({
      code: 'upstream_unavailable',
      providerId: 'tavily',
    });
    expect(bing.calls).toHaveLength(0);
  });

  it('rejects a disallowed pin as policy_denied without calling anyone', async () => {
    const bing = fake('http-bing');
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { allowed: ['http-duckduckgo'] },
    });

    await expect(orchestrator.search({ query: 'q', provider: 'http-bing' })).rejects.toMatchObject({
      code: 'policy_denied',
      providerId: 'http-bing',
    });
    expect(bing.calls).toHaveLength(0);
    expect(ddg.calls).toHaveLength(0);
  });
});

describe('auto mode candidate order and policy knobs', () => {
  it('follows registry order by default', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    const response = await orchestrator.search({ query: 'q' });

    expect(response.providerId).toBe('http-duckduckgo');
    expect(response.attempts.map((attempt) => attempt.providerId)).toEqual([
      'http-bing',
      'http-duckduckgo',
    ]);
    expect(response.fallbackCount).toBe(1);
  });

  it('promotes a preferred provider to the front, keeping the rest in order', async () => {
    const bing = fake('http-bing');
    const ddg = fake('http-duckduckgo', { error: new SearchProviderError('timeout', 'slow') });
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { preferred: 'http-duckduckgo' },
    });

    const response = await orchestrator.search({ query: 'q' });

    expect(response.attempts.map((attempt) => attempt.providerId)).toEqual([
      'http-duckduckgo',
      'http-bing',
    ]);
    expect(response.providerId).toBe('http-bing');
  });

  it('truncates to one candidate when fallback is disabled', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { fallbackEnabled: false },
    });

    await expect(orchestrator.search({ query: 'q' })).rejects.toMatchObject({ code: 'timeout' });
    expect(ddg.calls).toHaveLength(0);
  });

  it('caps the walk at maxAttempts', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { maxAttempts: 1 },
    });

    await expect(orchestrator.search({ query: 'q' })).rejects.toMatchObject({ code: 'timeout' });
    expect(ddg.calls).toHaveLength(0);
  });

  it('restricts candidates to the allowed set, skipping a disallowed preference', async () => {
    const bing = fake('http-bing');
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { preferred: 'http-duckduckgo', allowed: ['http-bing'] },
    });

    const response = await orchestrator.search({ query: 'q' });

    expect(response.providerId).toBe('http-bing');
    expect(ddg.calls).toHaveLength(0);
  });

  it('treats an unknown preference as a soft signal, not an error', async () => {
    const bing = fake('http-bing');
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(bing), {
      policy: { preferred: 'tavily' },
      onEvent: (event) => events.push(event),
    });

    const response = await orchestrator.search({ query: 'q' });

    expect(response.providerId).toBe('http-bing');
    // Recorded as an event; never an attempt, so it cannot inflate the walk.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'search_attempt', providerId: 'tavily', outcome: 'failed' }),
    );
    expect(response.attempts.map((attempt) => attempt.providerId)).toEqual(['http-bing']);
    expect(response.fallbackCount).toBe(0);
  });

  it('merges a per-request policy over the default field by field', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      policy: { preferred: 'http-bing' },
    });

    const response = await orchestrator.search({ query: 'q' }, { fallbackEnabled: true, preferred: 'http-duckduckgo' });

    expect(response.providerId).toBe('http-duckduckgo');
    expect(bing.calls).toHaveLength(0);
  });

  it('reports an empty candidate set honestly instead of searching anyway', async () => {
    const bing = fake('http-bing');
    const orchestrator = new SearchOrchestrator(registryOf(bing), { policy: { maxAttempts: 0 } });

    await expect(orchestrator.search({ query: 'q' })).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: expect.stringContaining('0 attempts'),
    });
    expect(bing.calls).toHaveLength(0);
  });

  it('passes the request options to the provider untouched', async () => {
    const signal = new AbortController().signal;
    const bing = fake('http-bing');
    const orchestrator = new SearchOrchestrator(registryOf(bing));

    await orchestrator.search({ query: 'q', options: { maxResults: 3, timeout: 1_234, signal } });

    expect(bing.calls[0].options).toEqual({ maxResults: 3, timeout: 1_234, signal });
  });
});

describe('walk semantics', () => {
  it('stops on an empty result set and calls it a success', async () => {
    const bing = fake('http-bing', { results: [] });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    const response = await orchestrator.search({ query: 'q' });

    // The provider already walked ITS candidates to say "nothing found".
    expect(response.results).toEqual([]);
    expect(response.providerId).toBe('http-bing');
    expect(response.attempts).toEqual([
      { providerId: 'http-bing', outcome: 'success', resultCount: 0, durationMs: expect.any(Number) },
    ]);
    expect(response.fallbackCount).toBe(0);
    expect(ddg.calls).toHaveLength(0);
  });

  it('rethrows a cancellation immediately without spending another candidate', async () => {
    const cancelled = new SearchProviderError('cancelled', 'search was cancelled');
    const bing = fake('http-bing', { error: cancelled });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    await expect(orchestrator.search({ query: 'q' })).rejects.toBe(cancelled);
    expect(ddg.calls).toHaveLength(0);
  });

  it('stops the walk when the signal is aborted, even if the provider leaked a raw abort', async () => {
    // A non-conforming provider — it throws a bare AbortError instead of the
    // taxonomy `cancelled` the contract asks for. Without the signal check that
    // maps to `upstream_unavailable`, and the already-cancelled query would go
    // on to egress to the next provider.
    const rogue = fake('http-bing', {
      error: new DOMException('The operation was aborted', 'AbortError'),
    });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(rogue, ddg));

    let thrown: SearchProviderError | undefined;
    try {
      await orchestrator.search({ query: 'q', options: { signal: AbortSignal.abort() } });
    } catch (error) {
      thrown = error as SearchProviderError;
    }

    expect(thrown?.code).toBe('cancelled');
    expect(ddg.calls).toHaveLength(0);
    // The provider's own error is kept for diagnosis, not discarded.
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(DOMException);
  });

  it('records the aborted attempt as cancelled rather than as a transport failure', async () => {
    const rogue = fake('http-bing', { error: new Error('socket closed') });
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(rogue), {
      onEvent: (event) => events.push(event),
    });

    await expect(
      orchestrator.search({ query: 'q', options: { signal: AbortSignal.abort() } }),
    ).rejects.toMatchObject({ code: 'cancelled' });

    expect(events[0]).toMatchObject({
      type: 'search_attempt',
      providerId: 'http-bing',
      outcome: 'failed',
      errorCode: 'cancelled',
    });
  });

  it('leaves a failure alone when the signal is still live', async () => {
    const controller = new AbortController();
    const bing = fake('http-bing', { error: new Error('socket closed') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    const response = await orchestrator.search({
      query: 'q',
      options: { signal: controller.signal },
    });

    // An un-aborted signal must not turn ordinary failures into cancellations.
    expect(response.providerId).toBe('http-duckduckgo');
    expect(response.attempts[0].errorCode).toBe('upstream_unavailable');
  });

  it('continues past any other provider failure', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('parse_failed', 'drifted') });
    const ddg = fake('http-duckduckgo', { error: new SearchProviderError('timeout', 'slow') });
    const tavily = fake('tavily');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg, tavily));

    const response = await orchestrator.search({ query: 'q' });

    expect(response.providerId).toBe('tavily');
    expect(response.attempts.map((attempt) => attempt.errorCode)).toEqual([
      'parse_failed',
      'timeout',
      undefined,
    ]);
    expect(response.fallbackCount).toBe(2);
  });

  it('throws the last failure code with a compact sanitized trail on exhaustion', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('parse_failed', 'drifted') });
    const ddg = fake('http-duckduckgo', { error: new SearchProviderError('timeout', 'slow') });
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    let thrown: SearchProviderError | undefined;
    try {
      await orchestrator.search({ query: 'a very distinctive private query' });
    } catch (error) {
      thrown = error as SearchProviderError;
    }

    expect(thrown?.code).toBe('timeout');
    expect(thrown?.message).toContain('2 attempt(s)');
    expect(thrown?.details).toEqual({ attempts: 'http-bing:parse_failed,http-duckduckgo:timeout' });

    // Nothing about the query survives into an error a caller will log.
    const serialized = JSON.stringify({ message: thrown?.message, details: thrown?.details });
    expect(serialized).not.toContain('distinctive');
  });

  it('classifies a non-taxonomy throw as upstream_unavailable and keeps walking', async () => {
    const bing = fake('http-bing', { error: new TypeError('provider blew up') });
    const ddg = fake('http-duckduckgo');
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg));

    const response = await orchestrator.search({ query: 'q' });

    expect(response.attempts[0]).toMatchObject({
      providerId: 'http-bing',
      outcome: 'failed',
      errorCode: 'upstream_unavailable',
    });
    expect(response.providerId).toBe('http-duckduckgo');
  });

  it('normalizes the winning result set', async () => {
    const bing = fake('http-bing', {
      results: [
        { title: '  Padded  ', url: 'https://example.com/a', content: '  text  ' },
        { title: 'Redirect', url: 'https://www.bing.com/search?q=x', content: '' },
        { title: 'Duplicate', url: 'https://example.com/a', content: '' },
        { title: '', url: 'https://example.com/b', content: '' },
        { title: 'Second', url: 'https://example.com/b', content: '' },
      ],
    });
    const orchestrator = new SearchOrchestrator(registryOf(bing));

    const response = await orchestrator.search({ query: 'q', options: { maxResults: 10 } });

    expect(response.results).toEqual([
      { title: 'Padded', url: 'https://example.com/a', content: 'text' },
      { title: 'Second', url: 'https://example.com/b', content: '' },
    ]);
    expect(response.attempts[0].resultCount).toBe(2);
  });
});

describe('observability', () => {
  it('emits one attempt event per attempt and exactly one complete event', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const ddg = fake('http-duckduckgo');
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(bing, ddg), {
      onEvent: (event) => events.push(event),
    });

    await orchestrator.search({ query: 'q' });

    expect(events.map((event) => event.type)).toEqual([
      'search_attempt',
      'search_attempt',
      'search_complete',
    ]);
    // One requestId correlates the whole search.
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events[2]).toMatchObject({
      type: 'search_complete',
      providerId: 'http-duckduckgo',
      resultCount: 1,
      fallbackCount: 1,
    });
  });

  it('emits a complete event with no providerId when the search fails', async () => {
    const bing = fake('http-bing', { error: new SearchProviderError('timeout', 'slow') });
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(bing), {
      onEvent: (event) => events.push(event),
    });

    await expect(orchestrator.search({ query: 'q' })).rejects.toThrow();

    const complete = events.at(-1);
    expect(complete).toMatchObject({ type: 'search_complete', resultCount: 0 });
    // Absent providerId is what tells a failed search apart from an empty one.
    expect(complete).not.toHaveProperty('providerId');
  });

  it('distinguishes an authoritative empty answer by naming its provider', async () => {
    const bing = fake('http-bing', { results: [] });
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(bing), {
      onEvent: (event) => events.push(event),
    });

    await orchestrator.search({ query: 'q' });

    expect(events.at(-1)).toMatchObject({
      type: 'search_complete',
      providerId: 'http-bing',
      resultCount: 0,
    });
  });

  it('emits a complete event even when the pin is rejected before any attempt', async () => {
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(new SearchProviderRegistry(), {
      onEvent: (event) => events.push(event),
    });

    await expect(orchestrator.search({ query: 'q', provider: 'tavily' })).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'search_complete', resultCount: 0, fallbackCount: 0 });
  });

  it('carries a query hash and never the query itself', async () => {
    const query = 'zzq-unmistakable-private-search-string';
    const bing = fake('http-bing', {
      results: [{ title: 'Secret page', url: 'https://internal.example/secret', content: 'body' }],
    });
    const events: SearchRuntimeEvent[] = [];
    const orchestrator = new SearchOrchestrator(registryOf(bing), {
      onEvent: (event) => events.push(event),
    });

    await orchestrator.search({ query });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('zzq-unmistakable');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('Secret page');
    expect(events.every((event) => event.queryHash === hashSearchQuery(query))).toBe(true);
  });

  it('hashes deterministically, one-way, and short', () => {
    expect(hashSearchQuery('same')).toBe(hashSearchQuery('same'));
    expect(hashSearchQuery('same')).not.toBe(hashSearchQuery('different'));
    expect(hashSearchQuery('same')).toHaveLength(12);
    expect(hashSearchQuery('same')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('completes normally when the listener throws on every event', async () => {
    const bing = fake('http-bing');
    const onEvent = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const orchestrator = new SearchOrchestrator(registryOf(bing), { onEvent });

    const response = await orchestrator.search({ query: 'q' });

    expect(response.results).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
