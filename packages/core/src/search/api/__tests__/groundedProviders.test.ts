import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_WEB_SEARCH_TOOL,
  ClaudeSearchProvider,
} from '../ClaudeSearchProvider';
import { PerplexitySearchProvider } from '../PerplexitySearchProvider';
import { createSearchApiTransport } from '../transport';
import type { SearchApiFetch, SearchApiRequest, SearchApiTransport } from '../types';

const QUERY = 'current Mozilla HTTP documentation';
const URL_A = 'https://developer.mozilla.org/en-US/docs/Web/HTTP';
const URL_B = 'https://www.mozilla.org/en-US/';
const TITLE_A = 'HTTP | MDN';

function recordingTransport(...payloads: unknown[]): {
  calls: SearchApiRequest[];
  transport: SearchApiTransport;
} {
  const calls: SearchApiRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push({ ...request, jsonBody: structuredClone(request.jsonBody) });
      return payloads[Math.min(calls.length - 1, payloads.length - 1)];
    },
  };
}

function toolResult(url = URL_A, title = TITLE_A): Record<string, unknown> {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srv_1',
    content: [{ type: 'web_search_result', url, title, encrypted_content: 'opaque-not-a-snippet' }],
  };
}

function citedText(url = URL_A): Record<string, unknown> {
  return {
    type: 'text',
    text: 'Generated answer must not become a source snippet.',
    citations: [{ type: 'web_search_result_location', url, title: TITLE_A, cited_text: 'Actual cited passage.' }],
  };
}

const providers = [PerplexitySearchProvider, ClaudeSearchProvider] as const;

for (const Provider of providers) {
  describe(Provider.name, () => {
    it('rejects missing/blank keys before calling transport', async () => {
      const transport = vi.fn<SearchApiTransport>();
      await expect(new Provider({ apiKey: ' ,  ' }, transport).search(QUERY))
        .rejects.toMatchObject({ code: 'config_missing', details: { stage: 'config' } });
      expect(transport).not.toHaveBeenCalled();
    });

    it('redacts all rotating keys from HTTP failures', async () => {
      const transport = createSearchApiTransport({
        env: {},
        fetch: async () => new Response(
          JSON.stringify({ error: 'first-secret second-secret' }), { status: 401 },
        ),
      });
      const error = await new Provider({ apiKey: 'first-secret,second-secret' }, transport)
        .search(QUERY).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: 'auth_failed' });
      expect(String(error)).not.toContain('first-secret');
      expect(String(error)).not.toContain('second-secret');
    });

    it('preserves caller cancellation through shared transport', async () => {
      const controller = new AbortController();
      const fetch: SearchApiFetch = async (_url, init) => {
        expect(init.signal?.aborted).toBe(false);
        controller.abort();
        expect(init.signal?.aborted).toBe(true);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      };
      await expect(new Provider({ apiKey: 'secret' }, createSearchApiTransport({ fetch, env: {} }))
        .search(QUERY, { signal: controller.signal }))
        .rejects.toMatchObject({ code: 'cancelled', retryable: false });
    });

    it('preserves the timeout taxonomy through shared transport', async () => {
      const fetch: SearchApiFetch = async (_url, init) => {
        await delay(60_000, undefined, { signal: init.signal ?? undefined });
        return new Response('{}');
      };
      await expect(new Provider({ apiKey: 'secret' }, createSearchApiTransport({ fetch, env: {} }))
        .search(QUERY, { timeout: 5 }))
        .rejects.toMatchObject({ code: 'timeout', retryable: true });
    });
  });
}

