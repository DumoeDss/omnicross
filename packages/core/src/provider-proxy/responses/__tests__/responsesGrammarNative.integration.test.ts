import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../../ports';
import { OpenAITransformer } from '../../../transformer/transformers/OpenAITransformer';
import { ProviderProxy } from '../../ProviderProxy';
import type { RouteContext } from '../../types';

function listen(server: Server): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  return promise;
}

function close(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  return promise;
}

const regexTool = {
  type: 'custom', name: 'move', description: 'Native regex tool',
  format: { type: 'grammar', syntax: 'regex', definition: String.raw`MOVE [A-Z]+\r?\n` },
};
const larkTool = {
  type: 'custom', name: 'tree', description: 'Native recursive grammar tool',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: node\r\nnode: "leaf" | "(" node node ")"\r\n' },
};
const additionalTools = {
  type: 'additional_tools', role: 'developer',
  tools: [{ type: 'namespace', name: 'native', tools: [larkTool] }],
};

// Native routes must neither wrap custom tools as functions nor reconstruct their formats.
describe('Responses grammar HTTP fidelity and strict output admission', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  it.each([false, true])('stream=%s preserves top-level and additional_tools grammar formats and native output', async (stream) => {
    const requests: Array<Record<string, unknown>> = [];
    const output = [
      { type: 'custom_tool_call', id: 'ctc_move', call_id: 'call_move', name: 'move', input: 'MOVE NORTH\r\n', status: 'completed' },
      { type: 'custom_tool_call', id: 'ctc_tree', call_id: 'call_tree', namespace: 'native', name: 'tree', input: '(leaf(leafleaf))', status: 'completed' },
    ];
    const responseBody = { id: 'resp_native_grammar', object: 'response', model: 'native-model', status: 'completed', output };
    const responseText = stream
      ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responseBody })}\n\n`
      : JSON.stringify(responseBody);
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
        // Split the native JSON and grammar-bearing SSE independently of event boundaries.
        for (let index = 0; index < responseText.length; index += 11) response.write(responseText.slice(index, index + 11));
        response.end();
      });
    });
    upstream = server;
    const port = await listen(server);
    const authStrategy = {
      providerId: 'codex', kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>) { headers.Authorization = 'Bearer loopback-only'; },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'native-grammar', targetProviderFormat: 'openai-responses', model: 'native-model',
      ingressFormat: 'openai-responses', authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/backend-api/codex/responses`,
      },
    };
    proxy = new ProviderProxy({
      llmConfig: {
        getProvider: vi.fn(),
        resolveTransformerChain: vi.fn(),
        getMainTransformer: vi.fn(),
        getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
      } as unknown as ProviderConfigSource,
    });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const input = [additionalTools, { type: 'message', role: 'user', content: 'Use both native tools' }];
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', stream, tools: [regexTool], input }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(responseText);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([regexTool]);
    expect(requests[0].input).toEqual(input);
  });

  it.each([false, true])('reduced stream=%s exposes grammar mismatch as a typed HTTP/stream failure without leaking input', async (stream) => {
    let hits = 0;
    const invalidInput = 'MOVE NORTH\nPRIVATE_INVALID_SUFFIX';
    const argumentsJson = JSON.stringify({ input: invalidInput });
    const completion = {
      id: 'chatcmpl-invalid-grammar', object: 'chat.completion', model: 'mapped-model',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
        id: 'call_invalid', type: 'function', function: { name: 'move', arguments: argumentsJson },
      }] }, finish_reason: 'tool_calls' }],
    };
    const split = Math.floor(argumentsJson.length / 2);
    const chunks = [
      { tool_calls: [{ index: 0, id: 'call_invalid', type: 'function', function: { name: 'move', arguments: argumentsJson.slice(0, split) } }] },
      { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(split) } }] },
      {},
    ];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        hits += 1;
        const body = JSON.parse(raw) as { stream?: boolean };
        response.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
        if (!body.stream) {
          response.end(JSON.stringify(completion));
          return;
        }
        for (const [index, delta] of chunks.entries()) response.write(`data: ${JSON.stringify({
          id: 'chatcmpl-invalid-grammar', object: 'chat.completion.chunk', model: 'mapped-model',
          choices: [{ index: 0, delta, finish_reason: index === chunks.length - 1 ? 'tool_calls' : null }],
        })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    upstream = server;
    const port = await listen(server);
    const transformer = new OpenAITransformer();
    proxy = new ProviderProxy({
      llmConfig: {
        getProvider: vi.fn(async () => null),
        resolveTransformerChain: vi.fn(),
        getMainTransformer: vi.fn(),
        getTransformerService: vi.fn(() => ({
          getTransformer: (name: string) => name === transformer.name ? transformer : undefined,
        })),
      } as unknown as ProviderConfigSource,
    });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute({
      sessionId: 'reduced-grammar-failure', targetProviderFormat: 'openai-responses',
      model: 'mapped-model', ingressFormat: 'openai-responses', authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: {
          providerId: 'grammar-loopback', kind: 'oauth-bearer',
          async applyHeaders(headers: Record<string, string>) { headers.Authorization = 'Bearer loopback-only'; },
          async onUnauthorized() { return false; },
          async describeStatus() { return { providerId: 'grammar-loopback', configured: true }; },
        } as never,
        providerTransformerNames: [transformer.name],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/v1/chat/completions`,
      },
    });
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', stream, tools: [regexTool], input: 'Use the tool' }),
    });
    const text = await response.text();
    expect(hits).toBe(1);
    expect(text).not.toContain('PRIVATE_INVALID_SUFFIX');
    expect(text).not.toContain(JSON.stringify(regexTool.format.definition).slice(1, -1));
    if (!stream) {
      expect(response.status).toBe(502);
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'invalid_upstream_tool_input' } });
      return;
    }
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const events = text.split('\n').filter((line) => line.startsWith('data:')).flatMap((line) => {
      const data = line.slice(5).trim();
      return data && data !== '[DONE]' ? [JSON.parse(data) as {
        type: string; response?: { error?: { code: string } }; item?: { status?: string }; delta?: string;
      }] : [];
    });
    expect(events.find((event) => event.type === 'response.failed')?.response?.error).toMatchObject({
      code: 'invalid_upstream_tool_input',
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
    expect(events.some((event) => event.type === 'response.custom_tool_call_input.delta' && event.delta)).toBe(false);
    expect(events.some((event) => event.type === 'response.custom_tool_call_input.done')).toBe(false);
    expect(events.some((event) => event.item?.status === 'completed')).toBe(false);
  });
});
