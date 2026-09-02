/**
 * The Anthropic managed search lane.
 *
 * **Evidence boundary, and it governs every assertion here.** The block
 * ORDERING and the result-item FIELD SET are VERIFIED against four real
 * upstream SSE captures (wire baseline §3.3). Everything after the
 * `web_search_tool_result` `content_block_start` — the closing
 * `content_block_stop`, the trailing text block, `message_delta`,
 * `message_stop` — is beyond the ~8 KB capture truncation and is asserted only
 * as OMNICROSS's own documented emission. No test here claims upstream parity
 * past that boundary.
 *
 * @module provider-proxy/ingress/__tests__/anthropicManagedSearch.test
 */

import { EventEmitter } from 'node:events';
import type http from 'node:http';

import {
  SearchProviderError,
  type OrchestratedSearchResponse,
} from '@omnicross/contracts/search-types';
import { describe, expect, it, vi } from 'vitest';

import { createSSEParser } from '../../../sse-parser';
import type { SearchRuntime } from '../../../search/runtime';
import type { WebSearchBackend } from '../../../ports/web-search-backend';
import {
  anthropicSearchSummaryText,
  buildAnthropicManagedSearchBlocks,
  declaresAnthropicSearchTool,
  extractAnthropicSearchQuery,
  handleAnthropicManagedSearch,
  isAnthropicSearchOnlyRequest,
  resolveAnthropicSearchHintBackend,
  toAnthropicSearchResultItems,
} from '../anthropicManagedSearch';

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.writableEnded = true;
  }
}

function response(): { res: http.ServerResponse; mock: MockResponse } {
  const mock = new MockResponse();
  return { res: mock as unknown as http.ServerResponse, mock };
}

const RESULTS = [
  { title: 'MDN HTTP headers', url: 'https://developer.mozilla.org/headers', content: 'Reference.' },
  { title: 'RFC 9110', url: 'https://www.rfc-editor.org/rfc/rfc9110', content: 'Semantics.' },
];

function stubRuntime(
  impl?: () => Promise<OrchestratedSearchResponse>,
): SearchRuntime {
  return {
    search: vi.fn(impl ?? (async () => ({
      query: 'http headers',
      providerId: 'http-bing',
      results: RESULTS,
      attempts: [{ providerId: 'http-bing', outcome: 'success' as const, resultCount: 2, durationMs: 7 }],
      fallbackCount: 0,
    }))),
    registerContribution: vi.fn(),
    unregisterContribution: vi.fn(() => false),
    listProviders: vi.fn(() => []),
  };
}

function searchOnlyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    tool_choice: { type: 'tool', name: 'web_search' },
    messages: [
      { role: 'user', content: 'Perform a web search for the query: http headers' },
    ],
    ...overrides,
  };
}

/** Parse an SSE body into `{event, data}` pairs, in order. */
function sseEvents(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.trim())
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe('detection', () => {
  it('matches a search-only sub-request the way the reference does', () => {
    expect(isAnthropicSearchOnlyRequest(searchOnlyBody())).toBe(true);
    // A single search tool with no tool_choice still counts.
    expect(isAnthropicSearchOnlyRequest(searchOnlyBody({ tool_choice: undefined }))).toBe(true);
  });

  it('uses the version PREFIX rule, so a new tool version is data, not a branch', () => {
    expect(isAnthropicSearchOnlyRequest(searchOnlyBody({
      tools: [{ type: 'web_search_20991231', name: 'web_search' }],
    }))).toBe(true);
  });

  it('does not claim a general chat request that merely declares a search tool', () => {
    const mixed = searchOnlyBody({
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'custom', name: 'lookup_order' },
      ],
      tool_choice: { type: 'auto' },
    });

    expect(isAnthropicSearchOnlyRequest(mixed)).toBe(false);
    expect(declaresAnthropicSearchTool(mixed)).toBe(true);
  });

  it('extracts the query from the SDK phrasing and from a plain message', () => {
    expect(extractAnthropicSearchQuery(searchOnlyBody())).toBe('http headers');
    expect(extractAnthropicSearchQuery(searchOnlyBody({
      messages: [{ role: 'user', content: [{ type: 'text', text: '"quoted query"' }] }],
    }))).toBe('quoted query');
  });
});

