/**
 * The managed Responses search lane.
 *
 * **Everything asserted here is OMNICROSS's own emission.** The live upstream
 * `web_search_call` sequence is UNVERIFIED — zero such payloads exist in the
 * 444 audit body shards (wire baseline §2.2) — so these goldens pin OUR shapes
 * against silent change and say nothing about what OpenAI emits. Upstream
 * fixtures below are synthetic and labeled as such.
 *
 * @module provider-proxy/responses/hosted-search/__tests__/nativeResponsesSearchMediator.test
 */

import {
  SearchProviderError,
  type OrchestratedSearchResponse,
} from '@omnicross/contracts/search-types';
import { describe, expect, it, vi } from 'vitest';

import type { SearchRuntime } from '../../../../search/runtime';
import { hasResponsesHostedSearchWork } from '../../responsesHostedSearchIngress';
import {
  createNativeResponsesSearchIngress,
  renderSearchReport,
  responsesSearchDisabledError,
} from '../nativeResponsesSearchMediator';
import {
  parseSelectedSearchCalls,
  prepareNativeResponsesSearchSelection,
} from '../nativeResponsesSearchSelection';

const RESULTS = [
  { title: 'MDN HTTP headers', url: 'https://developer.mozilla.org/headers', content: 'Reference.' },
];

function stubRuntime(impl?: () => Promise<OrchestratedSearchResponse>): SearchRuntime {
  return {
    search: vi.fn(impl ?? (async () => ({
      query: 'http headers',
      providerId: 'http-bing',
      results: RESULTS,
      attempts: [{ providerId: 'http-bing', outcome: 'success' as const, resultCount: 1, durationMs: 6 }],
      fallbackCount: 0,
    }))),
    registerContribution: vi.fn(),
    unregisterContribution: vi.fn(() => false),
    listProviders: vi.fn(() => []),
  };
}

function hostedSearchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5',
    input: 'what are http headers',
    tools: [{ type: 'web_search_preview' }],
    ...overrides,
  };
}

/**
 * A SYNTHETIC upstream turn in which the model called the selector. Shaped
 * after the Responses output-item contract Omnicross already constructs; not a
 * capture.
 */
