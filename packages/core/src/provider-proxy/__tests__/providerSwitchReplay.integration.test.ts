import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperationRegistry } from '../../openai-operation';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthApplyHints } from '../../pipeline/AuthSource';
import type { ProviderConfigSource } from '../../ports';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import { ProviderProxy } from '../ProviderProxy';
import { registerResponsesCompactOperation } from '../responses/responsesCompact';
import type { RouteContext } from '../types';

type Item = Record<string, any>;
const nativeThinking = { type: 'thinking', thinking: '', signature: 'native-claude-signature' };
const encrypted = { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'native-encrypted-reasoning' };
const tool = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } };

const cases = [
  { target: 'claude', client: 'anthropic', subscription: false, model: 'claude-sonnet-4-6' },
  { target: 'claude', client: 'anthropic', subscription: true, model: 'official-claude-alias' },
  { target: 'claude', client: 'responses', subscription: false, model: 'claude-sonnet-4-6' },
  { target: 'claude-manual', client: 'anthropic', subscription: false, model: 'claude-sonnet-4-5' },
  { target: 'gemini', client: 'anthropic', subscription: false, model: 'gemini-3-pro-preview' },
  { target: 'gemini', client: 'responses', subscription: false, model: 'gemini-3-pro-preview' },
  { target: 'deepseek', client: 'anthropic', subscription: false, model: 'deepseek-flash' },
  { target: 'deepseek', client: 'responses', subscription: false, model: 'deepseek-flash' },
  { target: 'deepseek-legacy', client: 'anthropic', subscription: false, model: 'deepseek-r1' },
  { target: 'kimi', client: 'anthropic', subscription: false, model: 'kimi-k2.6' },
  { target: 'responses', client: 'responses', subscription: false, model: 'gpt-native' },
  { target: 'responses-compact', client: 'responses', subscription: false, model: 'gpt-native' },
] as const;