describe('non-streaming synthesis', () => {
  it('carries exactly the verified field set with correct tool_use_id linkage', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();

    const handled = await handleAnthropicManagedSearch(res, searchOnlyBody(), {
      mode: 'managed',
      runtime,
      createToolUseId: () => 'toolu_search_fixed',
      createMessageId: () => 'msg_search_fixed',
    });

    expect(handled).toBe(true);
    expect(runtime.search).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mock.body) as Record<string, unknown>;
    const content = body.content as Array<Record<string, unknown>>;

    // VERIFIED ordering: server_tool_use then web_search_tool_result.
    expect(content.map((block) => block.type))
      .toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    expect(content[0]).toEqual({
      type: 'server_tool_use',
      id: 'toolu_search_fixed',
      name: 'web_search',
      input: { query: 'http headers' },
    });
    expect(content[1]?.tool_use_id).toBe('toolu_search_fixed');
    // VERIFIED field set: exactly url, title, encrypted_content, page_age.
    for (const item of content[1]?.content as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort())
        .toEqual(['encrypted_content', 'page_age', 'title', 'type', 'url']);
      expect(item.type).toBe('web_search_result');
      expect(item.page_age).toBeNull();
    }
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('keeps provenance visible in the summary block', () => {
    const text = anthropicSearchSummaryText('http headers', RESULTS, 'http-bing');

    expect(text).toContain('Provider used: http-bing');
    expect(text).toContain('https://developer.mozilla.org/headers');
  });

  it('puts the result snippet in encrypted_content, as the reference does', () => {
    expect(toAnthropicSearchResultItems(RESULTS)[0]?.encrypted_content).toBe('Reference.');
  });
});

describe('streaming synthesis', () => {
  it('emits the verified prefix in the verified order', async () => {
    const { res, mock } = response();

    await handleAnthropicManagedSearch(res, searchOnlyBody({ stream: true }), {
      mode: 'managed',
      runtime: stubRuntime(),
      createToolUseId: () => 'toolu_search_fixed',
      createMessageId: () => 'msg_search_fixed',
    });

    expect(mock.headers['Content-Type']).toBe('text/event-stream');
    const events = sseEvents(mock.body);
    // VERIFIED prefix (wire baseline §3.3), asserted up to and including the
    // result block's content_block_start and NO further as upstream evidence.
    expect(events.slice(0, 6).map((entry) => entry.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
    ]);
    expect((events[1]?.data.content_block as Record<string, unknown>).type)
      .toBe('server_tool_use');
    expect((events[3]?.data.delta as Record<string, unknown>).type).toBe('input_json_delta');
    expect((events[5]?.data.content_block as Record<string, unknown>).type)
      .toBe('web_search_tool_result');
  });

  it('closes with our own documented tail, which is NOT upstream-verified', async () => {
    const { res, mock } = response();

    await handleAnthropicManagedSearch(res, searchOnlyBody({ stream: true }), {
      mode: 'managed',
      runtime: stubRuntime(),
      createToolUseId: () => 'toolu_search_fixed',
      createMessageId: () => 'msg_search_fixed',
    });

    const events = sseEvents(mock.body);
    expect(events.slice(6).map((entry) => entry.event)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('parses through the existing anthropic SSE parser with the expected linkage', async () => {
    const { res, mock } = response();
    await handleAnthropicManagedSearch(res, searchOnlyBody({ stream: true }), {
      mode: 'managed',
      runtime: stubRuntime(),
      createToolUseId: () => 'toolu_search_fixed',
      createMessageId: () => 'msg_search_fixed',
    });

    const blocks: Array<Record<string, unknown>> = [];
    const parser = createSSEParser('anthropic', {
      onBlock: (block) => blocks.push(block as unknown as Record<string, unknown>),
    });
    parser.push(mock.body);

    // A4: the parser binds the result block to the LAST server_tool_use id.
    // Synthesizing that block is what keeps the linkage intact.
    const toolUse = blocks.find((block) => block.type === 'tool_use');
    const toolResult = blocks.find((block) => block.type === 'tool_result');
    expect(toolUse?.toolId).toBe('toolu_search_fixed');
    expect(toolResult?.toolId).toBe('toolu_search_fixed');
  });
});

describe('failure matrix', () => {
  it('returns an empty result set as a success', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime(async () => ({
      query: 'http headers',
      providerId: 'http-duckduckgo',
      results: [],
      attempts: [
        { providerId: 'http-duckduckgo', outcome: 'success' as const, resultCount: 0, durationMs: 4 },
      ],
      fallbackCount: 0,
    }));

    await handleAnthropicManagedSearch(res, searchOnlyBody(), { mode: 'managed', runtime });

    expect(mock.statusCode).toBe(200);
    const content = (JSON.parse(mock.body) as { content: Array<Record<string, unknown>> }).content;
    expect(content[1]?.content).toEqual([]);
  });

  const failures: ReadonlyArray<{ code: string; status: number }> = [
    { code: 'timeout', status: 504 },
    { code: 'upstream_unavailable', status: 502 },
    { code: 'cancelled', status: 499 },
    { code: 'config_missing', status: 503 },
  ];

  for (const { code, status } of failures) {
    it(`maps ${code} onto an Anthropic-shaped ${status}`, async () => {
      const { res, mock } = response();
      const runtime = stubRuntime(async () => {
        throw new SearchProviderError(code as 'timeout', 'sanitized failure');
      });

      await handleAnthropicManagedSearch(res, searchOnlyBody(), { mode: 'managed', runtime });

      expect(mock.statusCode).toBe(status);
      const body = JSON.parse(mock.body) as Record<string, unknown>;
      expect(body.type).toBe('error');
      expect((body.error as Record<string, unknown>).code).toBe(code);
    });
  }

  it('answers a structured error when no provider is available, never a hang', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime(async () => {
      throw new SearchProviderError(
        'upstream_unavailable',
        'no eligible search provider was available (0 attempts)',
      );
    });

    await handleAnthropicManagedSearch(res, searchOnlyBody({ stream: true }), {
      mode: 'managed',
      runtime,
    });

    expect(mock.statusCode).toBe(502);
    // Never a half-open stream: nothing was written before the failure.
    expect(mock.headers['Content-Type']).toBe('application/json');
  });

  it('writes nothing further once the client has already disconnected', async () => {
    const { res, mock } = response();
    const controller = new AbortController();
    const runtime = stubRuntime(async () => {
      controller.abort();
      return {
        query: 'http headers',
        providerId: 'http-bing',
        results: RESULTS,
        attempts: [
          { providerId: 'http-bing', outcome: 'success' as const, resultCount: 2, durationMs: 3 },
        ],
        fallbackCount: 0,
      };
    });

    const handled = await handleAnthropicManagedSearch(res, searchOnlyBody({ stream: true }), {
      mode: 'managed',
      runtime,
      signal: controller.signal,
    });

    expect(handled).toBe(true);
    expect(mock.body).toBe('');
    expect(mock.headersSent).toBe(false);
  });
});

describe('mode isolation, proven both directions', () => {
  it('native mode never enters this lane and never touches the runtime', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();

    const handled = await handleAnthropicManagedSearch(res, searchOnlyBody(), {
      mode: 'native',
      runtime,
    });

    expect(handled).toBe(false);
    expect(runtime.search).not.toHaveBeenCalled();
    expect(mock.headersSent).toBe(false);
  });

  it('managed mode never emits the native lane`s passthrough bytes', async () => {
    const { res, mock } = response();

    await handleAnthropicManagedSearch(res, searchOnlyBody(), {
      mode: 'managed',
      runtime: stubRuntime(),
    });

    // The only bytes on the wire are the ones this lane synthesized.
    const body = JSON.parse(mock.body) as Record<string, unknown>;
    expect(body.id).toMatch(/^msg_search_/);
  });

  it('off mode refuses a declared search but relays anything else', async () => {
    const refused = response();
    await handleAnthropicManagedSearch(refused.res, searchOnlyBody(), {
      mode: 'off',
      runtime: stubRuntime(),
    });
    expect(refused.mock.statusCode).toBe(400);
    expect(refused.mock.body).toContain('unsupported_capability');

    const relayed = response();
    const runtime = stubRuntime();
    const handled = await handleAnthropicManagedSearch(
      relayed.res,
      { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] },
      { mode: 'off', runtime },
    );
    expect(handled).toBe(false);
    expect(runtime.search).not.toHaveBeenCalled();
  });
});

