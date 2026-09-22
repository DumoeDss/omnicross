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
const anthropicCapabilities = resolveReducedResponsesCapabilities({
  authMode: 'subscription',
  subscriptionTransformerNames: ['anthropic'],
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

  it('accepts the codex CLI request surface over reduced targets', () => {
    expect(validateReducedResponsesRequest({
      model: 'glm-4.7',
      instructions: 'Be precise',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      top_p: 0.9,
      // 'auto' is best-effort: a summary-less target answers without summaries.
      reasoning: { effort: 'high', summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'codex-session',
      truncation: 'auto',
      text: { verbosity: 'medium' },
    }, chatCapabilities)).toEqual([]);
  });

  it('admits unknown top-level fields and returns their names for the audit', () => {
    // A codex/CLI update adding a request field must degrade to an ignored
    // knob (audit-dropped downstream), not a hard 400.
    expect(validateReducedResponsesRequest({
      input: 'x',
      future_field: true,
      another_new_knob: 'value',
    }, chatCapabilities)).toEqual(['future_field', 'another_new_knob']);
  });

  it('admits unknown reasoning sub-fields (knob container) with audit names', () => {
    // codex started sending `reasoning.context` in the wild — same tier as an
    // unknown top-level knob, NOT a structural rejection.
    expect(validateReducedResponsesRequest({
      input: 'x',
      reasoning: { effort: 'high', context: { compress: true } },
    }, chatCapabilities)).toEqual(['reasoning.context']);
  });

  it('maps text.format where the target wire has a structured-output counterpart', () => {
    expect(validateReducedResponsesRequest({
      input: 'x',
      text: {
        verbosity: 'medium',
        format: { type: 'json_schema', name: 'plan', strict: true, schema: { type: 'object' } },
      },
    }, chatCapabilities)).toEqual([]);
  });

  it('refuses text.format on wires with no structured-output counterpart', () => {
    // Anthropic-shaped wires have no response_format: silently answering free
    // text where the caller parses JSON corrupts the caller — fail loudly.
    for (const format of [{ type: 'json_object' }, { type: 'json_schema', schema: { type: 'object' } }]) {
      expect(() => validateReducedResponsesRequest({
        input: 'x',
        text: { format },
      }, anthropicCapabilities)).toThrow(expect.objectContaining({
        code: 'unsupported_capability',
        message: expect.stringContaining('$.text.format.type'),
      }));
    }
    // The plain "text" format is a no-op and stays admissible everywhere.
    expect(validateReducedResponsesRequest({
      input: 'x',
      text: { format: { type: 'text' } },
    }, anthropicCapabilities)).toEqual([]);
  });

  it('accepts the function and allowed_tools tool_choice forms', () => {
    expect(() => validateReducedResponsesRequest({
      input: 'x',
      tool_choice: { type: 'function', name: 'shell' },
    }, chatCapabilities)).not.toThrow();
    expect(() => validateReducedResponsesRequest({
      input: 'x',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'function', name: 'shell' }],
      },
    }, chatCapabilities)).not.toThrow();
  });

  const rejected: Array<[string, Record<string, unknown>, string]> = [
    ['state reference', { input: 'x', previous_response_id: 'resp_secret' }, '$.previous_response_id'],
    ['background', { input: 'x', background: true }, '$.background'],
    ['stateful store', { input: 'x', store: true }, '$.store'],
    ['top_p type', { input: 'x', top_p: '0.9' }, '$.top_p'],
    ['tool choice mode', { input: 'x', tool_choice: 'sometimes' }, '$.tool_choice'],
    ['hosted tool choice', { input: 'x', tool_choice: { type: 'web_search' } }, '$.tool_choice.type'],
    ['allowed_tools mode', { input: 'x', tool_choice: { type: 'allowed_tools', mode: 'sometimes', tools: [{ type: 'function', name: 'f' }] } }, '$.tool_choice.mode'],
    ['allowed_tools hosted entry', { input: 'x', tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }] } }, '$.tool_choice.tools[0].type'],
    ['parallel_tool_calls type', { input: 'x', parallel_tool_calls: 'no' }, '$.parallel_tool_calls'],
    ['include type', { input: 'x', include: [7] }, '$.include'],
    ['truncation value', { input: 'x', truncation: 'aggressive' }, '$.truncation'],
    ['text format type', { input: 'x', text: { format: { type: 'yaml' } } }, '$.text.format.type'],
    ['text format schema shape', { input: 'x', text: { format: { type: 'json_schema', schema: 'oops' } } }, '$.text.format.schema'],
    ['hosted tool', { input: 'x', tools: [{ type: 'web_search_preview' }] }, '$.tools[0].type'],
    ['image part', { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'secret' }] }] }, '$.input[0].content[0].type'],
    ['file part', { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_secret' }] }] }, '$.input[0].content[0].type'],
    ['opaque item', { input: [{ type: 'reasoning', encrypted_content: 'secret' }] }, '$.input[0].type'],
    ['bad reasoning shape', { input: 'x', reasoning: { effort: 7 } }, '$.reasoning.effort'],
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
