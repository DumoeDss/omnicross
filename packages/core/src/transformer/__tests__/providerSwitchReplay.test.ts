import { describe, expect, it } from 'vitest';

import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import { buildRequestBody, transformRequestOut } from '../transformers/utils/gemini.util';
import type { TransformerContext, UnifiedChatRequest } from '../types';

const plaintext = { type: 'reasoning', id: 'rs_chat', summary: [{ type: 'summary_text', text: 'foreign thinking' }] };
const encrypted = { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'opaque-native' };

describe('provider replay at the transformer boundary', () => {
  it.each([
    { codex: true, store: undefined, stripped: true },
    { codex: false, store: false, stripped: true },
    { codex: false, store: true, stripped: false },
    { codex: false, store: undefined, stripped: false },
  ])('handles native Responses input with codex=$codex, store=$store', async ({ codex, store, stripped }) => {
    const transformer = new OpenAIResponseTransformer();
    const context: TransformerContext = {};
    const input = [{ type: 'message', role: 'user', content: 'continue' }, plaintext, encrypted];
    const before = structuredClone(input);
    const unified = await transformer.transformRequestOut({ model: 'gpt-native', input, store }, context);
    const result = await transformer.transformRequestIn(unified, {
      name: 'target', baseUrl: 'https://example.test/v1', apiKey: 'test', models: [],
      ...(codex ? { responsesDialect: 'codex' as const } : {}),
    }, context);
    const body = result.body as Record<string, unknown>;
    expect(body.input).toEqual(stripped ? [input[0], encrypted] : input);
    expect(input).toEqual(before);
  });

  it.each([true, false])('repairs translated Chat replay envelopes with codex=%s', async (codex) => {
    const request = {
      model: 'gpt-native', messages: [{
        role: 'assistant', content: 'answer', extra_content: { responses: { reasoning: [plaintext, { ...encrypted, id: 'legacy-id' }] } },
      }],
    } as unknown as UnifiedChatRequest;
    const before = structuredClone(request);
    const result = await new OpenAIResponseTransformer().transformRequestIn(request, {
      name: 'target', baseUrl: 'https://example.test/v1', apiKey: '', models: [],
      ...(codex ? { responsesDialect: 'codex' as const } : {}),
    }, {});
    expect((result.body as Record<string, unknown>).input).toEqual([
      { ...encrypted, id: codex ? 'rs_legacy-id' : 'legacy-id' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
    expect(request).toEqual(before);
  });

  it('imports an unsigned Gemini 2.x parallel tool turn into Gemini 3 without changing the source', () => {
    const parts = [
      { functionCall: { id: 'a', name: 'read', args: {} } },
      { functionCall: { id: 'b', name: 'read', args: {} } },
    ];
    const request = transformRequestOut({ model: 'gemini-2.5-pro', contents: [{ role: 'model', parts }] });
    request.model = 'gemini-3-pro-preview';
    const body = buildRequestBody(request);
    expect(body.contents[0].parts).toEqual([
      { ...parts[0], thoughtSignature: 'skip_thought_signature_validator' }, parts[1],
    ]);
    expect(parts[0]).not.toHaveProperty('thoughtSignature');
    expect(buildRequestBody({ ...request, model: 'gemini-2.5-pro' }).contents[0].parts).toEqual(parts);
  });

  it('preserves native Gemini signatures and the remaining parallel calls byte-for-byte', () => {
    const parts = [
      { functionCall: { id: 'a', name: 'read', args: {} }, thoughtSignature: 'native-opaque' },
      { functionCall: { id: 'b', name: 'read', args: {} } },
    ];
    const body = buildRequestBody(transformRequestOut({ model: 'gemini-3-pro-preview', contents: [{ role: 'model', parts }] }));
    expect(body.contents[0].parts).toEqual(parts);
    body.contents[0].parts.forEach((part, index) => expect(part).toBe(parts[index]));
  });
});