function upstreamTurnWithSelectorCall(selectorName: string): Response {
  return new Response(JSON.stringify({
    id: 'resp_synthetic',
    object: 'response',
    status: 'completed',
    model: 'gpt-5',
    output: [
      {
        id: 'fc_synthetic',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_synthetic',
        name: selectorName,
        arguments: JSON.stringify({ query: 'http headers' }),
      },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function upstreamTurnWithoutSelectorCall(): Response {
  return new Response(JSON.stringify({
    id: 'resp_synthetic',
    object: 'response',
    status: 'completed',
    model: 'gpt-5',
    output: [
      { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [] },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const IDS = {
  createSelectorName: () => '__omnicross_search_fixed',
  createCallId: () => 'ws_fixed',
  createMessageId: () => 'msg_fixed',
};

function prepareInput(body: Record<string, unknown>): Parameters<
  ReturnType<typeof createNativeResponsesSearchIngress>['prepare']
>[0] {
  return {
    body,
    profile: 'native',
    operation: 'create',
    mode: 'managed',
    signal: new AbortController().signal,
  };
}

describe('ownership and selection', () => {
  it('claims a request declaring either hosted search type', () => {
    expect(hasResponsesHostedSearchWork(hostedSearchBody())).toBe(true);
    expect(hasResponsesHostedSearchWork(hostedSearchBody({ tools: [{ type: 'web_search' }] })))
      .toBe(true);
    expect(hasResponsesHostedSearchWork({ model: 'gpt-5', input: 'hi' })).toBe(false);
  });

  it('swaps the hosted declaration for a selector and forces the upstream turn non-streaming', () => {
    const selection = prepareNativeResponsesSearchSelection({
      body: hostedSearchBody({ stream: true }),
      createSelectorName: IDS.createSelectorName,
    });

    expect(selection.clientWantsStream).toBe(true);
    expect(selection.upstreamBody.stream).toBe(false);
    const tools = selection.upstreamBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', name: '__omnicross_search_fixed' });
    expect(JSON.stringify(tools)).not.toContain('web_search_preview');
  });

  it('follows a tool_choice that named the hosted type', () => {
    const selection = prepareNativeResponsesSearchSelection({
      body: hostedSearchBody({ tool_choice: { type: 'web_search_preview' } }),
      createSelectorName: IDS.createSelectorName,
    });

    expect(selection.upstreamBody.tool_choice)
      .toEqual({ type: 'function', name: '__omnicross_search_fixed' });
  });

  it('leaves every other tool alone', () => {
    const selection = prepareNativeResponsesSearchSelection({
      body: hostedSearchBody({
        tools: [{ type: 'function', name: 'lookup_order' }, { type: 'web_search_preview' }],
      }),
      createSelectorName: IDS.createSelectorName,
    });

    const tools = selection.upstreamBody.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'function', name: 'lookup_order' });
    expect(tools[1]).toMatchObject({ name: '__omnicross_search_fixed' });
  });

  it('ignores malformed selector calls rather than failing the turn', () => {
    expect(parseSelectedSearchCalls([
      { type: 'function_call', name: 'other', arguments: '{"query":"x"}' },
      { type: 'function_call', name: 'sel', arguments: 'not json' },
      { type: 'function_call', name: 'sel', arguments: '{"query":"  "}' },
    ], 'sel')).toEqual([]);
  });
});

describe('managed emission, non-streaming (GOLDEN — Omnicross shapes)', () => {
  it('runs one runtime search per hosted call and splices our items in', async () => {
    const runtime = stubRuntime();
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));
    expect(lease).not.toBeNull();

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });
    const body = JSON.parse(await wrapped.text()) as Record<string, unknown>;

    expect(runtime.search).toHaveBeenCalledTimes(1);
    expect(wrapped.headers.get('content-type')).toContain('application/json');
    expect(body.output).toEqual([
      {
        id: 'ws_fixed',
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'http headers' },
        provider: 'http-bing',
        results: [
          {
            title: 'MDN HTTP headers',
            url: 'https://developer.mozilla.org/headers',
            content: 'Reference.',
          },
        ],
      },
      {
        id: 'msg_fixed',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: renderSearchReport('http headers', RESULTS, 'http-bing'),
            annotations: [],
          },
        ],
      },
    ]);
  });

  it('leaves the turn alone when the model did not search', async () => {
    const runtime = stubRuntime();
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithoutSelectorCall(),
      rawStatus: 200,
    });
    const body = JSON.parse(await wrapped.text()) as { output: Array<Record<string, unknown>> };

    expect(runtime.search).not.toHaveBeenCalled();
    expect(body.output.map((item) => item.type)).toEqual(['message']);
  });

  it('relays an upstream error verbatim', async () => {
    const ingress = createNativeResponsesSearchIngress(stubRuntime(), IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));
    const upstream = new Response('{"error":{"message":"upstream said no"}}', { status: 400 });

    const wrapped = await lease!.wrapUpstreamResponse({ response: upstream, rawStatus: 400 });

    expect(wrapped.status).toBe(400);
    expect(await wrapped.text()).toBe('{"error":{"message":"upstream said no"}}');
  });
});

describe('managed emission, streaming (GOLDEN — Omnicross shapes)', () => {
  it('synthesizes a well-ordered event stream with monotonic sequence numbers', async () => {
    const ingress = createNativeResponsesSearchIngress(stubRuntime(), IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody({ stream: true })));

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });
    const text = await wrapped.text();
    const events = text
      .split('\n\n')
      .filter((frame) => frame.trim())
      .map((frame) => JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as Record<string, unknown>);

    expect(wrapped.headers.get('content-type')).toContain('text/event-stream');
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.web_search_call.in_progress',
      'response.web_search_call.searching',
      'response.web_search_call.completed',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // The terminal event carries the same output the non-streaming path returns.
    const completed = events.at(-1)?.response as { output: Array<Record<string, unknown>> };
    expect(completed.output.map((item) => item.type)).toEqual(['web_search_call', 'message']);
  });

  it('reports a FAILED search call with a failed lifecycle, not a completed one', async () => {
    const runtime = stubRuntime(async () => {
      throw new SearchProviderError('timeout', 'sanitized failure');
    });
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody({ stream: true })));

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });
    const types = (await wrapped.text())
      .split('\n\n')
      .filter((frame) => frame.trim())
      .map((frame) => (JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] ?? '{}') as { type: string }).type);

    // The stream must not say `completed` over an item whose own status is
    // `failed` — the whole sequence is ours, so there is no vendor shape
    // forcing that contradiction.
    expect(types).toContain('response.web_search_call.failed');
    expect(types).not.toContain('response.web_search_call.completed');
  });
});