describe('provider switches with retained client tool history', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await new Promise<void>((resolve, reject) => upstream!.close((error) => error ? reject(error) : resolve()));
    proxy = undefined;
    upstream = undefined;
    setSubscriptionRegistryForOutbound(null);
  });

  it.each(cases)('$client -> $target (subscription=$subscription) keeps the tool loop replayable', async (testCase) => {
    setSubscriptionRegistryForOutbound(null);
    const { target, client, model, subscription } = testCase;
    const format = target.startsWith('claude') ? 'anthropic'
      : target === 'gemini' ? 'gemini' : target.startsWith('responses') ? 'openai-response' : 'openai';
    // Produce the same history the real client retains after a Chat turn.
    const encoder = client === 'anthropic' ? new AnthropicTransformer() : new OpenAIResponseTransformer();
    const converted = await (await encoder.transformResponseIn(new Response(JSON.stringify({
      id: 'chatcmpl-foreign', object: 'chat.completion', model: 'glm-5.3',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: 'Inspecting the file', reasoning_content: 'Read the file first',
        tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { 'Content-Type': 'application/json' } }), {})).json() as Item;
    const body: Item = client === 'anthropic' ? {
      model: 'client-model', max_tokens: 8192, stream: false,
      thinking: { type: target === 'claude-manual' ? 'enabled' : 'adaptive', budget_tokens: 2048 },
      tools: [{ name: 'read_file', input_schema: tool.function.parameters }],
      messages: [
        { role: 'user', content: 'Earlier task' },
        { role: 'assistant', content: [nativeThinking, { type: 'text', text: 'Earlier answer' }] },
        { role: 'user', content: 'Read a file' },
        { role: 'assistant', content: converted.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'file contents' }] },
      ],
    } : {
      model: 'client-model', stream: false, store: false,
      tools: [{ type: 'function', name: 'read_file', parameters: tool.function.parameters }],
      input: [
        { type: 'message', role: 'user', content: 'Read a file' },
        ...converted.output,
        { type: 'function_call_output', call_id: 'call_read', output: 'file contents' },
        ...(format === 'openai-response' ? [encrypted] : []),
      ],
    };
    const original = structuredClone(body);
    const requests: Item[] = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const wire = JSON.parse(raw) as Item;
        requests.push(wire);
        let error = '';
        let reply: Item;
        if (format === 'anthropic') {
          const blocks = wire.messages.flatMap((message: Item) => Array.isArray(message.content) ? message.content : []);
          if (blocks.some((block: Item) => block.type === 'thinking' && !block.signature)) error = 'Invalid signature in thinking block';
          if (target === 'claude-manual' && wire.thinking?.type === 'enabled') error = 'Expected signed thinking before foreign tool_use';
          reply = { id: 'msg_ok', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
        } else if (format === 'gemini') {
          const step = wire.contents.find((content: Item) => content.parts.some((part: Item) => part.functionCall));
          const call = step?.parts.find((part: Item) => part.functionCall);
          if (!call?.thoughtSignature) error = 'Function call is missing a thought_signature';
          reply = { candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
        } else if (format === 'openai-response') {
          if (wire.input.some((item: Item) => item.type === 'reasoning' && !item.encrypted_content)) error = 'Item with id not found. Items are not persisted when store is set to false';
          reply = target === 'responses-compact' ? { object: 'response.compaction', output: [encrypted] }
            : { id: 'resp_ok', object: 'response', status: 'completed', model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
        } else {
          if (target === 'deepseek-legacy') {
            if (wire.messages.some((message: Item) => message.reasoning_content !== undefined)) error = 'reasoning_content is not allowed in input';
          } else if (wire.messages.some((message: Item) => message.role === 'assistant' && message.reasoning_content === undefined)) error = 'reasoning_content must be passed back';
          reply = { id: 'chat_ok', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };
        }
        res.writeHead(error ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(error ? { error: { message: error } } : reply));
      });
    });
    const port = await new Promise<number>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve((upstream!.address() as AddressInfo).port)));
    const baseUrl = `http://127.0.0.1:${port}`;
    const transformers = { openai: new OpenAITransformer(), anthropic: new AnthropicTransformer(), gemini: new GeminiTransformer(), 'openai-response': new OpenAIResponseTransformer() };
    const provider = { id: 'switched', name: target, apiFormat: format, api_base_url: baseUrl, api_key: 'test-only', models: [model], enabled: true };
    const registry = new OpenAIOperationRegistry();
    registerResponsesCompactOperation(registry);
    proxy = new ProviderProxy({
      llmConfig: {
        getProvider: vi.fn(async () => provider),
        resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
        getMainTransformer: vi.fn(async () => transformers[format as keyof typeof transformers] ?? null),
        getTransformerService: () => ({ getTransformer: (name: string) => transformers[name as keyof typeof transformers] }),
      } as unknown as ProviderConfigSource,
      openAIOperationRegistry: registry,
    });
    const route: RouteContext = {
      sessionId: 'retained-client-session', providerId: 'switched', model,
      targetProviderFormat: format === 'openai-response' ? 'openai-responses' : 'transform',
      ingressFormat: client === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
      authMode: subscription ? 'subscription' : 'byo',
      ...(subscription ? { subscriptionProfile: {
        mode: 'pass-through', providerTransformerNames: ['anthropic'],
        resolveUpstreamUrl: () => `${baseUrl}/v1/messages`,
        authStrategy: {
          providerId: 'claude', kind: 'oauth-bearer',
          async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints) { headers.Authorization = 'Bearer test-only'; hints?.reportSelection?.('account-a', true); },
          async onUnauthorized() { return false; },
          async describeStatus() { return { providerId: 'claude', configured: true }; },
        } as never,
      } } : {}),
    };
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);
    const path = client === 'anthropic' ? '/v1/messages' : target === 'responses-compact' ? '/v1/responses/compact' : '/v1/responses';
    const response = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'session-id': 'same-client' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(requests).toHaveLength(1);
    const wire = requests[0];
    if (format === 'anthropic') {
      const blocks = wire.messages.flatMap((message: Item) => Array.isArray(message.content) ? message.content : []);
      if (client === 'anthropic') expect(blocks).toContainEqual(nativeThinking);
      expect(blocks).toContainEqual({ type: 'tool_use', id: 'call_read', name: 'read_file', input: {} });
      expect(blocks).toContainEqual({ type: 'tool_result', tool_use_id: 'call_read', content: 'file contents' });
      if (target !== 'claude-manual' && client === 'anthropic') expect(wire.thinking.type).toBe('adaptive');
    } else if (format === 'gemini') {
      const parts = wire.contents.flatMap((content: Item) => content.parts);
      expect(parts.find((part: Item) => part.functionCall).thoughtSignature).toBe('skip_thought_signature_validator');
      expect(parts.find((part: Item) => part.functionResponse).functionResponse).toMatchObject({ id: 'call_read', name: 'read_file' });
    } else if (format === 'openai-response') {
      expect(wire.input).toContainEqual(encrypted);
      expect(wire.input.find((item: Item) => item.type === 'function_call_output').call_id).toBe('call_read');
    } else {
      const assistant = wire.messages.filter((message: Item) => message.role === 'assistant');
      if (target === 'deepseek-legacy') expect(assistant.every((message: Item) => message.reasoning_content === undefined)).toBe(true);
      else {
        expect(assistant.at(-1).reasoning_content).toBe('Read the file first');
        if (client === 'anthropic') expect(assistant[0].reasoning_content).toBe('');
      }
    }
    expect(body).toEqual(original);
  });
});
