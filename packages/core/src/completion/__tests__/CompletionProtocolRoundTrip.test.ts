import type { LLMProvider } from '@omnicross/contracts/llm-config';
import type { MCPTool } from '@omnicross/contracts/mcp-types';
import type { SimpleChatMessage } from '@omnicross/contracts/completion-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import type { ProviderConfigSource } from '../../ports/provider-config-source';
import type { McpToolProvider } from '../../tool-types';
import { createSSEParser } from '../../sse-parser';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import type { UnifiedChatRequest } from '../../transformer/types';
import { callGeminiCompletion, callOpenAICompletion } from '../DirectApiHandler';
import { convertMessageToAnthropic, convertMessagesToGemini, convertMessagesToResponses } from '../message-converter';
import { streamOpenAICompletion } from '../StreamHandler';
import { streamWithTools, type StreamWithToolsOptions } from '../ToolHandler';
import { completeStreamWithTransformers, completeWithTransformers } from '../TransformerHandler';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const user: SimpleChatMessage = { id: 'u', role: 'user', content: 'lookup both', timestamp: 1 };
const tool = { type: 'function' as const, function: { name: 'lookup', description: '', parameters: { type: 'object', properties: { q: { type: 'string' } } } } };

function provider(apiFormat: LLMProvider['apiFormat']): LLMProvider {
  return { id: 'test', name: 'test', enabled: true, apiFormat, api_base_url: 'https://example.test/v1', api_key: 'test-key', models: ['test-model'] };
}