describe('failure matrix', () => {
  it('returns an empty result set as a success', async () => {
    const runtime = stubRuntime(async () => ({
      query: 'http headers',
      providerId: 'http-duckduckgo',
      results: [],
      attempts: [
        { providerId: 'http-duckduckgo', outcome: 'success' as const, resultCount: 0, durationMs: 2 },
      ],
      fallbackCount: 0,
    }));
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });
    const body = JSON.parse(await wrapped.text()) as { output: Array<Record<string, unknown>> };

    expect(body.output[0]).toMatchObject({ status: 'completed', results: [] });
  });

  for (const code of ['timeout', 'upstream_unavailable', 'cancelled', 'config_missing'] as const) {
    it(`turns a ${code} failure into a failed search item, never a hang`, async () => {
      const runtime = stubRuntime(async () => {
        throw new SearchProviderError(code, 'sanitized failure');
      });
      const ingress = createNativeResponsesSearchIngress(runtime, IDS);
      const lease = await ingress.prepare(prepareInput(hostedSearchBody()));

      const wrapped = await lease!.wrapUpstreamResponse({
        response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
        rawStatus: 200,
      });
      const body = JSON.parse(await wrapped.text()) as { output: Array<Record<string, unknown>> };

      expect(body.output[0]).toMatchObject({
        type: 'web_search_call',
        status: 'failed',
        error: { code, message: 'sanitized failure' },
      });
      expect(JSON.stringify(body.output[1])).toContain('failed');
    });
  }

  it('reports exhaustion with the runtime`s own explanation', async () => {
    const runtime = stubRuntime(async () => {
      throw new SearchProviderError(
        'upstream_unavailable',
        'no eligible search provider was available (0 attempts)',
      );
    });
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));

    const wrapped = await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });

    expect(await wrapped.text()).toContain('0 attempts');
  });

  it('refuses to wrap twice', async () => {
    const ingress = createNativeResponsesSearchIngress(stubRuntime(), IDS);
    const lease = await ingress.prepare(prepareInput(hostedSearchBody()));
    await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });

    await expect(lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    })).rejects.toThrow(/wrapped twice/);
  });
});

describe('client abort', () => {
  it('starts no further search once the client is gone', async () => {
    const controller = new AbortController();
    const runtime = stubRuntime(async () => {
      // The first search completes; the client disconnects during it.
      controller.abort();
      return {
        query: 'http headers',
        providerId: 'http-bing',
        results: RESULTS,
        attempts: [
          { providerId: 'http-bing', outcome: 'success' as const, resultCount: 1, durationMs: 3 },
        ],
        fallbackCount: 0,
      };
    });
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare({
      ...prepareInput(hostedSearchBody()),
      signal: controller.signal,
    });

    // A turn carrying TWO selector calls: the second must never run.
    const upstream = new Response(JSON.stringify({
      id: 'resp_synthetic',
      object: 'response',
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1',
          name: '__omnicross_search_fixed', arguments: JSON.stringify({ query: 'first' }),
        },
        {
          id: 'fc_2', type: 'function_call', status: 'completed', call_id: 'call_2',
          name: '__omnicross_search_fixed', arguments: JSON.stringify({ query: 'second' }),
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await lease!.wrapUpstreamResponse({ response: upstream, rawStatus: 200 });

    // Exactly one search ran; the abort stopped the loop before the next.
    expect(runtime.search).toHaveBeenCalledTimes(1);
  });

  it('passes the request signal into every runtime search', async () => {
    const controller = new AbortController();
    const runtime = stubRuntime();
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);
    const lease = await ingress.prepare({
      ...prepareInput(hostedSearchBody()),
      signal: controller.signal,
    });

    await lease!.wrapUpstreamResponse({
      response: upstreamTurnWithSelectorCall('__omnicross_search_fixed'),
      rawStatus: 200,
    });

    const call = (runtime.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      { options?: { signal?: AbortSignal } };
    expect(call.options?.signal).toBe(controller.signal);
  });
});

describe('mode isolation, proven both directions', () => {
  it('never prepares a lease outside managed mode', async () => {
    const runtime = stubRuntime();
    const ingress = createNativeResponsesSearchIngress(runtime, IDS);

    for (const mode of ['native', 'off'] as const) {
      const lease = await ingress.prepare({ ...prepareInput(hostedSearchBody()), mode });
      expect(lease).toBeNull();
    }
    expect(runtime.search).not.toHaveBeenCalled();
  });

  it('never prepares a lease for a request that declares no hosted search', async () => {
    const ingress = createNativeResponsesSearchIngress(stubRuntime(), IDS);

    const lease = await ingress.prepare(prepareInput({ model: 'gpt-5', input: 'hi' }));

    expect(lease).toBeNull();
  });

  it('carries a stable unsupported_capability for mode off', () => {
    const error = responsesSearchDisabledError();

    expect(error.code).toBe('unsupported_capability');
    expect(error.status).toBeGreaterThanOrEqual(400);
  });
});