describe('the webSearchService hint slot', () => {
  it('carries the adapter-wrapped runtime when the route supplies none', () => {
    const runtime = stubRuntime();
    const backend = resolveAnthropicSearchHintBackend(null, runtime);

    expect(backend).not.toBeNull();
    expect(typeof backend?.search).toBe('function');
    expect(typeof backend?.isProviderEnabled).toBe('function');
    // Stable across requests, so a host can cache against it.
    expect(resolveAnthropicSearchHintBackend(undefined, runtime)).toBe(backend);
  });

  it('lets a route-supplied backend win, per the existing hint contract', () => {
    const hostBackend = { search: vi.fn(), isProviderEnabled: vi.fn(), readUrl: vi.fn() } as
      unknown as WebSearchBackend;

    expect(resolveAnthropicSearchHintBackend(hostBackend, stubRuntime())).toBe(hostBackend);
  });

  it('stays null when there is no runtime and no route-supplied backend', () => {
    expect(resolveAnthropicSearchHintBackend(null, null)).toBeNull();
  });
});

describe('block construction', () => {
  it('is pure and reproducible', () => {
    const blocks = buildAnthropicManagedSearchBlocks({
      query: 'q',
      results: RESULTS,
      providerId: 'tavily',
      toolUseId: 'toolu_x',
    });

    expect(blocks).toEqual(buildAnthropicManagedSearchBlocks({
      query: 'q',
      results: RESULTS,
      providerId: 'tavily',
      toolUseId: 'toolu_x',
    }));
  });
});
