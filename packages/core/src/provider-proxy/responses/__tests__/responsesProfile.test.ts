import { describe, expect, it } from 'vitest';

import {
  classifyResponsesProfile,
  resolveReducedResponsesCapabilities,
  validateReducedResponsesRequest,
} from '../responsesProfile';

const chatCapabilities = resolveReducedResponsesCapabilities({
  authMode: 'subscription',
  subscriptionTransformerNames: ['openai'],
});
const responsesCapabilities = resolveReducedResponsesCapabilities({
  authMode: 'subscription',
  subscriptionTransformerNames: ['openai-response'],
});

describe('classifyResponsesProfile', () => {
  it('classifies only explicitly declared BYO Responses providers as native', () => {
    expect(classifyResponsesProfile({ authMode: 'byo', providerApiFormat: 'openai-response' })).toBe('native');
    for (const providerApiFormat of ['openai', 'anthropic', 'google', 'azure-openai'] as const) {
      expect(classifyResponsesProfile({ authMode: 'byo', providerApiFormat })).toBe('reduced');
    }
  });

  it('classifies the declared Codex subscription Responses profile as native', () => {
    expect(classifyResponsesProfile({
      authMode: 'subscription',
      subscriptionProviderId: 'codex',
      subscriptionTransformerNames: ['metrics-hook', 'openai-response'],
      upstreamUrl: 'https://chatgpt.com/backend-api/codex/responses?feature=1',
    })).toBe('native');
  });

  it('does not infer native support from matching transformer arrays', () => {
    expect(classifyResponsesProfile({
      authMode: 'subscription',
      subscriptionProviderId: 'opencodego',
      subscriptionTransformerNames: ['openai-response'],
      upstreamUrl: 'https://example.test/v1/responses',
    })).toBe('reduced');
    expect(classifyResponsesProfile({
      authMode: 'subscription',
      subscriptionProviderId: 'codex',
      subscriptionTransformerNames: ['openai-response'],
      upstreamUrl: 'https://example.test/v1/chat/completions',
    })).toBe('reduced');
  });

  it('derives reasoning-summary fidelity from declarative target metadata', () => {
    for (const providerApiFormat of ['openai', 'anthropic', 'google', 'azure-openai'] as const) {
      expect(resolveReducedResponsesCapabilities({
        authMode: 'byo',
        providerApiFormat,
      }).reasoningSummary).toBe(false);
    }
    for (const transformerName of ['openai', 'anthropic', 'gemini'] as const) {
      expect(resolveReducedResponsesCapabilities({
        authMode: 'subscription',
        subscriptionTransformerNames: [transformerName],
      }).reasoningSummary).toBe(false);
    }
    expect(responsesCapabilities.reasoningSummary).toBe(true);
    expect(resolveReducedResponsesCapabilities({
      authMode: 'subscription',
      subscriptionTransformerNames: [],
    }).reasoningSummary).toBe(true);
  });
});

describe('validateReducedResponsesRequest', () => {
  it('accepts the tested text, reasoning, function, and custom-tool subset', () => {
    expect(() => validateReducedResponsesRequest({
      model: 'client-model',
      instructions: 'Be precise',
      stream: true,
      max_output_tokens: 512,
      temperature: 0.2,
      reasoning: { effort: 'high', summary: 'concise' },
      tools: [
        { type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object' } },
        { type: 'custom', name: 'exec', description: 'Run free-form input' },
      ],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call', call_id: 'call_1', name: 'lookup',
          namespace: 'collaboration', arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
        { type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'pwd' },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'ok' }] },
        { type: 'additional_tools', role: 'developer', tools: [
          { type: 'function', name: 'send', parameters: { type: 'object' } },
          { type: 'custom', name: 'shell' },
          { type: 'namespace', name: 'collaboration', tools: [
            { type: 'function', name: 'spawn_agent', parameters: { type: 'object' } },
          ] },
        ] },
      ],
    }, responsesCapabilities)).not.toThrow();
  });

  it('rejects reasoning summary when the declared target cannot preserve it', () => {
    expect(() => validateReducedResponsesRequest({
      input: 'think',
      reasoning: { effort: 'high', summary: 'detailed' },
    }, chatCapabilities)).toThrow(expect.objectContaining({
      code: 'unsupported_capability',
      message: expect.stringContaining('$.reasoning.summary'),
    }));
  });

  const rejected: Array<[string, Record<string, unknown>, string]> = [
    ['unknown field', { input: 'x', future_field: true }, '$.future_field'],
    ['state reference', { input: 'x', previous_response_id: 'resp_secret' }, '$.previous_response_id'],
    ['background', { input: 'x', background: true }, '$.background'],
    ['hosted tool', { input: 'x', tools: [{ type: 'web_search_preview' }] }, '$.tools[0].type'],
    ['image part', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'secret' }] }] }, '$.input[0].content[0].type'],
    ['file part', { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_secret' }] }] }, '$.input[0].content[0].type'],
    ['opaque item', { input: [{ type: 'reasoning', encrypted_content: 'secret' }] }, '$.input[0].type'],
    ['bad reasoning shape', { input: 'x', reasoning: { effort: 7 } }, '$.reasoning.effort'],
    ['prompt cache hint', { input: 'x', prompt_cache_key: 'opaque-cache' }, '$.prompt_cache_key'],
    ['function strict', { input: 'x', tools: [{ type: 'function', name: 'f', strict: true }] }, '$.tools[0].strict'],
    ['custom format', { input: 'x', tools: [{ type: 'custom', name: 'c', format: { type: 'grammar' } }] }, '$.tools[0].format'],
    ['message status', { input: [{ type: 'message', role: 'user', content: 'x', status: 'completed' }] }, '$.input[0].status'],
    ['message id', { input: [{ type: 'message', role: 'user', content: 'x', id: 'msg_1' }] }, '$.input[0].id'],
    ['function item id', { input: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'f', arguments: '{}' }] }, '$.input[0].id'],
    ['function item status', { input: [{ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}', status: 'completed' }] }, '$.input[0].status'],
    ['invalid function namespace', { input: [{ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}', namespace: 7 }] }, '$.input[0].namespace'],
    ['custom item id', { input: [{ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'c', input: 'x' }] }, '$.input[0].id'],
    ['output status', { input: [{ type: 'function_call_output', call_id: 'call_1', output: 'x', status: 'completed' }] }, '$.input[0].status'],
    ['top-level namespace declaration', { input: 'x', tools: [{ type: 'namespace', name: 'ns', tools: [] }] }, '$.tools[0].type'],
  ];

  it.each(rejected)('rejects %s with a safe structured path', (_name, body, path) => {
    expect(() => validateReducedResponsesRequest(body, chatCapabilities)).toThrow(expect.objectContaining({
      name: 'OpenAIOperationError',
      code: 'unsupported_capability',
      status: 400,
      retryable: false,
      message: expect.stringContaining(path),
    }));
  });
});
