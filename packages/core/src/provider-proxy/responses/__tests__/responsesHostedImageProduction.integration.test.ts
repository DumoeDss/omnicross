import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
  type ResponsesImageExecutionEvent,
  type ResponsesImageRequestScope,
} from '../../../image-generation/responses';
import type { ProviderConfigSource } from '../../../ports';
import {
  createNativeResponsesHostedImageIngress,
  ProviderProxy,
} from '../../index';
import type {
  ProviderProxyDeps,
  RouteContext,
  UsageRecorderImport,
} from '../../types';
import { getResponsesAffinityStore } from '../responsesAffinity';
import type {
  ResponsesHostedImageRuntimeFactory,
  ResponsesHostedImageRuntimeLease,
} from '../responsesHostedImageIngress';

const SELECTOR_NAME = '__omnicross_production_json_selector';
const IMAGE_CALL_ID = 'ig_1234567890abcdef' as const;
const IMAGE_RESULT = 'AQIDBA==';
const ORDINARY_RESPONSE_TEXT = '{"id":"resp_ordinary", "object":"response", "status":"completed", "model":"gpt-native", "output":[{"id":"msg_ordinary","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ordinary response"}]}], "usage":{"input_tokens":2,"output_tokens":3}}';

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    events.push(JSON.parse(data) as Record<string, unknown>);
  }
  return events;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function eventStream(
  events: readonly ResponsesImageExecutionEvent[],
): AsyncIterable<ResponsesImageExecutionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function runtimeHarness(options: {
  readonly executeSelectedCall?: ResponsesImageRequestScope['executeSelectedCall'];
} = {}) {
  const lifecycle: string[] = [];
  const commit = vi.fn(async () => undefined);
  const waitForIdle = vi.fn(async () => { lifecycle.push('scope.idle'); });
  const disposeScope = vi.fn(async () => { lifecycle.push('scope.dispose'); });
  const defaultExecuteSelectedCall = (
    _call: Parameters<ResponsesImageRequestScope['executeSelectedCall']>[0],
    allocator: Parameters<ResponsesImageRequestScope['executeSelectedCall']>[1],
  ) => {
    const outputIndex = allocator.reserveOutputIndex();
    return eventStream([{
      kind: 'started',
      outputIndex,
      item: {
        id: IMAGE_CALL_ID,
        type: 'image_generation_call',
        status: 'in_progress',
      },
    }, {
      kind: 'completed',
      outputIndex,
      item: {
        id: IMAGE_CALL_ID,
        type: 'image_generation_call',
        status: 'completed',
        result: IMAGE_RESULT,
      },
    }]);
  };
  const executeSelectedCall = vi.fn(options.executeSelectedCall ?? defaultExecuteSelectedCall);
  const scope: ResponsesImageRequestScope = {
    executeSelectedCall,
    commit,
    waitForIdle,
    dispose: disposeScope,
  };
  const openRequest = vi.fn(async () => scope);
  const release = vi.fn(async () => { lifecycle.push('runtime.release'); });
  const runtime: ResponsesHostedImageRuntimeLease = {
    generationId: 'production-json-generation',
    inspectRequest: vi.fn(inspectResponsesImageRequest),
    validateSelection: vi.fn(validateResponsesImageSelection),
    openRequest,
    release,
  };
  const factory: ResponsesHostedImageRuntimeFactory = {
    acquire: vi.fn(async () => runtime),
  };
  return {
    commit,
    disposeScope,
    executeSelectedCall,
    factory,
    lifecycle,
    openRequest,
    release,
    runtime,
    waitForIdle,
  };
}

function llmConfig(
  upstreamUrl: string,
  apiFormat: 'openai-response' | 'openai' = 'openai-response',
): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => ({
      id: 'native',
      name: 'Native',
      apiFormat,
      api_base_url: upstreamUrl,
      api_key: 'upstream-test-key',
      models: ['gpt-native'],
      enabled: true,
    })),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function route(
  hostedImageGenerationAllowed: boolean,
  requestedModel?: string,
): RouteContext {
  return {
    sessionId: 'production-json-session',
    apiKeyId: 'production-json-key',
    hostedImageGenerationAllowed,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ...(requestedModel ? { requestedModel } : {}),
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'native',
  };
}

