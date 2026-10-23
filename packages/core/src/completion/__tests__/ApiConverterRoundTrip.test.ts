import type { AnthropicChatResponse, OpenAIChatRequest } from '@omnicross/contracts/completion-types';
import { describe, expect, it } from 'vitest';

import {
  convertAnthropicRequestToOpenAI, convertAnthropicStreamToOpenAI, convertAnthropicToOpenAI,
  convertOpenAIResponseToAnthropic, convertOpenAIStreamToAnthropic, convertOpenAIToAnthropic,
} from '../../ApiConverter';
import { createSSEParser } from '../../sse-parser';

async function* fragments(text: string) {
  for (let index = 0; index < text.length; index += 7) yield text.slice(index, index + 7);
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

function wire(events: unknown[]): string {
  return events.map(event => `data:${JSON.stringify(event)}\r\n\r\n`).join('');
}

const native: AnthropicChatResponse = {
  id: 'msg_native', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'check', signature: 'signature-A' },
    { type: 'redacted_thinking', data: 'opaque-B' },
    { type: 'text', text: 'first' }, { type: 'text', text: 'second' },
    { type: 'tool_use', id: 'call_a', name: 'lookup', input: { q: 'a' } },
    { type: 'tool_use', id: 'call_b', name: 'lookup', input: { q: 'b' } },
  ],
  usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 5 },
};

describe('public independent API converters', () => {
  it('round-trips signed reasoning and parallel tools through native Chat reasoning_content', () => {
    const chat = convertAnthropicToOpenAI(native);
    expect(chat.choices[0].message.reasoning_content).toBe('check');
    expect(chat.reasoning_content).toBeUndefined();
    expect(chat.choices[0].message.content).toBe('firstsecond');
    const restored = convertOpenAIResponseToAnthropic(chat);
    expect(restored.content).toEqual([
      ...native.content.slice(0, 2), { type: 'text', text: 'firstsecond' }, ...native.content.slice(4),
    ]);
    expect(restored.stop_reason).toBe('tool_use');
    expect(restored.usage).toEqual(native.usage);
    const replay = convertOpenAIToAnthropic({
      model: native.model, messages: [chat.choices[0].message],
    }, { defaultModel: native.model });
    expect(replay.messages[0].content).toEqual(restored.content);
  });

  it('keeps every parallel result and accompanying user text in the next request', () => {
    const request = convertAnthropicRequestToOpenAI({
      model: 'test', max_tokens: 99, temperature: 0, top_p: 0.8, stop_sequences: ['END'],
      tools: [{ name: 'lookup', description: '', input_schema: { type: 'object' } }],
      tool_choice: { type: 'none', disable_parallel_tool_use: true },
      messages: [{ role: 'assistant', content: native.content }, { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'B', is_error: true },
        { type: 'text', text: 'continue' },
      ] }],
    });
    expect(request.messages.filter(message => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', content: '{"error":"B"}' },
    ]);
    expect(request.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'continue' }]);
    const restored = convertOpenAIToAnthropic(request, { defaultModel: 'claude-test' });
    expect(restored).toMatchObject({ max_tokens: 99, temperature: 0, top_p: 0.8, stop_sequences: ['END'], tool_choice: { type: 'none', disable_parallel_tool_use: true } });
    expect(restored.messages[0].content).toEqual(native.content.slice(0, 2).concat([
      { type: 'text', text: 'firstsecond' }, ...native.content.slice(4),
    ]));
  });

  it('preserves multiple system messages, inline PDF bytes and image URLs', () => {
    const request: OpenAIChatRequest = {
      model: 'test', max_tokens: 4, max_completion_tokens: 18,
      messages: [
        { role: 'system', content: 'one' }, { role: 'system', content: 'two' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
          { type: 'file', file: { filename: 'source.pdf', file_data: 'data:application/pdf;base64,JVBERg==' } },
        ] },
      ],
    };
    const anthropic = convertOpenAIToAnthropic(request, { defaultModel: 'claude-test' });
    expect(anthropic.max_tokens).toBe(18);
    const restored = convertAnthropicRequestToOpenAI(anthropic);
    expect(restored.messages[0].content).toBe('one\ntwo');
    expect(restored.messages[1].content).toEqual(request.messages[2].content);
  });

  it('does not silently replace multimodal tool results with placeholders', () => {
    expect(() => convertAnthropicRequestToOpenAI({ model: 'test', max_tokens: 9, messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } },
      ] }] },
    ] })).toThrow(/tool result content/);
  });

  it('converts fragmented reasoning, split tool identities and trailing usage with exactly one terminal', async () => {
    const input = wire([
      { id: 'chat_1', model: 'test', choices: [{ delta: { reasoning_content: 'plan' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'look', arguments: '{"q":' } },
        { index: 1, id: 'call_b', function: { name: 'lookup', arguments: '{"q":"b"}' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'up', arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } },
    ]) + 'data:[DONE]\r\n\r\n';
    const output = await collect(convertOpenAIStreamToAnthropic(fragments(input)));
    const parser = createSSEParser('anthropic', {});
    parser.push(output); parser.flush();
    expect(parser.getResult()).toMatchObject({ content: 'answer', reasoning: 'plan', usage: { promptTokens: 12, completionTokens: 9, totalTokens: 21 }, toolCalls: [
      { id: 'call_a', name: 'lookup', args: { q: 'a' } }, { id: 'call_b', name: 'lookup', args: { q: 'b' } },
    ] });
    expect(output.match(/event: message_stop/g)).toHaveLength(1);
    expect(output.match(/event: message_delta/g)).toHaveLength(1);
    expect(output).toContain('"stop_reason":"tool_use"');
  });

  it('round-trips independent SSE native signatures, redactions and start usage', async () => {
    const input = wire([
      { type: 'message_start', message: { id: 'msg', model: 'claude-test', usage: { input_tokens: 7, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'plan', signature: 'sig-A' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-B' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"value"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]);
    const chat = await collect(convertAnthropicStreamToOpenAI(fragments(input)));
    const output = await collect(convertOpenAIStreamToAnthropic(fragments(chat)));
    const parser = createSSEParser('anthropic', {});
    parser.push(output); parser.flush();
    expect(parser.getResult()).toMatchObject({ reasoning: 'plan', usage: { promptTokens: 12, completionTokens: 9, totalTokens: 21 }, toolCalls: [{ id: 'call', name: 'lookup', args: { q: 'value' } }] });
    expect(parser.getResult().providerMetadata?.content.slice(0, 2)).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig-A' }, { type: 'redacted_thinking', data: 'opaque-B' },
    ]);
  });

  it('surfaces upstream errors instead of emitting a successful stop', async () => {
    const output = await collect(convertOpenAIStreamToAnthropic(fragments(wire([{ error: { message: 'quota' } }]))));
    expect(output).toContain('quota');
    expect(output).not.toContain('message_stop');
    await expect(collect(convertAnthropicStreamToOpenAI(fragments(wire([{ type: 'message_start', message: { id: 'msg', model: 'test' } }]))))).rejects.toThrow(/message_stop/);
  });
});