function response(events: unknown[], done = false): Response {
  const text = events.map(event => `data:${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data:[DONE]\r\n\r\n' : '');
  const encoded = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let index = 0; index < encoded.length; index += 11) controller.enqueue(encoded.slice(index, index + 11));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

function turn(apiFormat: string, tools: boolean): Response {
  if (apiFormat === 'anthropic') {
    const blocks = tools ? [
      { type: 'thinking', thinking: 'plan', signature: 'anthropic-signature' },
      { type: 'redacted_thinking', data: 'opaque-redaction' },
      { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'a' } },
      { type: 'tool_use', id: 'b', name: 'lookup', input: { q: 'b' } },
    ] : [{ type: 'text', text: 'finished' }];
    return response([
      { type: 'message_start', message: { id: 'msg', usage: { input_tokens: 10 } } },
      ...blocks.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
  }
  if (apiFormat === 'google') {
    return response([{
      candidates: [{ content: { role: 'model', parts: tools ? [
        { text: 'plan', thought: true, thoughtSignature: 'google-thought' },
        { functionCall: { id: 'a', name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'google-a' },
        { functionCall: { id: 'b', name: 'lookup', args: { q: 'b' } }, thoughtSignature: 'google-b' },
      ] : [{ text: 'finished' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    }]);
  }
  if (apiFormat === 'openai-response') {
    return response([
      tools ? { type: 'response.reasoning_summary_text.delta', delta: 'plan' } : { type: 'response.output_text.delta', delta: 'finished' },
      { type: 'response.completed', response: { status: 'completed', output: tools ? [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
        { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'lookup', arguments: '{"q":"a"}' },
        { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'lookup', arguments: '{"q":"b"}' },
      ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'finished' }] }], usage: { input_tokens: 10, output_tokens: 3 } } },
    ]);
  }
  return response([
    { choices: [{ delta: tools ? { reasoning_content: 'plan' } : { content: 'finished' } }] },
    ...(tools ? [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', function: { name: 'lookup', arguments: '{"q":' } },
        { index: 1, id: 'b', function: { name: 'lookup', arguments: '{"q":"b"}' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] } }] },
    ] : []),
    { choices: [{ delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ], true);
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('built-in completion protocol loops', () => {
  it.each((['openai', 'anthropic', 'google', 'openai-response'] as const).flatMap(apiFormat =>
    ['test-model', 'deepseek-chat', 'deepseek-reasoner'].map(model => ({ apiFormat, model })),
  ))('replays reasoning and both native tool results over $apiFormat with $model', async ({ apiFormat, model }) => {
    const upstream = provider(apiFormat);
    if (model !== 'test-model') {
      upstream.modelConfigs = [
        { id: model, name: 'Selected row', enabled: true, thinkingLevels: ['low'] },
        { id: 'deepseek-flash', name: 'Other row', enabled: true, thinkingLevels: ['high'] },
      ];
    }
    const callbacks = { onError: vi.fn(), onDone: vi.fn(), onToolCall: vi.fn() };
    const callTool = vi.fn(async (_server: string, _name: string, args: Record<string, unknown>) => ({ content: [{ type: 'text', text: `result-${args.q}` }] }));
    const mcp = { callTool } as unknown as McpToolProvider;
    const config = { resolveRoutedModel: async () => null, getGlobalModelParameters: async () => ({ toolMaxTurns: 3 }) } as unknown as ProviderConfigSource;
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const wireModel = model === 'test-model' ? model : 'deepseek-flash';
      if (apiFormat === 'google') {
        expect(url).toContain(`/models/${wireModel}:`);
        expect(body.generationConfig.maxOutputTokens).toBe(4321);
      } else {
        expect(body.model).toBe(wireModel);
        expect(body[apiFormat === 'openai-response' ? 'max_output_tokens' : 'max_tokens']).toBe(4321);
      }
      if (model !== 'test-model') {
        if (apiFormat === 'google') expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
        else if (apiFormat === 'openai-response') expect(body.reasoning.effort).toBe('low');
        else if (apiFormat === 'openai') expect(body.reasoning_effort).toBe('low');
      }
      requests++;
      if (requests === 2) {
        if (apiFormat === 'google') {
          const assistant = body.contents.find((message: { role: string }) => message.role === 'model');
          expect(assistant.parts).toEqual([
            { text: 'plan', thought: true, thoughtSignature: 'google-thought' },
            { functionCall: { id: 'a', name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'google-a' },
            { functionCall: { id: 'b', name: 'lookup', args: { q: 'b' } }, thoughtSignature: 'google-b' },
          ]);
          expect(body.contents.at(-1).parts.map((part: { functionResponse: { id: string } }) => part.functionResponse.id)).toEqual(['a', 'b']);
        } else if (apiFormat === 'anthropic') {
          const assistant = body.messages.find((message: { role: string }) => message.role === 'assistant');
          expect(assistant.content.slice(0, 2)).toEqual([
            { type: 'thinking', thinking: 'plan', signature: 'anthropic-signature' }, { type: 'redacted_thinking', data: 'opaque-redaction' },
          ]);
          expect(body.messages.slice(-2).map((message: { content: Array<{ tool_use_id: string }> }) => message.content[0].tool_use_id)).toEqual(['a', 'b']);
        } else if (apiFormat === 'openai-response') {
          expect(body.input.find((item: { type: string }) => item.type === 'reasoning').encrypted_content).toBe('encrypted-reasoning');
          expect(body.input.filter((item: { type: string }) => item.type === 'function_call_output').map((item: { call_id: string }) => item.call_id)).toEqual(['a', 'b']);
        } else {
          const assistant = body.messages.find((message: { role: string }) => message.role === 'assistant');
          expect(assistant.reasoning_content).toBe('plan');
          expect(assistant.tool_calls.map((call: { id: string }) => call.id)).toEqual(['a', 'b']);
          expect(body.messages.slice(-2).map((message: { role: string; tool_call_id: string }) => [message.role, message.tool_call_id])).toEqual([['tool', 'a'], ['tool', 'b']]);
        }
      }
      return turn(apiFormat, requests === 1);
    }));
    const options: StreamWithToolsOptions = {
      providerId: upstream.id, model, messages: [user], maxTokens: 4321, temperature: 0.4,
      ...(model !== 'test-model' ? { thinkLevel: 'high' as const } : {}),
      tools: apiFormat === 'anthropic' ? [{ name: 'lookup', description: '', input_schema: tool.function.parameters }]
        : apiFormat === 'google' ? [{ functionDeclarations: [{ name: 'lookup', description: '', parameters: tool.function.parameters }] }] : [tool],
      mcpTools: [{ id: 'lookup', name: 'lookup', serverId: 'mcp', inputSchema: tool.function.parameters } as MCPTool],
    };
    await streamWithTools(options, callbacks, mcp, config, async () => upstream, key => key, logger);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(requests).toBe(2);
    expect(callTool.mock.calls.map(call => call[2])).toEqual([{ q: 'a' }, { q: 'b' }]);
    expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: 'finished' }), { promptTokens: 20, completionTokens: 6, totalTokens: 26 });
  });

  it('retains JSON Chat reasoning and distinguishes Gemini thoughts from visible text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: 'answer', reasoning_content: 'plan' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })));
    const chat = await callOpenAICompletion(provider('openai'), 'key', { providerId: 'test', model: 'test', messages: [user] }, logger);
    expect(chat.message).toMatchObject({ content: 'answer', thinking: { content: 'plan' } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: 'plan', thought: true, thoughtSignature: 'sig' }, { text: 'answer' }] } }], usageMetadata: {} })));
    const google = await callGeminiCompletion(provider('google'), 'key', { providerId: 'test', model: 'test', messages: [user] }, logger);
    expect(google.message).toMatchObject({ content: 'answer', thinking: { content: 'plan' } });
    const replay = convertMessagesToGemini([google.message!]);
    expect(replay.contents[0].parts[0]).toEqual({ text: 'plan', thought: true, thoughtSignature: 'sig' });
  });

  it('does not report done after an SSE error or truncated stream', async () => {
    const callbacks = { onError: vi.fn(), onDone: vi.fn() };
    vi.stubGlobal('fetch', vi.fn(async () => response([{ error: { message: 'upstream overloaded' } }])));
    await streamOpenAICompletion(provider('openai'), 'key', { providerId: 'test', model: 'test', messages: [user] }, 'id', callbacks, logger);
    expect(callbacks.onError).toHaveBeenCalledWith('upstream overloaded');
    expect(callbacks.onDone).not.toHaveBeenCalled();
    const parser = createSSEParser('openai', {});
    parser.push('data:{"choices":[{"delta":{"content":"partial"}}]}\n\n'); parser.flush();
    expect(parser.getResult().error).toMatch(/before completion/);
  });

  it('keeps distinct signed thinking blocks through a transformed Chat stream', () => {
    const parser = createSSEParser('openai', {});
    for (const thinking of [{ index: 0, content: 'one', signature: 'sig-1' }, { index: 1, type: 'redacted_thinking', data: 'opaque' }, { index: 2, content: 'two', signature: 'sig-2' }]) {
      parser.push(`data:${JSON.stringify({ choices: [{ delta: { thinking } }] })}\n\n`);
    }
    parser.push('data:{"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata:[DONE]\n\n');
    parser.flush();
    const result = parser.getResult();
    const replay = convertMessageToAnthropic({ id: 'a', role: 'assistant', content: '', timestamp: 1, thinking: { content: result.reasoning, blocks: result.thinkingBlocks } });
    expect(replay.content).toEqual([{ type: 'thinking', thinking: 'one', signature: 'sig-1' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'thinking', thinking: 'two', signature: 'sig-2' }]);
    expect(parser.getResult().blocks).toHaveLength(1);
  });

  it('encodes Responses images and tool outputs without dropping native reasoning history', () => {
    const output = convertMessagesToResponses([
      { ...user, images: [{ url: 'https://example.test/image.png' }] },
      { id: 'a', role: 'assistant', content: '', timestamp: 1, providerMetadata: { apiFormat: 'openai-response', content: [{ type: 'reasoning', id: 'rs', encrypted_content: 'opaque', summary: [] }] } },
      { id: 't', role: 'tool', content: 'result', toolCallId: 'call', timestamp: 1 },
    ]);
    expect(output[0].content).toEqual([{ type: 'input_text', text: 'lookup both' }, { type: 'input_image', image_url: 'https://example.test/image.png' }]);
    expect(output.slice(1)).toEqual([{ type: 'reasoning', id: 'rs', encrypted_content: 'opaque', summary: [] }, { type: 'function_call_output', call_id: 'call', output: 'result' }]);
  });
  it('finishes the real transformer completion path only after fragmented content and final usage', async () => {
    const callbacks = { onError: vi.fn(), onDone: vi.fn(), onDelta: vi.fn() };
    const upstream = provider('openai');
    const config = {
      resolveRoutedModel: async () => null,
      resolveTransformerChain: async () => ({ providerTransformers: [], modelTransformers: [] }),
      getMainTransformer: async () => new OpenAITransformer(),
    } as unknown as ProviderConfigSource;
    vi.stubGlobal('fetch', vi.fn(async () => response([
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } },
      { choices: [{ delta: { content: 'complete answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ], true)));
    await completeStreamWithTransformers(
      { providerId: 'test', model: 'test-model', messages: [user] }, callbacks, config,
      async () => upstream, key => key, async () => { throw new Error('Unexpected fallback'); }, logger,
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onDelta).toHaveBeenCalledWith('complete answer');
    expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: 'complete answer' }),
      { promptTokens: 10, completionTokens: 3, totalTokens: 13 }, expect.anything(),
    );
  });

  it.each(['deepseek-chat', 'deepseek-reasoner'].flatMap(model =>
    [true, false].map(legacyConfigured => ({ model, legacyConfigured })),
  ))('uses the selected $model configuration (legacy row: $legacyConfigured) while sending flash', async ({ model, legacyConfigured }) => {
    const upstream = provider('openai');
    upstream.name = 'DeepSeek';
    upstream.modelConfigs = [
      ...(legacyConfigured ? [{ id: model, name: 'Selected row', enabled: true, thinkingLevels: ['low'] }] : []),
      { id: 'deepseek-flash', name: 'Different row', enabled: true, thinkingLevels: ['high'] },
    ];
    const resolveTransformerChain = async (_providerId: string, selectedModel: string) => ({
      providerTransformers: [],
      modelTransformers: [
        new OpenAITransformer(),
        {
          name: 'configured-temperature',
          transformRequestIn: async (request: UnifiedChatRequest) => ({
            ...request, temperature: selectedModel === model ? 0.2 : 0.8,
          }),
        },
      ],
    });
    const config = {
      getProvider: async () => upstream,
      resolveRoutedModel: async () => ({ actualProviderId: upstream.id, actualModelId: model }),
      resolveTransformerChain,
      getMainTransformer: async () => undefined,
    } as unknown as ProviderConfigSource;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.stream ? turn('openai', false) : Response.json({
        model: 'deepseek-flash', choices: [{ message: { content: 'finished', reasoning_content: 'plan' }, finish_reason: 'stop' }],
      });
    }));
    const options = { providerId: 'router', model: 'routed-model', messages: [user], thinkLevel: 'high' as const, maxTokens: 4321, temperature: 0.4 };
    const direct = await completeWithTransformers(options, config, async () => upstream, key => key,
      async () => { throw new Error('Unexpected fallback'); }, logger);
    const callbacks = { onDone: vi.fn(), onError: vi.fn() };
    await completeStreamWithTransformers(options, callbacks, config, async () => upstream, key => key,
      async () => { throw new Error('Unexpected fallback'); }, logger);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({
        model: 'deepseek-flash', reasoning_effort: legacyConfigured ? 'low' : 'high',
        max_tokens: 4321, temperature: legacyConfigured ? 0.2 : 0.8,
      });
    }
    expect(direct.message).toMatchObject({ content: 'finished', thinking: { content: 'plan' } });
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.objectContaining({ content: 'finished' }), expect.anything(), expect.anything());
    expect(upstream.modelConfigs.map(row => row.id)).toEqual(legacyConfigured ? [model, 'deepseek-flash'] : ['deepseek-flash']);
    expect(options.model).toBe('routed-model');
  });

  it('keeps interleaved Anthropic tool JSON buffers separate', async () => {
    const input = await response([
      { type: 'message_start', message: { usage: { input_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'lookup', input: {} } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"b"}' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
      { type: 'content_block_stop', index: 0 }, { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ]).text();
    const parser = createSSEParser('anthropic', {});
    parser.push(input); parser.flush();
    expect(parser.getResult().toolCalls).toEqual([
      { id: 'a', name: 'lookup', args: { q: 'a' } }, { id: 'b', name: 'lookup', args: { q: 'b' } },
    ]);
  });

  it('surfaces generated Gemini image bytes and counts thought tokens', async () => {
    const input = await response([{
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQID' } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 },
    }]).text();
    const parser = createSSEParser('gemini', {});
    parser.push(input); parser.flush();
    expect(parser.getResult()).toMatchObject({
      images: [{ mimeType: 'image/png', url: 'data:image/png;base64,AQID' }],
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
    });
  });
});
