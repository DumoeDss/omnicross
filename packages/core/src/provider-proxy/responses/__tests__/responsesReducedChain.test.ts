import { describe, expect, it } from 'vitest';

import { executeProviderCall } from '../../../pipeline/executeProviderCall';
import type { LLMProvider, Transformer } from '../../../transformer';
import { TransformerChainExecutor } from '../../../transformer/TransformerChainExecutor';
import { AnthropicTransformer } from '../../../transformer/transformers/AnthropicTransformer';
import { GeminiTransformer } from '../../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../../transformer/transformers/OpenAITransformer';
import {
  resolveReducedResponsesCapabilities,
  validateReducedResponsesRequest,
} from '../responsesProfile';

interface ReducedTargetCase {
  readonly name: string;
  readonly transformer: Transformer;
  readonly responseBody: Record<string, unknown>;
  readonly findToolName: (body: Record<string, unknown>) => unknown;
}

const provider: LLMProvider = {
  name: 'reduced-target',
  baseUrl: 'https://example.test/v1/',
  apiKey: 'test-key',
  models: ['mapped-model'],
};

const request = {
  model: 'mapped-model',
  input: [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{
        type: 'namespace',
        name: 'collaboration',
        tools: [{
          type: 'function',
          name: 'spawn_agent',
          description: 'Spawn an agent',
          parameters: { type: 'object', properties: { task: { type: 'string' } } },
        }],
      }],
    },
    { type: 'message', role: 'user', content: 'delegate' },
  ],
};

const targets: ReducedTargetCase[] = [
  {
    name: 'OpenAI Chat',
    transformer: new OpenAITransformer(),
    responseBody: {
      id: 'chatcmpl-openai',
      object: 'chat.completion',
      created: 1,
      model: 'mapped-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_openai',
            type: 'function',
            function: { name: 'spawn_agent', arguments: '{"task":"x"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    findToolName: (body) => (
      (body.tools as Array<{ function: { name: string } }>)[0]?.function.name
    ),
  },
  {
    name: 'Anthropic',
    transformer: new AnthropicTransformer(),
    responseBody: {
      id: 'msg_anthropic',
      type: 'message',
      role: 'assistant',
      model: 'mapped-model',
      content: [{
        type: 'tool_use',
        id: 'call_anthropic',
        name: 'spawn_agent',
        input: { task: 'x' },
      }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    findToolName: (body) => (
      (body.tools as Array<{ name: string }>)[0]?.name
    ),
  },
  {
    name: 'Gemini',
    transformer: new GeminiTransformer(),
    responseBody: {
      responseId: 'resp_gemini',
      modelVersion: 'mapped-model',
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: { id: 'call_gemini', name: 'spawn_agent', args: { task: 'x' } },
          }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    },
    findToolName: (body) => (
      (body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>)[0]
        ?.functionDeclarations[0]?.name
    ),
  },
];

/** Gate a request exactly as the ingress would for this target's chain. */
function validateReducedRequestsForTarget(
  body: Record<string, unknown>,
  transformer: Transformer,
): string[] {
  return validateReducedResponsesRequest(body, resolveReducedResponsesCapabilities({
    authMode: 'subscription',
    subscriptionTransformerNames: [transformer.name],
  }));
}

describe('reduced Responses target chains', () => {
  it.each(targets)('$name receives bare namespace tools and restores the namespace on output', async ({
    transformer,
    responseBody,
    findToolName,
  }) => {
    expect(validateReducedRequestsForTarget(request, transformer)).toEqual([]);
    let upstreamBody: Record<string, unknown> | undefined;

    const result = await executeProviderCall({
      executor: new TransformerChainExecutor(),
      request,
      provider,
      chain: { providerTransformers: [transformer], modelTransformers: [] },
      endpointTransformer: new OpenAIResponseTransformer(),
      resolveUrl: () => 'https://example.test/upstream',
      buildHeaders: () => ({}),
      fetchFn: async (_url, _headers, body) => {
        upstreamBody = body as Record<string, unknown>;
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      runResponseChain: true,
      preserveEndpointRequestForResponseChain: true,
    });

    expect(upstreamBody).toBeDefined();
    expect(findToolName(upstreamBody!)).toBe('spawn_agent');
    expect(JSON.stringify(upstreamBody)).not.toContain('collaboration');

    const response = await result.response.json() as {
      output: Array<Record<string, unknown>>;
    };
    expect(response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        namespace: 'collaboration',
        name: 'spawn_agent',
      }),
    ]));
  });

  // The codex CLI puts tool_choice + parallel_tool_calls + the stateless
  // session hints on every request; the reduced gate must admit them and each
  // target wire must receive its representable equivalent.
  const codexRequest = {
    model: 'mapped-model',
    input: [{ type: 'message', role: 'user', content: 'delegate' }],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    top_p: 0.9,
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'codex-session',
    // Stands in for whatever field the NEXT codex release adds: admitted by
    // the gate, audit-dropped, and physically unable to reach the upstream.
    future_field: true,
    stream: false,
  };

  const wireExpectations: Record<string, (body: Record<string, unknown>) => void> = {
    'OpenAI Chat': (body) => {
      expect(body.tool_choice).toBe('auto');
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.top_p).toBe(0.9);
    },
    Anthropic: (body) => {
      expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      expect(body.top_p).toBe(0.9);
      expect('parallel_tool_calls' in body).toBe(false);
    },
    Gemini: (body) => {
      expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'auto' } });
      expect((body.generationConfig as Record<string, unknown>).topP).toBe(0.9);
      expect('parallel_tool_calls' in body).toBe(false);
    },
  };

  it.each(targets)('$name forwards codex tool_choice / parallel_tool_calls / drops session hints', async ({
    name,
    transformer,
    responseBody,
  }) => {
    expect(validateReducedRequestsForTarget(codexRequest, transformer)).toEqual(['future_field']);
    let upstreamBody: Record<string, unknown> | undefined;

    await executeProviderCall({
      executor: new TransformerChainExecutor(),
      request: codexRequest,
      provider,
      chain: { providerTransformers: [transformer], modelTransformers: [] },
      endpointTransformer: new OpenAIResponseTransformer(),
      resolveUrl: () => 'https://example.test/upstream',
      buildHeaders: () => ({}),
      fetchFn: async (_url, _headers, body) => {
        upstreamBody = body as Record<string, unknown>;
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      runResponseChain: true,
      preserveEndpointRequestForResponseChain: true,
    });

    expect(upstreamBody).toBeDefined();
    wireExpectations[name]?.(upstreamBody!);
    expect(JSON.stringify(upstreamBody)).not.toContain('prompt_cache_key');
    expect(JSON.stringify(upstreamBody)).not.toContain('encrypted_content');
    expect(JSON.stringify(upstreamBody)).not.toContain('future_field');
  });
});