describe('Perplexity official Search API', () => {
  it('sends the keyed direct-search schema and normalizes actual snippets', async () => {
    const { calls, transport } = recordingTransport({ results: [
      { title: TITLE_A, url: URL_A, snippet: 'HTTP is an application-layer protocol.' },
      { title: 'Duplicate', url: URL_A, snippet: 'ignored' },
      { title: 'Mozilla', url: URL_B, snippet: 'Mozilla home.' },
    ] });
    const signal = new AbortController().signal;
    const results = await new PerplexitySearchProvider({ apiKey: 'one,two', model: 'unused' }, transport)
      .search(QUERY, { maxResults: 100, timeRange: 'week', timeout: 1234, signal });
    expect(calls[0]).toMatchObject({
      url: 'https://api.perplexity.ai/search', method: 'POST',
      headers: { Authorization: 'Bearer one' },
      jsonBody: { query: QUERY, max_results: 20, search_recency_filter: 'week' },
      timeoutMs: 1234, signal, secrets: ['one', 'two'],
    });
    expect(calls[0].jsonBody).not.toHaveProperty('model');
    expect(results).toEqual([
      { title: TITLE_A, url: URL_A, content: 'HTTP is an application-layer protocol.' },
      { title: 'Mozilla', url: URL_B, content: 'Mozilla home.' },
    ]);
  });

  it('accepts a complete custom search endpoint without appending it twice', async () => {
    const { calls, transport } = recordingTransport({ results: [] });
    const provider = new PerplexitySearchProvider({
      apiKey: 'one,two', apiHost: 'https://search.example.test/proxy/search/',
    }, transport);
    await provider.search(QUERY);
    await provider.search(QUERY);
    expect(calls.map((call) => call.url)).toEqual([
      'https://search.example.test/proxy/search', 'https://search.example.test/proxy/search',
    ]);
    expect(calls[1].headers).toEqual({ Authorization: 'Bearer two' });
  });

  it('does not accept answer-only or wholly malformed result payloads', async () => {
    for (const payload of [
      { choices: [{ message: { content: 'An uncited answer.' } }] },
      { results: [{ url: 'javascript:alert(1)', title: 'Invalid URL' }] },
      { results: [{ url: URL_A, title: 'N/A' }] },
    ]) {
      await expect(new PerplexitySearchProvider({ apiKey: 'secret' }, recordingTransport(payload).transport)
        .search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    }
  });

  it('treats nested API errors as failures even beside a results array', async () => {
    const payload = { results: [], error: {
      type: 'rate_limit_error', message: 'quota secret-one secret-two',
    } };
    const error = await new PerplexitySearchProvider({ apiKey: 'secret-one,secret-two' },
      recordingTransport(payload).transport).search(QUERY).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(String(error)).not.toMatch(/secret-one|secret-two/);
  });

  it('honors hard domain exclusions, including subdomains', async () => {
    const payload = { results: [
      { title: 'Blocked', url: 'https://docs.blocked.example/a', snippet: 'blocked' },
      { title: TITLE_A, url: URL_A, snippet: 'allowed' },
    ] };
    await expect(new PerplexitySearchProvider({ apiKey: 'secret' }, recordingTransport(payload).transport)
      .search(`${QUERY} -site:blocked.example`, { maxResults: 1 }))
      .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: 'allowed' }]);
  });
});

