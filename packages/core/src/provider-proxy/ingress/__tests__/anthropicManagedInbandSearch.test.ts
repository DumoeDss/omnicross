/**
 * The Anthropic managed IN-BAND search lane.
 *
 * **Evidence boundary.** The client-facing block ORDER (`server_tool_use` →
 * `input_json_delta` → `content_block_stop` → `web_search_tool_result`) and the
 * result item FIELD SET are verified against the same wire-baseline captures as
 * the search-only lane (§3.3). The multi-turn SPLICE — one `message_start`,
 * reindexed continuation blocks, merged usage — is Omnicross's own documented
 * emission; no capture has ever shown it, and the tests below assert it as OURS.
 *
 * @module provider-proxy/ingress/__tests__/anthropicManagedInbandSearch.test
 */

import { EventEmitter } from 'node:events';
import type http from 'node:http';

import type { OrchestratedSearchResponse } from '@omnicross/contracts/search-types';
import { describe, expect, it, vi } from 'vitest';

import type { SearchRuntime } from '../../../search/runtime';
import {
  hasManagedInbandSearchWork,
  prepareManagedInbandSearch,
  runManagedInbandSearch,
} from '../anthropicManagedInbandSearch';

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

function claudeCodeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    stream: true,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: {} } },
    ],
    messages: [{ role: 'user', content: 'What is OpenAI dots?' }],
    ...overrides,
  };
}

// ── upstream SSE fixtures ─────────────────────────────────────────────────────

function sseResponse(events: Record<string, unknown>[]): Response {
  const text = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function messageStart(inputTokens = 10): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg_upstream_1',
      type: 'message',
      role: 'assistant',
      model: 'glm-5.3',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  };
}

function textBlockEvents(index: number, text: string): Record<string, unknown>[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
}

function toolUseEvents(
  index: number,
  id: string,
  name: string,
  inputJson: string,
): Record<string, unknown>[] {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: inputJson } },
    { type: 'content_block_stop', index },
  ];
}

function turnEnd(stopReason: string, outputTokens: number): Record<string, unknown>[] {
  return [
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: 'message_stop' },
  ];
}

function runResult(response: Response): { response: Response; rawStatus: number } {
  return { response, rawStatus: response.status };
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

const ENGINE_OPTIONS = {
  requestedModel: 'claude-sonnet-4-5',
  resolvedModel: 'glm-5.3',
};

describe('detection and preparation', () => {
  it('claims the in-band Claude Code shape', () => {
    expect(hasManagedInbandSearchWork(claudeCodeBody())).toBe(true);
    expect(hasManagedInbandSearchWork(claudeCodeBody({ tools: [] }))).toBe(false);
    expect(hasManagedInbandSearchWork({ tools: 'nope' as unknown })).toBe(false);
  });

  it('swaps the hosted declaration for a selector and forces streaming', () => {
    const prep = prepareManagedInbandSearch(claudeCodeBody());
    expect(prep.selectorName).toBe('web_search');
    const tools = prep.upstreamBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: {} } });
    expect(tools[1]).toMatchObject({ name: 'web_search', description: expect.any(String) });
    expect((prep.upstreamBody.tools as Array<Record<string, unknown>>)[1]).toHaveProperty('input_schema');
    expect(prep.upstreamBody.stream).toBe(true);
  });

  it('mints a non-colliding selector name when the caller already has web_search', () => {
    // A `custom` tool named web_search is the caller's OWN function (the A7
    // family treats an untyped/web_search-typed tool as a search declaration
    // and takes it over — see the swap test above).
    const body = claudeCodeBody({
      tools: [
        { type: 'custom', name: 'web_search', description: 'caller tool', input_schema: { type: 'object' } },
      ],
    });
    const prep = prepareManagedInbandSearch(body);
    expect(prep.selectorName).toMatch(/^__omnicross_search_/);
    const names = (prep.upstreamBody.tools as Array<Record<string, unknown>>).map((t) => t.name);
    expect(names.filter((name) => name === prep.selectorName)).toHaveLength(1);
  });

  it('points a forcing tool_choice at the selector', () => {
    const prep = prepareManagedInbandSearch(
      claudeCodeBody({ tool_choice: { type: 'tool', name: 'web_search' } }),
    );
    expect(prep.upstreamBody.tool_choice).toEqual({ type: 'tool', name: prep.selectorName });
  });

  it('rewrites server-tool history into function-tool history', () => {
    const body = claudeCodeBody({
      messages: [
        { role: 'user', content: 'search for dots' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'dots' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [
                { type: 'web_search_result', url: 'https://x.test', title: 'X', encrypted_content: 'snippet', page_age: null },
              ],
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    });
    const prep = prepareManagedInbandSearch(body);
    const messages = prep.upstreamBody.messages as Array<Record<string, unknown>>;
    // server blocks left the assistant message; the result became a tool_result
    // MERGED into the following user message (roles stay alternating).
    expect(messages).toHaveLength(3);
    const assistant = messages[1]['content'] as Array<Record<string, unknown>>;
    expect(assistant.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(assistant[1]).toMatchObject({ id: 'srvtoolu_1', name: prep.selectorName, input: { query: 'dots' } });
    const user = messages[2]['content'] as Array<Record<string, unknown>>;
    expect(user[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'srvtoolu_1' });
    expect(String(user[0]['content'])).toContain('https://x.test');
    expect(user[1]).toEqual({ type: 'text', text: 'continue' });
  });

  it('inserts a standalone tool_result user message when no user turn follows', () => {
    const body = claudeCodeBody({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'q' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: [] },
          ],
        },
      ],
    });
    const prep = prepareManagedInbandSearch(body);
    const messages = prep.upstreamBody.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[1]['role']).toBe('user');
  });
});