function request(
  proxyPort: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function requestAndDisconnectAfter(
  proxyPort: number,
  token: string,
  body: Record<string, unknown>,
  marker: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (received: string): void => {
      if (settled) return;
      settled = true;
      resolve(received);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let received = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        received += chunk;
        if (!received.includes(marker)) return;
        res.destroy();
        req.destroy();
        finish(received);
      });
      res.once('end', () => fail(new Error(`stream ended before marker ${marker}`)));
      res.once('error', fail);
    });
    req.once('error', fail);
    req.end(payload);
  });
}

describe('Native Responses hosted image production JSON integration', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  async function setup(options: {
    readonly factory?: ResponsesHostedImageRuntimeFactory;
    readonly apiFormat?: 'openai-response' | 'openai';
    readonly permission?: boolean;
    readonly requestedModel?: string;
    readonly usageRecorder?: UsageRecorderImport;
  } = {}): Promise<{
    deps: ProviderProxyDeps;
    proxyPort: number;
    suppressAuditBodies: ReturnType<typeof vi.fn>;
    token: string;
    upstreamBodies: Array<Record<string, unknown>>;
  }> {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        upstreamBodies.push(body);
        const selector = Array.isArray(body.tools)
          ? body.tools.find((tool) => (
              !!tool && typeof tool === 'object' &&
              (tool as Record<string, unknown>).type === 'function' &&
              (tool as Record<string, unknown>).name === SELECTOR_NAME
            )) as Record<string, unknown> | undefined
          : undefined;
        const selectorCall = {
          id: 'fc_private_image',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_private_image',
          name: SELECTOR_NAME,
          arguments: '{"prompt":"model-selected production prompt"}',
        };
        const output = selector
          ? [selectorCall]
          : [{
              id: 'msg_ordinary',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'ordinary response' }],
            }];
        if (selector && body.stream === true) {
          const response = {
            id: 'resp_production_stream',
            object: 'response',
            status: 'completed',
            model: 'gpt-native',
            output: [selectorCall],
            tools: [{ type: 'function', name: SELECTOR_NAME }],
            tool_choice: { type: 'function', name: SELECTOR_NAME },
            usage: { input_tokens: 5, output_tokens: 4 },
          };
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'x-request-id': 'req_hosted_image_stream',
          });
          res.write([
            sseEvent({
              type: 'response.created',
              sequence_number: 20,
              response: { ...response, status: 'in_progress', output: [] },
            }),
            sseEvent({
              type: 'response.output_item.added',
              sequence_number: 21,
              output_index: 0,
              item: { ...selectorCall, status: 'in_progress', arguments: '' },
            }),
            sseEvent({
              type: 'response.function_call_arguments.done',
              sequence_number: 22,
              output_index: 0,
              item_id: selectorCall.id,
              arguments: selectorCall.arguments,
            }),
            sseEvent({
              type: 'response.output_item.done',
              sequence_number: 23,
              output_index: 0,
              item: selectorCall,
            }),
            sseEvent({
              type: 'response.completed',
              sequence_number: 24,
              response,
            }),
          ].join(''));
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'openai-version': '2026-08-31',
          'x-request-id': selector ? 'req_hosted_image' : 'req_ordinary_byte_path',
        });
        res.end(selector
          ? JSON.stringify({
              id: 'resp_production_image',
              object: 'response',
              status: 'completed',
              model: 'gpt-native',
              output,
              usage: { input_tokens: 2, output_tokens: 3 },
            })
          : ORDINARY_RESPONSE_TEXT);
      });
    });
    const upstreamPort = await listen(upstream);
    const deps: ProviderProxyDeps = {
      llmConfig: llmConfig(
        `http://127.0.0.1:${upstreamPort}/v1`,
        options.apiFormat,
      ),
      ...(options.factory
        ? {
            responsesHostedImageIngress: createNativeResponsesHostedImageIngress(
              options.factory,
              { createSelectorName: () => SELECTOR_NAME },
            ),
          }
        : {}),
      ...(options.usageRecorder ? { usageRecorder: options.usageRecorder } : {}),
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const suppressAuditBodies = vi.fn();
    const token = proxy.addRoute({
      ...route(
        options.permission ?? true,
        options.requestedModel,
      ),
      suppressAuditBodies,
    });
    return { deps, proxyPort, suppressAuditBodies, token, upstreamBodies };
  }

  it('preserves public identity, model/usage attribution, and hosted affinity metadata', async () => {
    const harness = runtimeHarness();
    const usageRecorder: UsageRecorderImport = { record: vi.fn() };
    const {
      deps,
      proxyPort,
      suppressAuditBodies,
      token,
      upstreamBodies,
    } = await setup({
      factory: harness.factory,
      requestedModel: 'client-visible-model',
      usageRecorder,
    });
    const affinityStore = getResponsesAffinityStore(deps);
    const affinityRecordSpy = vi.spyOn(affinityStore, 'record');
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw through the production ingress',
      tools: [{ type: 'image_generation', size: '1024x1024' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'resp_production_image',
      status: 'completed',
      model: 'client-visible-model',
      output: [{
        id: IMAGE_CALL_ID,
        type: 'image_generation_call',
        status: 'completed',
        result: IMAGE_RESULT,
      }],
    });
    expect(JSON.stringify(body)).not.toContain(SELECTOR_NAME);
    expect(JSON.stringify(body)).not.toContain('model-selected production prompt');
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]?.model).toBe('gpt-native');
    expect(upstreamBodies[0]?.tools).toEqual([expect.objectContaining({
      type: 'function',
      name: SELECTOR_NAME,
      strict: true,
    })]);
    expect(upstreamBodies[0]?.tool_choice).toEqual({
      type: 'function',
      name: SELECTOR_NAME,
    });
    expect(harness.factory.acquire).toHaveBeenCalledOnce();
    expect(suppressAuditBodies).toHaveBeenCalledOnce();
    expect(harness.runtime.inspectRequest).toHaveBeenCalledOnce();
    expect(harness.runtime.validateSelection).toHaveBeenCalledOnce();
    expect(harness.openRequest).toHaveBeenCalledOnce();
    expect(harness.executeSelectedCall).toHaveBeenCalledWith(
      { prompt: 'model-selected production prompt' },
      expect.any(Object),
    );
    expect(harness.commit).toHaveBeenCalledWith('resp_production_image');
    expect(harness.disposeScope).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(usageRecorder.record).toHaveBeenCalledOnce();
    expect(usageRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'production-json-session',
      providerId: 'native',
      model: 'gpt-native',
      apiKeyId: 'production-json-key',
      engineOrigin: 'codex-ingress',
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    }));

    expect(affinityRecordSpy).toHaveBeenCalledTimes(2);
    for (const [record] of affinityRecordSpy.mock.calls) {
      expect(record).toMatchObject({
        responseId: 'resp_production_image',
        credential: { kind: 'provider-key', id: 'native' },
        hostedImage: {
          hasImageContext: true,
          pendingReceipts: [{
            upstreamCallId: 'call_private_image',
            publicImageCallId: IMAGE_CALL_ID,
          }],
        },
      });
    }
    const recorded = affinityRecordSpy.mock.calls.at(-1)?.[0];
    expect(recorded).toBeDefined();
    const stored = affinityStore.lookup('resp_production_image', {
      providerId: recorded!.providerId,
      clientScope: recorded!.clientScope,
      sessionKey: recorded!.sessionKey,
    });
    expect(stored).toMatchObject({
      responseId: 'resp_production_image',
      credential: { kind: 'provider-key', id: 'native' },
      hostedImage: {
        hasImageContext: true,
        pendingReceipts: [{
          upstreamCallId: 'call_private_image',
          publicImageCallId: IMAGE_CALL_ID,
        }],
      },
    });
  });

  it('relays real hosted-image partials and completion through ProviderProxy HTTP SSE', async () => {
    const harness = runtimeHarness({
      executeSelectedCall: (_call, allocator) => ({
        async *[Symbol.asyncIterator]() {
          const outputIndex = allocator.reserveOutputIndex();
          yield {
            kind: 'started' as const,
            outputIndex,
            item: {
              id: IMAGE_CALL_ID,
              type: 'image_generation_call' as const,
              status: 'in_progress' as const,
            },
          };
          yield {
            type: 'response.image_generation_call.partial_image' as const,
            output_index: outputIndex,
            item_id: IMAGE_CALL_ID,
            sequence_number: allocator.nextSequenceNumber(),
            partial_image_index: 0,
            partial_image_b64: 'AQI=',
          };
          yield {
            kind: 'completed' as const,
            outputIndex,
            item: {
              id: IMAGE_CALL_ID,
              type: 'image_generation_call' as const,
              status: 'completed' as const,
              result: IMAGE_RESULT,
            },
          };
        },
      }),
    });
    const {
      proxyPort,
      suppressAuditBodies,
      token,
    } = await setup({ factory: harness.factory });
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw through the production SSE relay',
      stream: true,
      tools: [{ type: 'image_generation', partial_images: 1 }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    const events = parseSseEvents(text);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.image_generation_call.partial_image',
      'response.image_generation_call.completed',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_, index) => index),
    );
    expect(events.filter((event) => (
      event.type === 'response.image_generation_call.partial_image'
    ))).toEqual([expect.objectContaining({
      output_index: 0,
      item_id: IMAGE_CALL_ID,
      partial_image_index: 0,
      partial_image_b64: 'AQI=',
    })]);
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'resp_production_stream',
        status: 'completed',
        output: [{
          id: IMAGE_CALL_ID,
          type: 'image_generation_call',
          status: 'completed',
          result: IMAGE_RESULT,
        }],
        usage: { input_tokens: 5, output_tokens: 4 },
      },
    });
    expect(text).not.toContain(SELECTOR_NAME);
    expect(text).not.toContain('model-selected production prompt');
    expect(suppressAuditBodies).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith('resp_production_stream');
    expect(harness.waitForIdle).toHaveBeenCalledTimes(2);
    expect(harness.disposeScope).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.lifecycle.indexOf('scope.dispose'))
      .toBeLessThan(harness.lifecycle.indexOf('runtime.release'));
  });

  it('cancels the upstream reader and releases hosted resources after an HTTP client disconnect', async () => {
    let nextCount = 0;
    let resolvePending:
      ((value: IteratorResult<ResponsesImageExecutionEvent>) => void) | undefined;
    const closeIterator = vi.fn(async () => {
      resolvePending?.({ done: true, value: undefined });
      return { done: true, value: undefined } as IteratorResult<ResponsesImageExecutionEvent>;
    });
    const harness = runtimeHarness({
      executeSelectedCall: (_call, allocator) => ({
        [Symbol.asyncIterator]() {
          const outputIndex = allocator.reserveOutputIndex();
          return {
            next: async (): Promise<IteratorResult<ResponsesImageExecutionEvent>> => {
              nextCount += 1;
              if (nextCount === 1) {
                return {
                  done: false,
                  value: {
                    kind: 'started',
                    outputIndex,
                    item: {
                      id: IMAGE_CALL_ID,
                      type: 'image_generation_call',
                      status: 'in_progress',
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
    const upstreamReaderCancelled = vi.fn();
    const {
      proxyPort,
      suppressAuditBodies,
      token,
    } = await setup({ factory: harness.factory });
    const selectorCall = {
      id: 'fc_private_image',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_private_image',
      name: SELECTOR_NAME,
      arguments: '{"prompt":"model-selected production prompt"}',
    };
    const terminalResponse = {
      id: 'resp_production_disconnect',
      object: 'response',
      status: 'completed',
      model: 'gpt-native',
      output: [selectorCall],
      tools: [{ type: 'function', name: SELECTOR_NAME }],
      tool_choice: { type: 'function', name: SELECTOR_NAME },
      usage: { input_tokens: 5, output_tokens: 4 },
    };
    const upstreamText = [
      sseEvent({
        type: 'response.created',
        sequence_number: 30,
        response: { ...terminalResponse, status: 'in_progress', output: [] },
      }),
      sseEvent({
        type: 'response.output_item.added',
        sequence_number: 31,
        output_index: 0,
        item: { ...selectorCall, status: 'in_progress', arguments: '' },
      }),
      sseEvent({
        type: 'response.output_item.done',
        sequence_number: 32,
        output_index: 0,
        item: selectorCall,
      }),
      sseEvent({
        type: 'response.completed',
        sequence_number: 33,
        response: terminalResponse,
      }),
    ].join('');
    const upstreamResponse = new Response(upstreamText, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
    const upstreamBody = upstreamResponse.body!;
    const getReader = upstreamBody.getReader.bind(upstreamBody);
    Object.defineProperty(upstreamBody, 'getReader', {
      configurable: true,
      value: () => {
        const reader = getReader();
        const cancel = reader.cancel.bind(reader);
        Object.defineProperty(reader, 'cancel', {
          configurable: true,
          value: (reason?: unknown) => {
            upstreamReaderCancelled(reason);
            return cancel(reason);
          },
        });
        return reader;
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => upstreamResponse) as unknown as typeof fetch;
    try {
      const received = await requestAndDisconnectAfter(proxyPort, token, {
        model: 'client-model',
        input: 'disconnect during image execution',
        stream: true,
        tools: [{ type: 'image_generation', partial_images: 1 }],
        tool_choice: { type: 'image_generation' },
      }, `"id":"${IMAGE_CALL_ID}"`);

      await vi.waitFor(() => expect(upstreamReaderCancelled).toHaveBeenCalled());
      await vi.waitFor(() => expect(closeIterator).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(harness.disposeScope).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(harness.release).toHaveBeenCalledOnce());
      expect(suppressAuditBodies).toHaveBeenCalledOnce();
      expect(nextCount).toBeGreaterThanOrEqual(2);
      expect(harness.commit).not.toHaveBeenCalled();
      expect(received).not.toContain('partial_image_b64');
      expect(received).not.toContain(IMAGE_RESULT);
      expect(received).not.toContain('response.completed');
      expect(harness.lifecycle.indexOf('scope.dispose'))
        .toBeLessThan(harness.lifecycle.indexOf('runtime.release'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps ordinary Responses on the byte-compatible path with zero runtime acquisition', async () => {
    const harness = runtimeHarness();
    const {
      proxyPort,
      suppressAuditBodies,
      token,
      upstreamBodies,
    } = await setup({ factory: harness.factory });
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'ordinary text only',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ORDINARY_RESPONSE_TEXT);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('openai-version')).toBe('2026-08-31');
    expect(response.headers.get('x-request-id')).toBe('req_ordinary_byte_path');
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]).toEqual({
      model: 'gpt-native',
      input: 'ordinary text only',
    });
    expect(harness.factory.acquire).not.toHaveBeenCalled();
    expect(suppressAuditBodies).not.toHaveBeenCalled();
    expect(harness.runtime.inspectRequest).not.toHaveBeenCalled();
    expect(harness.runtime.validateSelection).not.toHaveBeenCalled();
    expect(harness.openRequest).not.toHaveBeenCalled();
    expect(harness.executeSelectedCall).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
    expect(harness.waitForIdle).not.toHaveBeenCalled();
    expect(harness.disposeScope).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });

  it('fails closed before upstream when the production runtime is missing', async () => {
    const { proxyPort, token, upstreamBodies } = await setup();
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw without runtime',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('unsupported_capability');
    expect(upstreamBodies).toHaveLength(0);
  });

  it('rejects image work on a reduced profile before runtime or upstream execution', async () => {
    const harness = runtimeHarness();
    const { proxyPort, token, upstreamBodies } = await setup({
      factory: harness.factory,
      apiFormat: 'openai',
    });
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw on reduced profile',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('unsupported_capability');
    expect(upstreamBodies).toHaveLength(0);
    expect(harness.factory.acquire).not.toHaveBeenCalled();
    expect(harness.runtime.inspectRequest).not.toHaveBeenCalled();
    expect(harness.executeSelectedCall).not.toHaveBeenCalled();
  });

  it('enforces the projected Images permission before selector, runtime, or provider work', async () => {
    const harness = runtimeHarness();
    const { proxyPort, token, upstreamBodies } = await setup({
      factory: harness.factory,
      permission: false,
    });
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw without Images permission',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('insufficient_permissions');
    expect(upstreamBodies).toHaveLength(0);
    expect(harness.factory.acquire).not.toHaveBeenCalled();
    expect(harness.runtime.inspectRequest).not.toHaveBeenCalled();
    expect(harness.runtime.validateSelection).not.toHaveBeenCalled();
    expect(harness.openRequest).not.toHaveBeenCalled();
    expect(harness.executeSelectedCall).not.toHaveBeenCalled();
  });
});
