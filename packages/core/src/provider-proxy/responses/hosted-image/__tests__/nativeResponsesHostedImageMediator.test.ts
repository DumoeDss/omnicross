import { describe, expect, it, vi } from 'vitest';

import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
  type ResponsesImageExecutionEvent,
  type ResponsesImageRequestScope,
} from '../../../../image-generation/responses';
import { OpenAIOperationError } from '../../../../openai-operation';
import type {
  ResponsesHostedImageRuntimeFactory,
  ResponsesHostedImageRuntimeLease,
} from '../../responsesHostedImageIngress';
import { createNativeResponsesHostedImageMediator } from '../nativeResponsesHostedImageMediator';

const SELECTOR_NAME = '__omnicross_image_test_selector';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sseEvent(
  event: Record<string, unknown>,
  newline: '\n' | '\r\n' = '\n',
  multiline = false,
): string {
  const data = JSON.stringify(event);
  if (!multiline) return `event: ${String(event.type)}${newline}data: ${data}${newline}${newline}`;
  const split = data.indexOf(',');
  expect(split).toBeGreaterThan(0);
  return [
    `event: ${String(event.type)}${newline}`,
    `data: ${data.slice(0, split + 1)}${newline}`,
    `data: ${data.slice(split + 1)}${newline}`,
    newline,
  ].join('');
}