describe('engine', () => {
  it('relays a no-search turn through untouched (single upstream call)', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const calls: Record<string, unknown>[] = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      return runResult(sseResponse([
        messageStart(),
        ...textBlockEvents(0, 'OpenAI dots launched Sep 2026.'),
        ...turnEnd('end_turn', 20),
      ]));
    };
    const bodyText = await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    expect(bodyText).toBeNull();
    expect(calls).toHaveLength(1);
    expect(mock.statusCode).toBe(200);
    expect(mock.headers['Content-Type']).toBe('text/event-stream');
    const events = sseEvents(mock.body);
    expect(events.map((e) => e.data.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const start = events[0].data.message as Record<string, unknown>;
    expect(start.model).toBe('claude-sonnet-4-5');
    const delta = events[4].data;
    expect(delta).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 20 } });
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('executes the search, continues upstream with the results, and splices native-shaped blocks', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const calls: Array<Record<string, unknown>> = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      if (calls.length === 1) {
        return runResult(sseResponse([
          messageStart(),
          ...textBlockEvents(0, 'Let me check.'),
          ...toolUseEvents(1, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
          ...turnEnd('tool_use', 5),
        ]));
      }
      return runResult(sseResponse([
        messageStart(),
        ...textBlockEvents(0, 'Here is the answer.'),
        ...turnEnd('end_turn', 12),
      ]));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });

    // Follow-up body: original history + the captured assistant turn + the
    // tool_result carrying the rendered search report.
    expect(calls).toHaveLength(2);
    const messages = calls[1].messages as Array<Record<string, unknown>>;
    const original = calls[0].messages as unknown[];
    expect(messages.slice(0, original.length)).toEqual(original);
    const assistant = messages[original.length] as Record<string, unknown>;
    expect(assistant.role).toBe('assistant');
    const assistantContent = assistant.content as Array<Record<string, unknown>>;
    expect(assistantContent[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(assistantContent[1]).toEqual({ type: 'tool_use', id: 'toolu_sel_1', name: 'web_search', input: { query: 'http headers' } });
    const user = messages[original.length + 1] as Record<string, unknown>;
    const toolResult = (user.content as Array<Record<string, unknown>>)[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_sel_1' });
    expect(String(toolResult.content)).toContain('Provider used: http-bing');

    // Client stream: the verified native block order, one framing pair,
    // reindexed continuation, merged usage.
    const events = sseEvents(mock.body).map((e) => e.data);
    expect(events.filter((e) => e.type === 'message_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
    const typesWithIndex = events.filter((e) => e.type.startsWith('content_block_'));
    expect(typesWithIndex.map((e) => e.index)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 3]);
    expect(typesWithIndex.map((e) => e.type)).toEqual([
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
    ]);
    const serverToolUse = typesWithIndex[3] as unknown as { content_block: Record<string, unknown> };
    expect(serverToolUse.content_block).toEqual({ type: 'server_tool_use', id: 'toolu_sel_1', name: 'web_search', input: {} });
    const resultBlock = typesWithIndex[6] as unknown as { content_block: Record<string, unknown> };
    expect(resultBlock.content_block).toMatchObject({ type: 'web_search_tool_result', tool_use_id: 'toolu_sel_1' });
    expect(resultBlock.content_block.content).toEqual([
      { type: 'web_search_result', url: RESULTS[0].url, title: RESULTS[0].title, encrypted_content: RESULTS[0].content, page_age: null },
      { type: 'web_search_result', url: RESULTS[1].url, title: RESULTS[1].title, encrypted_content: RESULTS[1].content, page_age: null },
    ]);
    const delta = events.find((e) => e.type === 'message_delta') as Record<string, unknown>;
    expect(delta.usage).toMatchObject({ input_tokens: 10, output_tokens: 17 });
  });

  it('ends the turn for the client when the model also called a client tool', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const calls: Array<Record<string, unknown>> = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      return runResult(sseResponse([
        messageStart(),
        ...toolUseEvents(0, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
        ...toolUseEvents(1, 'toolu_bash_1', 'Bash', '{"command":"ls"}'),
        ...turnEnd('tool_use', 5),
      ]));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    // The Bash call belongs to the CLIENT's round trip — no follow-up upstream.
    expect(calls).toHaveLength(1);
    const events = sseEvents(mock.body).map((e) => e.data);
    const delta = events.find((e) => e.type === 'message_delta') as Record<string, unknown>;
    expect(delta).toMatchObject({ delta: { stop_reason: 'tool_use' } });
    // The search still ran and its result block still reached the client.
    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(mock.body).toContain('web_search_tool_result');
  });

  it('keeps the turn well-formed when the search itself fails', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime(async () => {
      throw new Error('bocha down');
    });
    const calls: Array<Record<string, unknown>> = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      if (calls.length === 1) {
        return runResult(sseResponse([
          messageStart(),
          ...toolUseEvents(0, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
          ...turnEnd('tool_use', 5),
        ]));
      }
      return runResult(sseResponse([...textBlockEvents(0, 'No results, but here is what I know.'), ...turnEnd('end_turn', 8)]));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    expect(calls).toHaveLength(2);
    const messages = calls[1].messages as Array<Record<string, unknown>>;
    const toolResult = (messages.at(-1) as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect(String(toolResult[0].content)).toContain('failed');
    expect(mock.body).toContain('"content":[]');
  });

  it('relays a first-turn upstream failure verbatim', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const errorBody = '{"type":"error","error":{"type":"invalid_request_error","message":"no"}}';
    const callUpstream = async () =>
      runResult(new Response(errorBody, { status: 400, headers: { 'content-type': 'application/json' } }));
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    expect(mock.statusCode).toBe(400);
    expect(mock.body).toContain('invalid_request_error');
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('answers a failed follow-up with an in-band error event', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const calls: Array<Record<string, unknown>> = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      if (calls.length === 1) {
        return runResult(sseResponse([
          messageStart(),
          ...toolUseEvents(0, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
          ...turnEnd('tool_use', 5),
        ]));
      }
      return runResult(new Response('{"error":"upstream exploded"}', { status: 502, headers: { 'content-type': 'application/json' } }));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    expect(calls).toHaveLength(2);
    expect(mock.body).toContain('"type":"error"');
    expect(mock.body).toContain('502');
  });

  it('aggregates a non-streaming client into one message', async () => {
    const { res, mock } = response();
    const runtime = stubRuntime();
    const callUpstream = async (body: Record<string, unknown>) => {
      if ((body as { __seen?: boolean }).__seen) {
        return runResult(sseResponse([...textBlockEvents(0, 'Final answer.'), ...turnEnd('end_turn', 9)]));
      }
      (body as { __seen?: boolean }).__seen = true;
      return runResult(sseResponse([
        messageStart(),
        ...toolUseEvents(0, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
        ...turnEnd('tool_use', 5),
      ]));
    };
    const bodyText = await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: false,
      ...ENGINE_OPTIONS,
    });
    expect(mock.statusCode).toBe(200);
    const message = JSON.parse(bodyText as string) as Record<string, unknown>;
    expect(message.model).toBe('claude-sonnet-4-5');
    expect(message.stop_reason).toBe('end_turn');
    const content = message.content as Array<Record<string, unknown>>;
    expect(content.map((block) => block.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    expect(content[0]).toMatchObject({ id: 'toolu_sel_1', input: { query: 'http headers' } });
    expect(content[2]).toEqual({ type: 'text', text: 'Final answer.' });
    expect(message.usage).toMatchObject({ input_tokens: 10, output_tokens: 14 });
  });

  it('strips the selector once the search cap is reached', async () => {
    const { res } = response();
    const runtime = stubRuntime();
    const calls: Array<Record<string, unknown>> = [];
    const callUpstream = async (body: Record<string, unknown>) => {
      calls.push(body);
      // Every turn calls the selector until it is stripped, then answers.
      const selectorDeclared = (body.tools as Array<Record<string, unknown>>).some(
        (tool) => tool.name === 'web_search' && !('max_uses' in tool),
      );
      if (!selectorDeclared) {
        return runResult(sseResponse([...textBlockEvents(0, 'Enough searching.'), ...turnEnd('end_turn', 9)]));
      }
      return runResult(sseResponse([
        ...(calls.length === 1 ? [messageStart()] : []),
        ...toolUseEvents(0, `toolu_sel_${calls.length}`, 'web_search', '{"query":"q' + calls.length + '"}'),
        ...turnEnd('tool_use', 1),
      ]));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      ...ENGINE_OPTIONS,
    });
    expect(runtime.search).toHaveBeenCalledTimes(8);
    // Call 9 was made WITHOUT the selector, so the model had to answer.
    expect(calls).toHaveLength(9);
    const finalTools = calls[8].tools as Array<Record<string, unknown>>;
    expect(finalTools.some((tool) => tool.name === 'web_search')).toBe(false);
  });

  it('fires the usage tap once with the merged usage', async () => {
    const { res } = response();
    const runtime = stubRuntime();
    const onUsage = vi.fn();
    const callUpstream = async (body: Record<string, unknown>) => {
      const seen = (body as { __seen?: boolean }).__seen;
      (body as { __seen?: boolean }).__seen = true;
      if (seen) {
        return runResult(sseResponse([...textBlockEvents(0, 'ok'), ...turnEnd('end_turn', 7)]));
      }
      return runResult(sseResponse([
        messageStart(),
        ...toolUseEvents(0, 'toolu_sel_1', 'web_search', '{"query":"http headers"}'),
        ...turnEnd('tool_use', 3),
      ]));
    };
    await runManagedInbandSearch(res, prepareManagedInbandSearch(claudeCodeBody()), callUpstream, {
      runtime,
      isClientStream: true,
      usageTap: {
        extractUsage: (event) =>
          event.type === 'message_delta' ? (event.usage as Record<string, unknown>) : null,
        onUsage,
      },
      ...ENGINE_OPTIONS,
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ output_tokens: 10 });
  });
});
