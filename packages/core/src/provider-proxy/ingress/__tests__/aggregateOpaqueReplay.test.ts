import { describe, expect, it } from 'vitest';
import { AnthropicTransformer } from '../../../transformer/transformers/AnthropicTransformer';
import { OpenAITransformer } from '../../../transformer/transformers/OpenAITransformer';
import { OpenAIResponseTransformer } from '../../../transformer/transformers/OpenAIResponseTransformer';
import { GeminiTransformer } from '../../../transformer/transformers/GeminiTransformer';
import { aggregateAnthropicSseToJsonBody, aggregateOpenAIChatChunksToJsonBody } from '../providerProxyShared';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected wire object');
  return value as Record<string, unknown>;
}
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('Expected wire objects');
  return value.map(object);
}
const event = (type: string, body: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const sse = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const provider = { name: 'anthropic', baseUrl: 'https://example.invalid/v1', apiKey: 'not-used', models: ['claude-sonnet-4-5'] };
async function chatMessage(response: Response): Promise<Record<string, unknown>> {
  const value = await aggregateOpenAIChatChunksToJsonBody(await new OpenAITransformer().transformResponseIn(response, {}));
  if (!value) throw new Error('Expected a completed Chat stream');
  return object(objects(object(JSON.parse(value)).choices)[0].message);
}

describe('buffered SSE preserves replayable provider state', () => {
  it('replays separate Anthropic signatures and redacted data after a Chat client round trip', async () => {
    const anthropic = new AnthropicTransformer();
    const blocks = [
      { type: 'thinking', thinking: 'First.', signature: 'opaque-first' },
      { type: 'redacted_thinking', data: 'opaque-redacted' },
      { type: 'thinking', thinking: 'Second.', signature: 'opaque-second' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
    ];
    const source = event('message_start', { message: { id: 'm', model: 'claude-sonnet-4-5' } }) +
      blocks.map((content_block, index) => event('content_block_start', { index, content_block }) + event('content_block_stop', { index })).join('') +
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }) + event('message_stop', {});
    const message = await chatMessage(await anthropic.transformResponseOut(sse(source), {}));
    const decoded = await new OpenAITransformer().transformRequestOut({ model: 'claude-sonnet-4-5', messages: [message] }, {});
    const encoded = await anthropic.transformRequestIn(decoded, provider, {});
    expect(objects(encoded.messages)[0].content).toEqual(blocks);
  });

  it('replays every encrypted Responses reasoning item, not just the final SSE item', async () => {
    const responses = new OpenAIResponseTransformer();
    const items = [
      { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'One.' }], encrypted_content: 'encrypted-one' },
      { id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: 'encrypted-two' },
    ];
    const source = event('response.created', { response: { id: 'r', model: 'gpt-5', output: [] } }) +
      items.map((item, output_index) => event('response.output_item.done', { item, output_index })).join('') +
      event('response.completed', { response: { id: 'r', model: 'gpt-5', status: 'completed', output: items } });
    const message = await chatMessage(await responses.transformResponseOut(sse(source), {}));
    const decoded = await new OpenAITransformer().transformRequestOut({ model: 'gpt-5', messages: [message] }, {});
    const encoded = object(await responses.transformRequestIn(decoded, { ...provider, name: 'openai', models: ['gpt-5'] }, {}));
    expect(objects(object(encoded.body ?? encoded).input).filter(item => item.type === 'reasoning')).toEqual(items);
  });

  it('replays Google parts in order across Claude content blocks and trailing metadata', async () => {
    const gemini = new GeminiTransformer();
    const anthropic = new AnthropicTransformer();
    const parts = [
      { text: 'Think.', thought: true, thoughtSignature: 'sig-thought' },
      { functionCall: { id: 'a', name: 'lookup', args: { name: 'a' } }, thoughtSignature: 'sig-a' },
      { functionCall: { id: 'b', name: 'lookup', args: { name: 'b' } }, thoughtSignature: 'sig-b' },
      { thoughtSignature: 'sig-tail' },
    ];
    const source = parts.map((part, index) => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [part] }, ...(index === parts.length - 1 ? { finishReason: 'STOP' } : {}) }] })}\n\n`).join('');
    const client = await anthropic.transformResponseIn(await gemini.transformResponseOut(sse(source), {}), {});
    const message: unknown = JSON.parse(await aggregateAnthropicSseToJsonBody(client));
    const decoded = await anthropic.transformRequestOut({ model: 'gemini-2.5-flash', messages: [message] }, {});
    const encoded = object(await gemini.transformRequestIn(decoded, { ...provider, name: 'gemini', models: ['gemini-2.5-flash'] }, {}));
    expect(objects(object(encoded.body ?? encoded).contents)[0].parts).toEqual(parts);
  });
});