function chunkedSseResponse(text: string, chunkBytes = 1): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        controller.enqueue(bytes.slice(offset, offset + chunkBytes));
      }
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const normalized = text.replaceAll('\r\n', '\n');
  return normalized.split('\n\n').flatMap((frame) => {
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    return data ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}

function eventStream(events: readonly ResponsesImageExecutionEvent[]): AsyncIterable<ResponsesImageExecutionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function imageEvents(index: number, outputIndex: number): readonly ResponsesImageExecutionEvent[] {
  const suffix = index === 0 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb';
  const id = `ig_${suffix}` as const;
  return [{
    kind: 'started',
    outputIndex,
    item: { id, type: 'image_generation_call', status: 'in_progress' },
  }, {
    kind: 'completed',
    outputIndex,
    item: {
      id,
      type: 'image_generation_call',
      status: 'completed',
      result: index === 0 ? 'AQID' : 'BAUG',
    },
  }];
}

function harness(options: {
  execute?: ResponsesImageRequestScope['executeSelectedCall'];
  commit?: ResponsesImageRequestScope['commit'];
} = {}) {
  const lifecycle: string[] = [];
  const executeSelectedCall = vi.fn(options.execute ?? ((_, allocator) => {
    const index = executeSelectedCall.mock.calls.length - 1;
    return eventStream(imageEvents(index, allocator.reserveOutputIndex()));
  }));
  const commit = vi.fn(options.commit ?? (async () => { lifecycle.push('commit'); }));
  const waitForIdle = vi.fn(async () => { lifecycle.push('idle'); });
  const disposeScope = vi.fn(async () => { lifecycle.push('scope.dispose'); });
  const scope: ResponsesImageRequestScope = {
    executeSelectedCall,
    commit,
    waitForIdle,
    dispose: disposeScope,
  };
  const openRequest = vi.fn(async () => scope);
  const release = vi.fn(async () => { lifecycle.push('runtime.release'); });
  const runtime: ResponsesHostedImageRuntimeLease = {
    generationId: 'generation-test',
    inspectRequest: vi.fn(inspectResponsesImageRequest),
    validateSelection: vi.fn(validateResponsesImageSelection),
    openRequest,
    release,
  };
  const factory: ResponsesHostedImageRuntimeFactory = {
    acquire: vi.fn(async () => runtime),
  };
  const mediator = createNativeResponsesHostedImageMediator(factory, {
    createSelectorName: () => SELECTOR_NAME,
    createRequestId: () => 'hosted-image-request-test',
  });
  return {
    lifecycle,
    executeSelectedCall,
    commit,
    waitForIdle,
    disposeScope,
    openRequest,
    release,
    runtime,
    factory,
    mediator,
  };
}

async function prepare(
  mediator: ReturnType<typeof createNativeResponsesHostedImageMediator>,
  body: Record<string, unknown>,
  previousHostedImageState?: {
    readonly hasImageContext: boolean;
    readonly pendingReceipts: readonly {
      readonly upstreamCallId: string;
      readonly publicImageCallId: string;
    }[];
  },
) {
  const lease = await mediator.prepare({
    body,
    profile: 'native',
    operation: 'create',
    hostedImageGenerationAllowed: true,
    tenantId: 'tenant-test',
    sessionKey: 'session-test',
    authorizedPreviousResponseId: 'resp_previous',
    ...(previousHostedImageState ? { previousHostedImageState } : {}),
    mainProviderId: 'codex',
    signal: new AbortController().signal,
  });
  expect(lease).not.toBeNull();
  return lease!;
}

describe('Native Responses hosted image mediator — bounded JSON', () => {
  it('keeps ordinary Responses on the zero-acquisition fast path', async () => {
    const h = harness();
    await expect(h.mediator.prepare({
      body: { model: 'gpt-test', input: 'ordinary text' },
      profile: 'native',
      operation: 'create',
      hostedImageGenerationAllowed: false,
      sessionKey: 'session-test',
      mainProviderId: 'codex',
      signal: new AbortController().signal,
    })).resolves.toBeNull();
    expect(h.factory.acquire).not.toHaveBeenCalled();
  });

  it('preserves an automatic text selection without opening an image scope', async () => {
    const h = harness();
    const lease = await prepare(h.mediator, {
      input: 'answer or draw',
      tools: [{ type: 'image_generation' }],
    });
    const terminal = vi.fn(async () => undefined);
    const wrapped = await lease.wrapUpstreamResponse({
      response: new Response(JSON.stringify({
        id: 'resp_text_selection',
        status: 'completed',
        output: [{ id: 'msg_text', type: 'message', role: 'assistant', content: [] }],
      }), { status: 200 }),
      rawStatus: 200,
      onTerminalSuccess: terminal,
    });

    await expect(wrapped.json()).resolves.toMatchObject({ id: 'resp_text_selection' });
    expect(h.runtime.validateSelection).toHaveBeenCalledOnce();
    expect(h.openRequest).not.toHaveBeenCalled();
    expect(h.executeSelectedCall).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledWith('resp_text_selection', {
      hasImageContext: false,
      pendingReceipts: [],
    });
    await lease.dispose();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('releases an acquired runtime once when preparation fails', async () => {
    const h = harness();
    vi.mocked(h.runtime.inspectRequest).mockImplementation(() => {
      throw new Error('PRIVATE_INSPECTION_FAILURE');
    });
    let caught: unknown;
    try {
      await h.mediator.prepare({
        body: { input: 'draw', tools: [{ type: 'image_generation' }] },
        profile: 'native',
        operation: 'create',
        hostedImageGenerationAllowed: true,
        tenantId: 'tenant-test',
        sessionKey: 'session-test',
        mainProviderId: 'codex',
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAIOperationError);
    expect(caught).toMatchObject({ code: 'image_generation_failed', status: 502 });
    expect((caught as Error).message).not.toContain('PRIVATE_INSPECTION_FAILURE');
    expect(h.factory.acquire).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('injects receipts, executes selected calls, replaces mixed output in place, and commits before exposure', async () => {
    const h = harness();
    const body = {
      model: 'gpt-test',
      input: [
        { type: 'image_generation_call', id: 'ig_cccccccccccccccc' },
        { role: 'user', content: 'make two variants' },
      ],
      tools: [{ type: 'image_generation', size: '1024x1024' }],
      tool_choice: { type: 'image_generation' },
    };
    const lease = await prepare(h.mediator, body, {
      hasImageContext: true,
      pendingReceipts: [{
        upstreamCallId: 'call_previous',
        publicImageCallId: 'ig_cccccccccccccccc',
      }],
    });

    expect(lease.upstreamBody).not.toBe(body);
    expect((lease.upstreamBody.tools as Array<Record<string, unknown>>)[0]?.name).toBe(SELECTOR_NAME);
    expect(lease.upstreamBody.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_previous',
        output: '{"status":"completed","image_generation_call_id":"ig_cccccccccccccccc"}',
      },
      { role: 'user', content: 'make two variants' },
    ]);
    expect(body.input).toHaveLength(2);
    expect(body.tools).toEqual([{ type: 'image_generation', size: '1024x1024' }]);

    const terminal = vi.fn(async (_responseId, _state) => { h.lifecycle.push('terminal'); });
    const wrapped = await lease.wrapUpstreamResponse({
      response: new Response(JSON.stringify({
        id: 'resp_public',
        object: 'response',
        status: 'completed',
        output: [
          { id: 'rs_reasoning', type: 'reasoning', summary: [] },
          {
            id: 'fc_private_one', type: 'function_call', status: 'completed',
            call_id: 'call_private_one', name: SELECTOR_NAME,
            arguments: '{"prompt":"PRIVATE_PROMPT_ONE"}',
          },
          { id: 'msg_public', type: 'message', role: 'assistant', content: [] },
          {
            id: 'fc_private_two', type: 'function_call', status: 'completed',
            call_id: 'call_private_two', name: SELECTOR_NAME,
            arguments: '{"prompt":"PRIVATE_PROMPT_TWO"}',
          },
        ],
        tools: [{ type: 'function', name: SELECTOR_NAME }],
        tool_choice: { type: 'function', name: SELECTOR_NAME },
        usage: { input_tokens: 2, output_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': '9999' } }),
      rawStatus: 200,
      selectedMainAccountId: 'account-main',
      onTerminalSuccess: terminal,
    });

    const publicBody = await wrapped.json() as Record<string, unknown>;
    expect(publicBody.id).toBe('resp_public');
    expect(publicBody.output).toEqual([
      { id: 'rs_reasoning', type: 'reasoning', summary: [] },
      { id: 'ig_aaaaaaaaaaaaaaaa', type: 'image_generation_call', status: 'completed', result: 'AQID' },
      { id: 'msg_public', type: 'message', role: 'assistant', content: [] },
      { id: 'ig_bbbbbbbbbbbbbbbb', type: 'image_generation_call', status: 'completed', result: 'BAUG' },
    ]);
    expect(publicBody.tools).toEqual(body.tools);
    expect(publicBody.tool_choice).toEqual(body.tool_choice);
    expect(JSON.stringify(publicBody)).not.toContain(SELECTOR_NAME);
    expect(JSON.stringify(publicBody)).not.toContain('PRIVATE_PROMPT');
    expect(wrapped.headers.has('content-length')).toBe(false);

    expect(h.runtime.validateSelection).toHaveBeenCalledOnce();
    expect(h.executeSelectedCall).toHaveBeenCalledTimes(2);
    expect(h.openRequest).toHaveBeenCalledWith(expect.objectContaining({
      admission: expect.any(Object),
      tenantId: 'tenant-test',
      requestId: 'hosted-image-request-test',
      sessionKey: 'session-test',
      authorizedPreviousResponseId: 'resp_previous',
      mainProviderId: 'codex',
      selectedMainAccountId: 'account-main',
    }));
    expect(h.commit).toHaveBeenCalledWith('resp_public');
    expect(terminal).toHaveBeenCalledWith('resp_public', {
      hasImageContext: true,
      pendingReceipts: [
        { upstreamCallId: 'call_private_one', publicImageCallId: 'ig_aaaaaaaaaaaaaaaa' },
        { upstreamCallId: 'call_private_two', publicImageCallId: 'ig_bbbbbbbbbbbbbbbb' },
      ],
    });
    expect(h.lifecycle.indexOf('commit')).toBeLessThan(h.lifecycle.indexOf('terminal'));

    await lease.dispose();
    await lease.dispose();
    expect(h.disposeScope).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.lifecycle.indexOf('scope.dispose')).toBeLessThan(h.lifecycle.indexOf('runtime.release'));
  });

  it('carries inherited image context through a text-only middle turn', async () => {
    const h = harness();
    const lease = await prepare(h.mediator, {
      model: 'gpt-test',
      input: 'continue with text',
      previous_response_id: 'resp_previous',
    }, { hasImageContext: true, pendingReceipts: [] });
    const terminal = vi.fn(async () => undefined);
    const wrapped = await lease.wrapUpstreamResponse({
      response: new Response(JSON.stringify({
        id: 'resp_text_child',
        object: 'response',
        status: 'completed',
        output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [] }],
      }), { status: 200 }),
      rawStatus: 200,
      onTerminalSuccess: terminal,
    });

    await expect(wrapped.json()).resolves.toMatchObject({ id: 'resp_text_child' });
    expect(h.executeSelectedCall).not.toHaveBeenCalled();
    expect(h.commit).toHaveBeenCalledWith('resp_text_child');
    expect(terminal).toHaveBeenCalledWith('resp_text_child', {
      hasImageContext: true,
      pendingReceipts: [],
    });
    await lease.dispose();
  });

  it.each([
    ['non-success status', 429, { error: { code: 'rate_limit', message: 'retry later' } }],
    ['failed result', 200, { id: 'resp_failed', status: 'failed', output: [], error: { code: 'server_error' } }],
    ['incomplete result', 200, { id: 'resp_incomplete', status: 'incomplete', output: [] }],
  ])('preserves an upstream %s without starting image execution', async (_label, status, responseBody) => {
    const h = harness();
    const lease = await prepare(h.mediator, {
      input: 'draw', tools: [{ type: 'image_generation' }],
    });
    const upstream = new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const terminal = vi.fn(async () => undefined);
    const wrapped = await lease.wrapUpstreamResponse({
      response: upstream,
      rawStatus: status,
      onTerminalSuccess: terminal,
    });

    if (status !== 200) expect(wrapped).toBe(upstream);
    await expect(wrapped.json()).resolves.toEqual(responseBody);
    expect(h.runtime.validateSelection).not.toHaveBeenCalled();
    expect(h.openRequest).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    await lease.dispose();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('rejects malformed or oversized upstream JSON with a sanitized stable error', async () => {
    const h = harness();
    const mediator = createNativeResponsesHostedImageMediator(h.factory, {
      maxUpstreamJsonBytes: 256,
      createSelectorName: () => SELECTOR_NAME,
    });
    const lease = await prepare(mediator, {
      input: 'draw', tools: [{ type: 'image_generation' }],
    });
    const privateSentinel = 'PRIVATE_ARGUMENT_SENTINEL';
    const invoke = () => lease.wrapUpstreamResponse({
      response: new Response(JSON.stringify({
        id: 'resp_oversized', status: 'completed',
        output: [{
          id: 'fc_private', type: 'function_call', status: 'completed',
          call_id: 'call_private', name: SELECTOR_NAME,
          arguments: `{"prompt":"${privateSentinel.repeat(20)}"}`,
        }],
      }), { status: 200 }),
      rawStatus: 200,
      onTerminalSuccess: vi.fn(),
    });

    let caught: unknown;
    try {
      await invoke();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenAIOperationError);
    expect(caught).toMatchObject({ code: 'upstream_protocol_changed', status: 502 });
    expect((caught as Error).message).not.toContain(privateSentinel);
    expect((caught as Error).message).not.toContain(SELECTOR_NAME);
    expect(h.openRequest).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it('withholds terminal success when image execution or commit fails', async () => {
    const h = harness({
      execute: (_call, allocator) => eventStream([{
        kind: 'failed',
        outputIndex: allocator.reserveOutputIndex(),
        error: {
          type: 'image_generation_error',
          code: 'moderation_blocked',
          message: 'UNTRUSTED_PROVIDER_MESSAGE',
          httpStatus: 422,
        },
      }]),
    });
    const lease = await prepare(h.mediator, {
      input: 'draw', tools: [{ type: 'image_generation' }],
    });
    const terminal = vi.fn();
    let caught: unknown;
    try {
      await lease.wrapUpstreamResponse({
        response: new Response(JSON.stringify({
          id: 'resp_image_failure', status: 'completed', output: [{
            id: 'fc_private', type: 'function_call', status: 'completed',
            call_id: 'call_private', name: SELECTOR_NAME,
            arguments: '{"prompt":"PRIVATE_PROMPT"}',
          }],
        }), { status: 200 }),
        rawStatus: 200,
        onTerminalSuccess: terminal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAIOperationError);
    expect(caught).toMatchObject({ code: 'moderation_blocked', status: 422 });
    expect((caught as Error).message).not.toContain('UNTRUSTED_PROVIDER_MESSAGE');
    expect((caught as Error).message).not.toContain('PRIVATE_PROMPT');
    expect(h.commit).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    await lease.dispose();
    expect(h.disposeScope).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('maps commit failure safely and still finalizes the scope before the runtime', async () => {
    const h = harness({ commit: async () => { throw new Error('SECRET_COMMIT_FAILURE'); } });
    const lease = await prepare(h.mediator, {
      input: 'draw', tools: [{ type: 'image_generation' }],
    });
    const terminal = vi.fn();
    let caught: unknown;
    try {
      await lease.wrapUpstreamResponse({
        response: new Response(JSON.stringify({
          id: 'resp_commit_failure', status: 'completed', output: [{
            id: 'fc_private', type: 'function_call', status: 'completed',
            call_id: 'call_private', name: SELECTOR_NAME,
            arguments: '{"prompt":"draw"}',
          }],
        }), { status: 200 }),
        rawStatus: 200,
        onTerminalSuccess: terminal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OpenAIOperationError);
    expect(caught).toMatchObject({ code: 'image_generation_failed', status: 502 });
    expect((caught as Error).message).not.toContain('SECRET_COMMIT_FAILURE');
    expect(terminal).not.toHaveBeenCalled();
    await lease.dispose();
    expect(h.lifecycle.indexOf('scope.dispose')).toBeLessThan(h.lifecycle.indexOf('runtime.release'));
  });
});

describe('Native Responses hosted image mediator — bounded SSE', () => {
  it('replaces a mixed selector slot with real partials and gates the unique terminal success', async () => {
    const commitGate = deferred();
    let commitStarted = false;
    const h = harness({
      execute: (_call, allocator) => ({
        async *[Symbol.asyncIterator]() {
          const outputIndex = allocator.reserveOutputIndex();
          yield {
            kind: 'started' as const,
            outputIndex,
            item: { id: 'ig_aaaaaaaaaaaaaaaa' as const, type: 'image_generation_call' as const, status: 'in_progress' as const },
          };
          yield {
            type: 'response.image_generation_call.partial_image' as const,
            output_index: outputIndex,
            item_id: 'ig_aaaaaaaaaaaaaaaa' as const,
            sequence_number: allocator.nextSequenceNumber(),
            partial_image_index: 0,
            partial_image_b64: 'AQI=',
          };
          yield {
            kind: 'completed' as const,
            outputIndex,
            item: {
              id: 'ig_aaaaaaaaaaaaaaaa' as const,
              type: 'image_generation_call' as const,
              status: 'completed' as const,
              result: 'AwQ=',
            },
          };
        },
      }),
      commit: async () => {
        commitStarted = true;
        await commitGate.promise;
      },
    });
    const body = {
      model: 'gpt-test',
      input: '请画一只猫',
      stream: true,
      tools: [{ type: 'image_generation', partial_images: 1 }],
      tool_choice: { type: 'image_generation' },
    };
    const lease = await prepare(h.mediator, body);
    const reasoning = { id: 'rs_visible', type: 'reasoning', status: 'completed', summary: [] };
    const selector = {
      id: 'fc_private',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_private',
      name: SELECTOR_NAME,
      arguments: '{"prompt":"私密提示词"}',
    };
    const selectorStarted = { ...selector, status: 'in_progress', arguments: '' };
    const message = {
      id: 'msg_visible', type: 'message', status: 'completed', role: 'assistant', content: [],
    };
    const upstreamText = [
      sseEvent({
        type: 'response.created', sequence_number: 40,
        response: {
          id: 'resp_stream', object: 'response', status: 'in_progress', model: 'upstream-model',
          output: [], tools: [{ type: 'function', name: SELECTOR_NAME }],
          tool_choice: { type: 'function', name: SELECTOR_NAME },
        },
      }, '\r\n', true),
      sseEvent({
        type: 'response.output_item.added', sequence_number: 41,
        output_index: 0, item: { ...reasoning, status: 'in_progress' },
      }, '\n'),
      sseEvent({
        type: 'response.output_item.done', sequence_number: 42,
        output_index: 0, item: reasoning,
      }, '\r\n'),
      sseEvent({
        type: 'response.output_item.added', sequence_number: 43,
        output_index: 1, item: selectorStarted,
      }, '\n'),
      sseEvent({
        type: 'response.function_call_arguments.delta', sequence_number: 44,
        output_index: 1, item_id: 'fc_private', delta: '{"prompt":"私密',
      }, '\r\n'),
      sseEvent({
        type: 'response.function_call_arguments.done', sequence_number: 45,
        output_index: 1, item_id: 'fc_private', arguments: selector.arguments,
      }, '\n'),
      sseEvent({
        type: 'response.output_item.done', sequence_number: 46,
        output_index: 1, item: selector,
      }, '\r\n'),
      sseEvent({
        type: 'response.output_item.added', sequence_number: 47,
        output_index: 2, item: { ...message, status: 'in_progress' },
      }, '\n'),
      sseEvent({
        type: 'response.output_item.done', sequence_number: 48,
        output_index: 2, item: message,
      }, '\r\n'),
      // No final blank line: EOF must dispatch this terminal frame.
      `event: response.completed\r\ndata: ${JSON.stringify({
        type: 'response.completed', sequence_number: 49,
        response: {
          id: 'resp_stream', object: 'response', status: 'completed', model: 'upstream-model',
          output: [reasoning, selector, message],
          tools: [{ type: 'function', name: SELECTOR_NAME }],
          tool_choice: { type: 'function', name: SELECTOR_NAME },
          usage: { input_tokens: 7, output_tokens: 5 },
        },
      })}`,
    ].join('');
    const terminal = vi.fn(async () => undefined);
    const wrapped = await lease.wrapUpstreamResponse({
      response: chunkedSseResponse(upstreamText),
      rawStatus: 200,
      selectedMainAccountId: 'account-main',
      onTerminalSuccess: terminal,
    });
    let settled = false;
    const streamed = wrapped.text().then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(commitStarted).toBe(true));
    expect(settled).toBe(false);
    expect(terminal).not.toHaveBeenCalled();
    commitGate.resolve();
    const publicText = await streamed;
    const events = parseSseEvents(publicText);

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.added',
      'response.image_generation_call.partial_image',
      'response.image_generation_call.completed',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_, index) => index),
    );
    const imageEvents = events.filter((event) =>
      (event.type === 'response.output_item.added' &&
        (event.item as Record<string, unknown>)?.type === 'image_generation_call') ||
      String(event.type).startsWith('response.image_generation_call.') ||
      (event.type === 'response.output_item.done' &&
        (event.item as Record<string, unknown>)?.type === 'image_generation_call')
    );
    expect(imageEvents.map((event) => event.output_index)).toEqual([1, 1, 1, 1]);
    expect(events.filter((event) => event.type === 'response.image_generation_call.partial_image'))
      .toEqual([expect.objectContaining({ partial_image_b64: 'AQI=', item_id: 'ig_aaaaaaaaaaaaaaaa' })]);
    const completed = events.at(-1)!;
    expect(completed).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_stream', model: 'upstream-model',
        usage: { input_tokens: 7, output_tokens: 5 },
        tools: body.tools,
        tool_choice: body.tool_choice,
        output: [
          reasoning,
          { id: 'ig_aaaaaaaaaaaaaaaa', type: 'image_generation_call', status: 'completed', result: 'AwQ=' },
          message,
        ],
      },
    });
    expect(publicText).not.toContain(SELECTOR_NAME);
    expect(publicText).not.toContain('call_private');
    expect(publicText).not.toContain('fc_private');
    expect(publicText).not.toContain('私密提示词');
    expect(terminal).toHaveBeenCalledWith('resp_stream', {
      hasImageContext: true,
      pendingReceipts: [{
        upstreamCallId: 'call_private', publicImageCallId: 'ig_aaaaaaaaaaaaaaaa',
      }],
    });
    await lease.dispose();
    expect(h.disposeScope).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('turns malformed upstream data into one sanitized response.failed terminal', async () => {
    const h = harness();
    const lease = await prepare(h.mediator, {
      input: 'draw', stream: true, tools: [{ type: 'image_generation' }],
    });
    const upstream = [
      sseEvent({
        type: 'response.created', sequence_number: 1,
        response: { id: 'resp_malformed', object: 'response', status: 'in_progress', model: 'upstream-model', output: [] },
      }),
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","private":"DO_NOT_LEAK"\n\n`,
      sseEvent({
        type: 'response.completed', sequence_number: 2,
        response: { id: 'resp_malformed', status: 'completed', output: [] },
      }),
    ].join('');
    const wrapped = await lease.wrapUpstreamResponse({
      response: chunkedSseResponse(upstream, 2),
      rawStatus: 200,
      onTerminalSuccess: vi.fn(),
    });
    const text = await wrapped.text();
    const events = parseSseEvents(text);

    expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { id: 'resp_malformed', status: 'failed', error: { code: 'upstream_protocol_changed' } },
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
    expect(text).not.toContain('DO_NOT_LEAK');
    expect(h.openRequest).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it('bounds an oversized SSE event and never reflects its private payload', async () => {
    const h = harness();
    const mediator = createNativeResponsesHostedImageMediator(h.factory, {
      maxUpstreamJsonBytes: 256,
      createSelectorName: () => SELECTOR_NAME,
      createRequestId: () => 'hosted-image-request-test',
    });
    const lease = await prepare(mediator, {
      input: 'draw', stream: true, tools: [{ type: 'image_generation' }],
    });
    const privatePayload = 'PRIVATE_OVERSIZED_PAYLOAD'.repeat(40);
    const upstream = [
      sseEvent({
        type: 'response.created', sequence_number: 0,
        response: { id: 'resp_oversized_stream', status: 'in_progress', output: [] },
      }),
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta', sequence_number: 1, delta: privatePayload,
      })}\n\n`,
    ].join('');
    const wrapped = await lease.wrapUpstreamResponse({
      response: chunkedSseResponse(upstream, 7), rawStatus: 200, onTerminalSuccess: vi.fn(),
    });
    const text = await wrapped.text();
    const events = parseSseEvents(text);

    expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { id: 'resp_oversized_stream', error: { code: 'upstream_protocol_changed' } },
    });
    expect(text).not.toContain(privatePayload);
    expect(h.openRequest).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it('emits no completed item or later Base64 after an image provider failure', async () => {
    const h = harness({
      execute: (_call, allocator) => ({
        async *[Symbol.asyncIterator]() {
          const outputIndex = allocator.reserveOutputIndex();
          yield {
            kind: 'started' as const, outputIndex,
            item: { id: 'ig_aaaaaaaaaaaaaaaa' as const, type: 'image_generation_call' as const, status: 'in_progress' as const },
          };
          yield {
            type: 'response.image_generation_call.partial_image' as const,
            output_index: outputIndex,
            item_id: 'ig_aaaaaaaaaaaaaaaa' as const,
            sequence_number: allocator.nextSequenceNumber(),
            partial_image_index: 0,
            partial_image_b64: 'EARLY_BASE64',
          };
          yield {
            kind: 'failed' as const, outputIndex, callId: 'ig_aaaaaaaaaaaaaaaa' as const,
            error: {
              type: 'image_generation_error' as const, code: 'image_generation_failed' as const,
              message: 'UNTRUSTED_PROVIDER_DETAIL', httpStatus: 502,
            },
          };
        },
      }),
    });
    const lease = await prepare(h.mediator, {
      input: 'draw', stream: true, tools: [{ type: 'image_generation', partial_images: 1 }],
    });
    const selector = {
      id: 'fc_private', type: 'function_call', status: 'completed',
      call_id: 'call_private', name: SELECTOR_NAME, arguments: '{"prompt":"SECRET_PROMPT"}',
    };
    const upstream = [
      sseEvent({
        type: 'response.created', sequence_number: 0,
        response: { id: 'resp_provider_failure', status: 'in_progress', model: 'upstream-model', output: [] },
      }),
      sseEvent({
        type: 'response.output_item.added', sequence_number: 1, output_index: 0,
        item: { ...selector, status: 'in_progress', arguments: '' },
      }),
      sseEvent({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: selector }),
      sseEvent({
        type: 'response.completed', sequence_number: 3,
        response: {
          id: 'resp_provider_failure', status: 'completed', model: 'upstream-model', output: [selector],
        },
      }),
    ].join('');
    const terminal = vi.fn();
    const wrapped = await lease.wrapUpstreamResponse({
      response: chunkedSseResponse(upstream, 3), rawStatus: 200, onTerminalSuccess: terminal,
    });
    const text = await wrapped.text();
    const events = parseSseEvents(text);

    expect(events.filter((event) => event.type === 'response.failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { id: 'resp_provider_failure', error: { code: 'image_generation_failed' } },
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
    expect(events.some((event) => event.type === 'response.image_generation_call.completed')).toBe(false);
    expect(text).toContain('EARLY_BASE64');
    expect(text).not.toContain('UNTRUSTED_PROVIDER_DETAIL');
    expect(text).not.toContain('SECRET_PROMPT');
    expect(terminal).not.toHaveBeenCalled();
    await lease.dispose();
  });

  it('cancels the upstream reader and finalizes the runtime once when the client stops reading', async () => {
    let upstreamCancelled = 0;
    const h = harness();
    const lease = await prepare(h.mediator, {
      input: 'draw', stream: true, tools: [{ type: 'image_generation' }],
    });
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseEvent({
          type: 'response.created', sequence_number: 0,
          response: { id: 'resp_cancelled', status: 'in_progress', model: 'upstream-model', output: [] },
        })));
      },
      cancel() {
        upstreamCancelled += 1;
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const wrapped = await lease.wrapUpstreamResponse({
      response: upstream, rawStatus: 200, onTerminalSuccess: vi.fn(),
    });
    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel(new Error('client stopped'));
    await lease.dispose();
    await lease.dispose();

    expect(upstreamCancelled).toBe(1);
    expect(h.openRequest).not.toHaveBeenCalled();
    expect(h.disposeScope).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('closes an active image iterator and disposes its scope exactly once on cancellation', async () => {
    let nextCount = 0;
    let resolvePending: ((value: IteratorResult<ResponsesImageExecutionEvent>) => void) | undefined;
    const closeIterator = vi.fn(async () => {
      resolvePending?.({ done: true, value: undefined });
      return { done: true, value: undefined } as IteratorResult<ResponsesImageExecutionEvent>;
    });
    const h = harness({
      execute: (_call, allocator) => ({
        [Symbol.asyncIterator]() {
          const outputIndex = allocator.reserveOutputIndex();
          return {
            next: async (): Promise<IteratorResult<ResponsesImageExecutionEvent>> => {
              nextCount += 1;
              if (nextCount === 1) {
                return {
                  done: false,
                  value: {
                    kind: 'started', outputIndex,
                    item: {
                      id: 'ig_aaaaaaaaaaaaaaaa', type: 'image_generation_call', status: 'in_progress',
                    },
                  },
                };
              }
              return new Promise((resolve) => { resolvePending = resolve; });
            },
            return: closeIterator,
          };
        },
      }),
    });
    const lease = await prepare(h.mediator, {
      input: 'draw', stream: true, tools: [{ type: 'image_generation' }],
    });
    const selector = {
      id: 'fc_private', type: 'function_call', status: 'completed',
      call_id: 'call_private', name: SELECTOR_NAME, arguments: '{"prompt":"SECRET_PROMPT"}',
    };
    const upstream = [
      sseEvent({
        type: 'response.created', sequence_number: 0,
        response: { id: 'resp_active_cancel', status: 'in_progress', model: 'upstream-model', output: [] },
      }),
      sseEvent({
        type: 'response.output_item.added', sequence_number: 1, output_index: 0,
        item: { ...selector, status: 'in_progress', arguments: '' },
      }),
      sseEvent({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: selector }),
      sseEvent({
        type: 'response.completed', sequence_number: 3,
        response: { id: 'resp_active_cancel', status: 'completed', model: 'upstream-model', output: [selector] },
      }),
    ].join('');
    const terminal = vi.fn();
    const wrapped = await lease.wrapUpstreamResponse({
      response: chunkedSseResponse(upstream, 4), rawStatus: 200, onTerminalSuccess: terminal,
    });
    const reader = wrapped.body!.getReader();
    for (;;) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      const events = parseSseEvents(new TextDecoder().decode(next.value));
      if (events.some((event) =>
        event.type === 'response.output_item.added' &&
        (event.item as Record<string, unknown>)?.type === 'image_generation_call')) {
        break;
      }
    }
    await vi.waitFor(() => expect(nextCount).toBeGreaterThanOrEqual(2));
    await reader.cancel(new Error('client stopped during image execution'));
    await lease.dispose();
    await lease.dispose();

    expect(closeIterator).toHaveBeenCalledOnce();
    expect(h.commit).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(h.disposeScope).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });
});
