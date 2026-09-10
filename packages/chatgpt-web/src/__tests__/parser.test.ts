/**
 * Parser tests: Codex Responses input-item taxonomy normalization.
 *
 * @module @omnicross/chatgpt-web/bridge/__tests__/parser.test
 */

import { describe, expect, it } from 'vitest';

import { parseRequest } from '../bridge/parser';

describe('parseRequest', () => {
  it('parses a minimal user turn', () => {
    const parsed = parseRequest({
      model: 'chatgpt-web/pro',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    expect(parsed.modelId).toBe('chatgpt-web/pro');
    expect(parsed.stream).toBe(true);
    expect(parsed.context.messages).toHaveLength(1);
    expect(parsed.context.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('collects instructions into the system prompt', () => {
    const parsed = parseRequest({
      model: 'm',
      instructions: 'You are Codex.',
      input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'extra' }] }],
    });
    expect(parsed.context.systemPrompt).toEqual(['You are Codex.', 'extra']);
  });

  it('keeps images structured instead of inlining them as text', () => {
    const parsed = parseRequest({
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
          ],
        },
      ],
    });
    const message = parsed.context.messages[0];
    expect(message.role).toBe('user');
    if (typeof message.content === 'string') throw new Error('expected parts');
    expect(message.content[0]).toEqual({ type: 'text', text: 'look' });
    expect(message.content[1]).toEqual({ type: 'image', imageUrl: 'data:image/png;base64,AAAA', detail: 'high' });
  });

  it('pairs function_call with its later output', () => {
    const parsed = parseRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'list files' },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a\nb' },
      ],
    });
    const assistant = parsed.context.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant?.role !== 'assistant') throw new Error('unreachable');
    expect(assistant.content[0]).toMatchObject({ type: 'toolCall', id: 'call_1', name: 'shell' });
    const result = parsed.context.messages.at(-1);
    expect(result).toMatchObject({ role: 'toolResult', toolCallId: 'call_1', toolName: 'shell', content: 'a\nb' });
  });

  it('folds reasoning siblings into the following assistant message', () => {
    const parsed = parseRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'q' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking…' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      ],
    });
    const assistant = parsed.context.messages.find((m) => m.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('unreachable');
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'thinking…' });
    expect(assistant.content[1]).toEqual({ type: 'text', text: 'a' });
  });

  it('flags compaction_trigger requests', () => {
    const parsed = parseRequest({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'task' },
        { type: 'compaction_trigger' },
      ],
    });
    expect(parsed._compactionRequest).toBe(true);
  });

  it('decodes ocx1 compaction summaries back into readable text', () => {
    const encoded = 'ocx1:' + Buffer.from('the summary', 'utf8').toString('base64');
    const parsed = parseRequest({
      model: 'm',
      input: [{ type: 'compaction', encrypted_content: encoded }],
    });
    expect(parsed.context.messages[0]).toMatchObject({ role: 'user' });
    expect(parsed.context.messages[0].content).toContain('the summary');
  });

  it('rejects previous_response_id explicitly', () => {
    expect(() =>
      parseRequest({ model: 'm', previous_response_id: 'resp_1', input: [] }),
    ).toThrow(/previous_response_id/);
  });

  it('flattens namespace tools and marks freeform custom tools', () => {
    const parsed = parseRequest({
      model: 'm',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          tools: [
            { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } },
            { type: 'custom', name: 'apply_patch', description: 'patch' },
          ],
        },
        { type: 'namespace', name: 'mcp__ctx', tools: [{ type: 'function', name: 'lookup', parameters: {} }] },
        { type: 'tool_search' },
        { type: 'web_search' },
      ],
    });
    const tools = parsed.context.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(['shell', 'apply_patch', 'lookup', 'tool_search']);
    expect(tools.find((t) => t.name === 'apply_patch')?.freeform).toBe(true);
    expect(tools.find((t) => t.name === 'lookup')?.namespace).toBe('mcp__ctx');
    expect(tools.find((t) => t.name === 'tool_search')?.toolSearch).toBe(true);
  });

  it('degrades ultra reasoning effort to max like codex-rs', () => {
    const parsed = parseRequest({ model: 'm', reasoning: { effort: 'ultra', summary: 'auto' } });
    expect(parsed.options.reasoning).toBe('max');
    expect(parsed.options.hideThinkingSummary).toBeUndefined();
  });

  it('hides thinking summaries when summary is absent or none', () => {
    expect(parseRequest({ model: 'm' }).options.hideThinkingSummary).toBe(true);
    expect(parseRequest({ model: 'm', reasoning: { summary: 'none' } }).options.hideThinkingSummary).toBe(true);
    expect(parseRequest({ model: 'm', reasoning: { summary: 'auto' } }).options.hideThinkingSummary).toBeUndefined();
  });
});
