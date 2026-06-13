/**
 * Focused unit tests for `executeProviderCall` (Phase 1, task 3.5).
 *
 * Asserts the shared exchange core:
 *  (a) with an endpointTransformer it runs request-out / response-in;
 *  (b) without one it passes the unified request straight through;
 *  (c) `prepareBody` is applied to the FETCHED body, but the response chain
 *      receives the PRE-prepare request body (`responseChainRequest`);
 *  (d) `resolveUrl` / `buildHeaders` / `fetchFn` are invoked with the
 *      expected arguments (config-derived).
 */

import { describe, expect, it, vi } from 'vitest';

import { TransformerChainExecutor } from '../../transformer/TransformerChainExecutor';
import type {
  LLMProvider as TransformerLLMProvider,
  ResolvedTransformerChain,
  Transformer,
  UnifiedChatRequest,
} from '../../transformer/types';
import { executeProviderCall } from '../executeProviderCall';

// Silence the executor's debug logger in tests.
const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const provider: TransformerLLMProvider = {
  name: 'test-provider',
  baseUrl: 'https://api.test.com',
  apiKey: 'test-key',
  models: ['model-a'],
};

const emptyChain: ResolvedTransformerChain = {
  providerTransformers: [],
  modelTransformers: [],
};

const unifiedRequest: UnifiedChatRequest = {
  model: 'model-a',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 100,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('executeProviderCall', () => {
  it('(b) without endpointTransformer passes unified request straight through (no transform)', async () => {
    const executor = new TransformerChainExecutor(silentLogger);
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));

    const result = await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider,
      chain: emptyChain,
      endpointTransformer: undefined,
      resolveUrl: () => 'https://api.test.com/v1/chat',
      buildHeaders: () => ({ authorization: 'Bearer test-key' }),
      fetchFn,
      // raw-response mode (caller would run the response chain itself)
    });

    // Empty chain + no endpoint → request body is the unified request verbatim.
    expect(result.requestBody).toEqual(unifiedRequest);
    expect(result.finalBody).toEqual(unifiedRequest);
    // No prepareBody / no response chain → fetched body sent verbatim.
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat',
      { authorization: 'Bearer test-key' },
      unifiedRequest,
    );
    // runResponseChain defaults to false → raw fetched response returned.
    const parsed = (await result.response.json()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('(a) with an endpointTransformer runs transformRequestOut and transformResponseIn', async () => {
    const executor = new TransformerChainExecutor(silentLogger);

    const decoded: UnifiedChatRequest = {
      model: 'model-a',
      messages: [{ role: 'user', content: 'decoded' }],
    };
    const responseInMarker = jsonResponse({ encoded: true });

    const endpointTransformer: Transformer = {
      name: 'endpoint',
      // wire → unified
      transformRequestOut: vi.fn(async () => decoded),
      // provider/unified response → client wire format
      transformResponseIn: vi.fn(async () => responseInMarker),
    };

    const fetchFn = vi.fn(async () => jsonResponse({ provider: 'raw' }));

    const result = await executeProviderCall({
      executor,
      request: { wire: 'anthropic-shaped' },
      provider,
      chain: emptyChain,
      endpointTransformer,
      resolveUrl: () => 'https://api.test.com/v1/messages',
      buildHeaders: () => ({}),
      fetchFn,
      runResponseChain: true,
      responseChainRequest: decoded,
    });

    // request-out ran: the decoded unified body is what we fetched.
    expect(endpointTransformer.transformRequestOut).toHaveBeenCalledTimes(1);
    expect(result.requestBody).toEqual(decoded);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test.com/v1/messages',
      {},
      decoded,
    );
    // response-in ran: the returned response is the endpoint-encoded one.
    expect(endpointTransformer.transformResponseIn).toHaveBeenCalledTimes(1);
    expect(result.response).toBe(responseInMarker);
  });

  it('(c) prepareBody is applied to the fetched body but the response chain receives the pre-prepare request body', async () => {
    // Spy on executeResponseChain to capture its first arg.
    const executor = new TransformerChainExecutor(silentLogger);
    const responseChainSpy = vi
      .spyOn(executor, 'executeResponseChain')
      .mockResolvedValue(jsonResponse({ transformed: true }));

    const prepareBody = vi.fn((requestBody: unknown) => ({
      ...(requestBody as Record<string, unknown>),
      mutated: true,
    }));

    const fetchFn = vi.fn(async () => jsonResponse({ provider: 'raw' }));

    const result = await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider,
      chain: emptyChain,
      endpointTransformer: undefined,
      resolveUrl: () => 'https://api.test.com/v1/chat',
      buildHeaders: () => ({}),
      prepareBody,
      fetchFn,
      runResponseChain: true,
      responseChainRequest: unifiedRequest,
    });

    // prepareBody received the request-chain output (the unified request here).
    expect(prepareBody).toHaveBeenCalledTimes(1);
    expect(prepareBody.mock.calls[0][0]).toEqual(unifiedRequest);

    // The MUTATED body is what got fetched.
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat',
      {},
      { ...unifiedRequest, mutated: true },
    );
    expect(result.finalBody).toEqual({ ...unifiedRequest, mutated: true });
    // ...but requestBody (returned) is the PRE-prepare body.
    expect(result.requestBody).toEqual(unifiedRequest);

    // The response chain's FIRST arg is the pre-prepare request (responseChainRequest),
    // NOT the mutated finalBody.
    expect(responseChainSpy).toHaveBeenCalledTimes(1);
    const firstArg = responseChainSpy.mock.calls[0][0];
    expect(firstArg).toEqual(unifiedRequest);
    expect(firstArg).not.toMatchObject({ mutated: true });
  });

  it('(d) resolveUrl / buildHeaders / fetchFn are invoked with the expected (config-derived) args', async () => {
    const executor = new TransformerChainExecutor(silentLogger);

    // A provider transformer that sets a config (headers + url) so we can
    // assert resolveUrl/buildHeaders see the post-request-chain config.
    const cfgTransformer: Transformer = {
      name: 'cfg',
      transformRequestIn: vi.fn(async (req) => ({
        body: req,
        config: { headers: { 'x-from-chain': 'yes' }, url: 'https://chain.example/api' },
      })),
    };
    const chain: ResolvedTransformerChain = {
      providerTransformers: [cfgTransformer],
      modelTransformers: [],
    };

    const resolveUrl = vi.fn(
      (config: { url?: URL | string }) => String(config.url ?? 'fallback'),
    );
    const buildHeaders = vi.fn(
      (config: { headers?: Record<string, string> }) => ({ ...(config.headers ?? {}) }),
    );
    const fetchFn = vi.fn(async () => jsonResponse({ ok: true }));

    await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider,
      chain,
      endpointTransformer: undefined,
      resolveUrl,
      buildHeaders,
      fetchFn,
    });

    // resolveUrl + buildHeaders received the post-request-chain config.
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    expect(resolveUrl.mock.calls[0][0]).toMatchObject({
      headers: { 'x-from-chain': 'yes' },
      url: 'https://chain.example/api',
    });
    expect(buildHeaders).toHaveBeenCalledTimes(1);
    expect(buildHeaders.mock.calls[0][0]).toMatchObject({
      headers: { 'x-from-chain': 'yes' },
    });

    // fetchFn received the resolved url + assembled headers + the request body.
    expect(fetchFn).toHaveBeenCalledWith(
      'https://chain.example/api',
      { 'x-from-chain': 'yes' },
      unifiedRequest,
    );
  });

  it('falls back to requestBody when runResponseChain is true and responseChainRequest is omitted (proxy shape)', async () => {
    const executor = new TransformerChainExecutor(silentLogger);
    const responseChainSpy = vi
      .spyOn(executor, 'executeResponseChain')
      .mockResolvedValue(jsonResponse({ transformed: true }));
    const fetchFn = vi.fn(async () => jsonResponse({ provider: 'raw' }));

    await executeProviderCall({
      executor,
      request: unifiedRequest,
      provider,
      chain: emptyChain,
      endpointTransformer: undefined,
      resolveUrl: () => 'https://api.test.com/v1/chat',
      buildHeaders: () => ({}),
      fetchFn,
      runResponseChain: true,
      // responseChainRequest intentionally omitted → defaults to requestBody.
    });

    expect(responseChainSpy.mock.calls[0][0]).toEqual(unifiedRequest);
  });
});