describe('Claude Messages native web search', () => {
  it('uses the real model, native tool, keyed headers and citation snippets', async () => {
    const { calls, transport } = recordingTransport({ content: [toolResult(), citedText(), toolResult(URL_B, 'Mozilla')] });
    const signal = new AbortController().signal;
    await expect(new ClaudeSearchProvider({ apiKey: 'anthropic-key' }, transport)
      .search(QUERY, { maxResults: 1, timeout: 1234, signal }))
      .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: 'Actual cited passage.' }]);
    expect(calls[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages', method: 'POST', signal,
      headers: { 'x-api-key': 'anthropic-key', 'anthropic-version': '2023-06-01' },
      secrets: ['anthropic-key'],
      jsonBody: {
        model: CLAUDE_DEFAULT_MODEL, max_tokens: 4096,
        tools: [{ type: CLAUDE_WEB_SEARCH_TOOL, name: 'web_search', max_uses: 3 }],
      },
    });
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(1234);
    expect(calls[0].timeoutMs).toBeGreaterThan(0);
  });

  it.each(['https://anthropic.example.test', 'https://anthropic.example.test/v1/',
    'https://anthropic.example.test/v1/messages'])('normalizes endpoint %s and honors model override', async (apiHost) => {
    const { calls, transport } = recordingTransport({ content: [citedText()] });
    await new ClaudeSearchProvider({ apiKey: 'key', apiHost, model: 'custom-search-model' }, transport).search(QUERY);
    expect(calls[0].url).toBe('https://anthropic.example.test/v1/messages');
    expect(calls[0].jsonBody).toMatchObject({ model: 'custom-search-model' });
  });

  it('accepts citations without raw tool results', async () => {
    const { transport } = recordingTransport({ content: [citedText()] });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY))
      .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: 'Actual cited passage.' }]);
  });

  it('does not expose encrypted tool content or synthesized answer as a snippet', async () => {
    const { transport } = recordingTransport({ content: [toolResult(), { type: 'text', text: 'Uncited answer.' }] });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY))
      .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: '' }]);
  });

  it('rejects answer-only output without citations and invalid citation URLs', async () => {
    for (const content of [[], [{ type: 'text', text: 'No citations.' }], [citedText('file:///private')]]) {
      await expect(new ClaudeSearchProvider({ apiKey: 'key' }, recordingTransport({ content }).transport)
        .search(QUERY)).rejects.toMatchObject({ code: 'parse_failed' });
    }
  });

  it('keeps a successful empty tool result distinct from answer-only output', async () => {
    const { transport } = recordingTransport({ content: [{ type: 'web_search_tool_result', content: [] }] });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY)).resolves.toEqual([]);
  });

  it('surfaces nested 200 tool errors even if another block has real sources', async () => {
    const payload = { content: [toolResult(), {
      type: 'web_search_tool_result',
      content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests', message: 'one-secret two-secret' },
    }] };
    const error = await new ClaudeSearchProvider({ apiKey: 'one-secret,two-secret' },
      recordingTransport(payload).transport).search(QUERY).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(String(error)).not.toMatch(/one-secret|two-secret/);
  });

  it('does not mistake quota exhaustion for an empty search', async () => {
    const { transport } = recordingTransport({ content: [{ type: 'web_search_tool_result', content: {
      type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded',
    } }] });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY))
      .rejects.toMatchObject({ code: 'upstream_unavailable', retryable: false });
  });

  it('surfaces top-level authentication errors without echoing any keys', async () => {
    const { transport } = recordingTransport({ type: 'error', error: {
      type: 'authentication_error', message: 'bad first-secret second-secret',
    } });
    const error = await new ClaudeSearchProvider({ apiKey: 'first-secret,second-secret' }, transport)
      .search(QUERY).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'auth_failed', retryable: false });
    expect(String(error)).not.toMatch(/first-secret|second-secret/);
  });

  it('continues paused turns with unchanged tool blocks and one timeout budget', async () => {
    const blocks = [{ type: 'server_tool_use', id: 'srv_pending', name: 'web_search', input: { query: QUERY } }];
    const { calls, transport } = recordingTransport(
      { content: blocks, stop_reason: 'pause_turn' }, { content: [toolResult(), citedText()] },
    );
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY, { timeout: 2000 }))
      .resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].jsonBody).toMatchObject({ messages: [
      { role: 'user', content: expect.stringContaining(QUERY) }, { role: 'assistant', content: blocks },
    ] });
    expect(calls[1].timeoutMs).toBeLessThanOrEqual(calls[0].timeoutMs!);
  });

  it('bounds paused continuations rather than returning an empty success', async () => {
    const { calls, transport } = recordingTransport({ content: [], stop_reason: 'pause_turn' });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport).search(QUERY))
      .rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(calls).toHaveLength(3);
  });

  it('filters hard-excluded sources before applying maxResults', async () => {
    const { transport } = recordingTransport({ content: [toolResult('https://docs.blocked.example/a'), toolResult()] });
    await expect(new ClaudeSearchProvider({ apiKey: 'key' }, transport)
      .search(`${QUERY} -site:blocked.example`, { maxResults: 1 }))
      .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: '' }]);
  });
});

for (const Provider of providers) {
  describe(`${Provider.name} canonical hard exclusions`, () => {
    it.each([
      {
        name: 'DNS-equivalent trailing dots',
        query: `${QUERY} -site:blocked.example`,
        blocked: ['https://blocked.example./a', 'https://docs.blocked.example./a'],
      },
      {
        name: 'IDNA domains and trailing dots in directives',
        query: `${QUERY} -site:bücher.example.`,
        blocked: ['https://xn--bcher-kva.example./a', 'https://docs.bücher.example/a'],
      },
      {
        name: 'every directive beyond upstream filter limits',
        query: `${QUERY} ${Array.from({ length: 65 }, (_, index) => `-site:blocked-${index}.example`).join(' ')}`,
        blocked: ['https://blocked-0.example/a', 'https://blocked-64.example./a'],
      },
    ])('enforces $name before limiting results', async ({ query, blocked }) => {
      const sources = [
        ...blocked.map((url) => ({ url, title: 'Excluded source', snippet: '' })),
        { url: URL_A, title: TITLE_A, snippet: '' },
      ];
      const payload = Provider === PerplexitySearchProvider
        ? { results: sources }
        : { content: sources.map((source) => toolResult(source.url, source.title)) };
      const { transport } = recordingTransport(payload);
      await expect(new Provider({ apiKey: 'key' }, transport).search(query, { maxResults: 1 }))
        .resolves.toEqual([{ title: TITLE_A, url: URL_A, content: '' }]);
    });

    it('does not exclude a distinct suffix-lookalike domain', async () => {
      const url = 'https://blocked.example.unrelated.test/a';
      const payload = Provider === PerplexitySearchProvider
        ? { results: [{ url, title: TITLE_A, snippet: '' }] }
        : { content: [toolResult(url)] };
      const { transport } = recordingTransport(payload);
      await expect(new Provider({ apiKey: 'key' }, transport)
        .search(`${QUERY} -site:blocked.example`))
        .resolves.toEqual([{ title: TITLE_A, url, content: '' }]);
    });
  });
}
