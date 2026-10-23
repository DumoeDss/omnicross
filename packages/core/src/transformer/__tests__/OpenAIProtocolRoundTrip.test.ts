import { describe, expect, it } from 'vitest';
import { OpenAITransformer } from '../transformers/OpenAITransformer';
import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import type { LLMProvider, TransformerContext, UnifiedChatRequest } from '../types';
import { DsmlStreamSuppressor, salvageDsmlToolCalls } from '../transformers/utils/dsmlToolCalls';
import { isResponseFormatRejection } from '../transformers/utils/structuredOutput';
import { markReasoningReplayRequired, reasoningReplayKey, shouldReplayReasoning, resetReasoningReplayStateForTests } from '../transformers/utils/reasoningReplay';

interface AuditItem { type: string; id: string; call_id: string; name: string; arguments: string }
interface AuditEvent {
  type: string;
  item_id: string;
  arguments?: string;
  delta: string;
  response: { output: AuditItem[]; usage: Record<string, number> };
  choices: Array<{ delta: Record<string, unknown> }>;
}

const provider = { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'test' } as LLMProvider;
const responses = new OpenAIResponseTransformer();
const chat = new OpenAITransformer();

function sse(events: unknown[], fragment = false): Response {
  const encoded = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (fragment) for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      else controller.enqueue(encoded);
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function events(response: Response): Promise<AuditEvent[]> {
  return (await response.text()).split('\n').filter((line) => line.startsWith('data:') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(5)));
}

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason }],
});

describe('OpenAI protocol consumer round trips', () => {
  it('replays streamed parallel calls and reasoning with trailing usage without duplicated arguments', async () => {
    const wire = await events(await responses.transformResponseIn(sse([
      chunk({ reasoning_content: '先检查' }),
      chunk({ tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'read_', arguments: '' } },
        { index: 1, id: 'fc_a', function: { name: 'search', arguments: '{"q":' } },
      ] }),
      chunk({ tool_calls: [
        { index: 0, function: { name: 'file', arguments: '{"path":"x"}' } },
        { index: 1, function: { arguments: '"x"}' } },
      ] }),
      chunk({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    ], true), {}));
    const final = wire.find((event) => event.type === 'response.completed')!.response;
    expect(final.usage.total_tokens).toBe(18);
    const calls = final.output.filter((item) => item.type === 'function_call');
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(calls.find((call) => call.call_id === 'call_a')).toMatchObject({ name: 'read_file', arguments: '{"path":"x"}' });
    for (const call of calls) {
      const args = wire.filter((event) => event.type === 'response.function_call_arguments.delta' && event.item_id === call.id).map((event) => event.delta).join('');
      expect(args).toBe(call.arguments);
      expect(wire.find((event) => event.type === 'response.function_call_arguments.done' && event.item_id === call.id)?.arguments).toBe(call.arguments);
    }
    const context: TransformerContext = {};
    const request = await responses.transformRequestOut({
      model: 'deepseek-v4-pro', input: [...final.output, ...calls.map((call) => ({ type: 'function_call_output', call_id: call.call_id, output: 'ok' }))],
    }, context);
    const body = await chat.transformRequestIn(request, { ...provider, name: 'deepseek', baseUrl: 'https://api.deepseek.com' }, context);
    const history = body.messages as Array<UnifiedChatRequest['messages'][number] & { reasoning_content?: string }>;
    expect(history.find((message) => message.role === 'assistant')?.reasoning_content).toBe('先检查');
    expect(history.flatMap((message) => message.tool_calls ?? []).map((call) => call.id).sort()).toEqual(['call_a', 'fc_a']);
  });

  it('preserves native Responses encrypted reasoning and built-in tools on a same-format request', async () => {
    const original = {
      model: 'gpt-5', store: false, include: ['reasoning.encrypted_content'],
      tools: [{ type: 'web_search' }],
      input: [{ type: 'reasoning', id: 'rs_native', encrypted_content: 'opaque', summary: [] }, { role: 'user', content: '' }],
    };
    const context: TransformerContext = {};
    const request = await responses.transformRequestOut(original, context);
    const encoded = await responses.transformRequestIn(request, provider, context);
    expect(encoded.body).toEqual(original);
  });

  it('accepts string input and preserves whitespace in instructions', async () => {
    const request = await responses.transformRequestOut({ model: 'gpt-5', instructions: '  exact\n', input: 'Hello' }, {});
    expect(request.messages).toEqual([{ role: 'system', content: '  exact\n' }, { role: 'user', content: 'Hello' }]);
  });

  it('carries image requests, schema contracts, and token limits to public Responses without forcing streaming', async () => {
    const request = {
      model: 'gpt-5', stream: false, max_tokens: 23,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object' } } },
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } }] }],
    } as UnifiedChatRequest;
    const body = (await responses.transformRequestIn(request, provider, {})).body as { input: Array<{ content: unknown }> };
    expect(body).toMatchObject({ stream: false, max_output_tokens: 23, text: { format: { type: 'json_schema', strict: true } } });
    expect(body.input[0].content).toEqual([{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' }]);
    const codex = (await responses.transformRequestIn(request, { ...provider, responsesDialect: 'codex' }, {})).body as Record<string, unknown>;
    expect(codex.stream).toBe(true);
    expect(codex.max_output_tokens).toBeUndefined();
  });

  it('preserves reasoning and truncation in Responses JSON to native Chat JSON', async () => {
    const output = await responses.transformResponseOut(Response.json({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'checking' }] }, { type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    }), {});
    expect((await output.json()).choices[0]).toMatchObject({ message: { reasoning_content: 'checking', content: 'partial' }, finish_reason: 'length' });
  });

  it('translates incomplete and failed streaming turns without inventing success', async () => {
    const truncated = await events(await responses.transformResponseIn(sse([chunk({ content: 'partial' }), chunk({}, 'length')]), {}));
    expect(truncated.at(-1)).toMatchObject({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
    const failed = await events(await responses.transformResponseIn(sse([{ error: { code: 'overloaded', message: 'busy' } }]), {}));
    expect(failed.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'overloaded' } } });
    expect(failed.some((event) => event.type === 'response.completed')).toBe(false);
    const inverse = await events(await responses.transformResponseOut(sse([{ type: 'error', code: 'rate_limit', message: 'wait' }]), {}));
    expect(inverse[0]).toMatchObject({ error: { code: 'rate_limit', message: 'wait' } });
    const broken = await responses.transformResponseIn(sse([chunk({ content: 'partial' })]), {});
    await expect(broken.text()).rejects.toThrow('finish reason');
  });

  it('decodes native Chat reasoning for other protocols but encodes native spelling back to Chat', async () => {
    const context: TransformerContext = {};
    const request = await chat.transformRequestOut({ model: 'm', thinking: { type: 'enabled' }, messages: [{ role: 'assistant', content: null, reasoning_content: 'real' }] }, context);
    expect(request.messages[0].thinking?.content).toBe('real');
    const body = await chat.transformRequestIn(request, provider, context);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect((body.messages as unknown[])[0]).toEqual({ role: 'assistant', content: null, reasoning_content: 'real' });
    const json = await chat.transformResponseIn(Response.json({ choices: [{ message: { role: 'assistant', thinking: { content: 'real', signature: 'opaque' }, content: 'answer' } }] }));
    expect((await json.json()).choices[0].message).toMatchObject({ role: 'assistant', reasoning_content: 'real', content: 'answer', extra_content: { omnicross: { thinking: { signature: 'opaque' } } } });
    const streamed = await events(await chat.transformResponseIn(sse([chunk({ thinking: { content: 'thought' } }), chunk({}, 'stop')], true)));
    expect(streamed[0].choices[0].delta).toMatchObject({ reasoning_content: 'thought', extra_content: { omnicross: { thinking: { content: 'thought' } } } });
  });

  it('does not propagate provider-specific thinking controls to an unknown aggregator', async () => {
    const request = { model: 'glm-5.2', messages: [], reasoning: { effort: 'high', enabled: true } } as UnifiedChatRequest;
    const official = await chat.transformRequestIn(request, { ...provider, baseUrl: 'https://api.z.ai/api/paas/v4' }, {});
    expect(official.thinking).toEqual({ type: 'enabled' });
    expect(official.reasoning_effort).toBeUndefined();
    const relay = await chat.transformRequestIn(request, { ...provider, baseUrl: 'https://unknown.example/v1' }, {});
    expect(relay.thinking).toBeUndefined();
    const qwen = await chat.transformRequestIn({ ...request, model: 'qwen3.5-plus', reasoning: { effort: 'none', enabled: false } }, { ...provider, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }, {});
    expect(qwen.enable_thinking).toBe(false);
  });

  it('keeps learned replay demands model scoped and does not downgrade malformed schemas', () => {
    const relay = { name: 'relay', baseUrl: 'https://relay.example' };
    try {
      markReasoningReplayRequired(reasoningReplayKey(relay, 'demanding'));
      expect(shouldReplayReasoning(relay, 'demanding')).toBe(true);
      expect(shouldReplayReasoning(relay, 'forbidding')).toBe(false);
    } finally { resetReasoningReplayStateForTests(); }
    expect(isResponseFormatRejection(400, 'Invalid schema in response_format: required must include x')).toBe(false);
    expect(isResponseFormatRejection(400, 'response_format type is unsupported')).toBe(true);
  });

  it('does not execute fenced or mid-line DSML when delimiters arrive in separate chunks', () => {
    const markup = '<｜DSML｜invoke name="exec"><｜DSML｜parameter name="cmd">ls</｜DSML｜parameter></｜DSML｜invoke>';
    for (const pieces of [['```xml\n', markup, '\n```'], ['Example: ', markup]]) {
      const suppressor = new DsmlStreamSuppressor();
      const text = pieces.map((piece) => suppressor.push(piece)).join('') + suppressor.flush();
      expect(text).toBe(pieces.join(''));
      expect(suppressor.capturing).toBe(false);
    }
    const suppressor = new DsmlStreamSuppressor();
    let emitted = '';
    for (const character of markup) emitted += suppressor.push(character);
    expect(emitted + suppressor.flush()).toBe('');
    expect(salvageDsmlToolCalls(suppressor.capturedText).calls[0]).toEqual({ name: 'exec', arguments: '{"cmd":"ls"}' });
  });
  it('recovers signed and redacted Anthropic blocks from Responses output replay', async () => {
    const blocks = [
      { type: 'thinking', thinking: 'check', signature: 'real-signature' },
      { type: 'redacted_thinking', data: 'real-redaction' },
    ];
    const output = await responses.transformResponseIn(Response.json({ choices: [{ message: {
      role: 'assistant', content: 'answer', thinking: { content: 'check', blocks },
    }, finish_reason: 'stop' }] }), {});
    const result = await output.json();
    const replay = await responses.transformRequestOut({ model: 'claude', input: result.output }, {});
    expect(replay.messages[0].thinking?.blocks).toEqual(blocks);
    const streamed = await events(await responses.transformResponseIn(sse([
      chunk({ thinking: { index: 2, content: 'check' } }),
      chunk({ thinking: { index: 2, signature: 'real-' } }),
      chunk({ thinking: { index: 2, signature: 'signature' } }),
      chunk({ thinking: { index: 3, type: 'redacted_thinking', data: 'real-redaction' } }),
      chunk({ content: 'answer' }), chunk({}, 'stop'),
    ]), {}));
    const final = streamed.find((event) => event.type === 'response.completed')!.response;
    const history = await responses.transformRequestOut({ model: 'claude', input: final.output }, {});
    expect(history.messages[0].thinking?.blocks).toEqual(blocks);
  });

  it('replays original Responses encrypted reasoning through a Chat client', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_real', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'summary' }] };
    const decoded = await responses.transformResponseOut(Response.json({
      output: [reasoning, { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
    }), {});
    const visible = await chat.transformResponseIn(decoded);
    const json = await visible.json();
    const context: TransformerContext = {};
    const request = await chat.transformRequestOut({ model: 'gpt-5', messages: [json.choices[0].message] }, context);
    const encoded = await responses.transformRequestIn(request, provider, context);
    expect(encoded.body).toMatchObject({ input: [reasoning, { role: 'assistant' }] });
  });
  it('retains Google signed parts through a streamed Responses tool round trip', async () => {
    const thought = { text: 'check', thought: true, thoughtSignature: 'google-thought' };
    const call = { functionCall: { name: 'lookup', args: { key: 'x' } }, thoughtSignature: 'google-call' };
    const wire = await events(await responses.transformResponseIn(sse([
      chunk({ thinking: { content: 'check' }, extra_content: { google: { parts: [thought] } } }),
      chunk({
        tool_calls: [{ index: 0, id: 'call_google', function: { name: 'lookup', arguments: '{"key":"x"}' }, extra_content: { google: { thought_signature: 'google-call' } } }],
        extra_content: { google: { parts: [call] } },
      }),
      chunk({}, 'tool_calls'),
    ]), {}));
    const final = wire.find((event) => event.type === 'response.completed')!.response;
    const history = await responses.transformRequestOut({ model: 'gemini', input: final.output }, {});
    expect(history.messages[0]).toMatchObject({
      extra_content: { google: { parts: [thought, call] } },
      tool_calls: [{ id: 'call_google', extra_content: { google: { thought_signature: 'google-call' } } }],
    });
  });

  it('does not leak proxy replay metadata into native Chat requests', async () => {
    const context: TransformerContext = {};
    const request = await chat.transformRequestOut({ model: 'm', messages: [{
      role: 'assistant', content: null,
      extra_content: { google: { parts: [{ text: 'native' }], request: { tools: [] } }, omnicross: { thinking: { content: 'real' } } },
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'real-google' } } }],
    }] }, context);
    const body = await chat.transformRequestIn(request, provider, context);
    expect(body.messages).toEqual([{
      role: 'assistant', content: null, reasoning_content: 'real',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'real-google' } } }],
    }]);
  });

  it.each(['function', 'custom'])('preserves schema opt-out and namespaced forced %s selection', async (type) => {
    const request = await responses.transformRequestOut({
      model: 'm', input: 'go',
      text: { format: { type: 'json_schema', name: 'x', strict: false, schema: { type: 'object' } } },
      tools: [{ type: 'namespace', name: 'files', tools: [{ type, name: 'read', parameters: { type: 'object' } }] }],
      tool_choice: { type, name: 'files.read' },
    }, {});
    expect(request.response_format?.json_schema?.strict).toBe(false);
    expect(request.tool_choice).toEqual({ type: 'function', function: { name: 'files__read' } });
    expect(request.tools?.[0].function.name).toBe('files__read');
  });
  it('preserves empty input and a replayed refusal as readable history', async () => {
    const empty = await responses.transformRequestOut({ model: 'm', input: '' }, {});
    expect(empty.messages).toEqual([{ role: 'user', content: '' }]);
    const refused = await responses.transformRequestOut({
      model: 'm', input: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot do that' }] }],
    }, {});
    expect(refused.messages).toEqual([{ role: 'assistant', content: 'Cannot do that' }]);
  });
  it('dispatches a structured tool only once when DeepSeek also leaks its DSML rendering', async () => {
    const markup = '<｜DSML｜invoke name="lookup"><｜DSML｜parameter name="key">x</｜DSML｜parameter></｜DSML｜invoke>';
    const wire = await events(await responses.transformResponseIn(sse([
      chunk({ content: markup }),
      chunk({ tool_calls: [{ index: 0, id: 'call_real', function: { name: 'lookup', arguments: '{"key":"x"}' } }] }),
      chunk({}, 'tool_calls'),
    ]), {}));
    const output = wire.find((event) => event.type === 'response.completed')!.response.output;
    expect(output.filter((item) => item.type === 'function_call')).toEqual([
      expect.objectContaining({ call_id: 'call_real', name: 'lookup', arguments: '{"key":"x"}' }),
    ]);
  });
  it.each(['chat', 'responses'])('decodes multiline CR-only SSE through the %s endpoint', async (mode) => {
    const raw = 'data: {"choices":[\rdata: {"delta":{"thinking":{"content":"check"}},"finish_reason":null}]}\r\r'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\r';
    const source = new Response(raw, { headers: { 'Content-Type': 'text/event-stream' } });
    const output = mode === 'chat' ? await chat.transformResponseIn(source) : await responses.transformResponseIn(source, {});
    const wire = await output.text();
    expect(wire).toContain('check');
    if (mode === 'chat') {
      expect(wire).toContain('reasoning_content');
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
    } else expect(wire).toContain('response.completed');
  });

  it.each(['chat', 'responses-in', 'responses-out'])('cancels the upstream reader when the %s client disconnects', async (mode) => {
    let cancelled = false;
    const event = mode === 'responses-out' ? { type: 'response.output_text.delta', delta: 'hello' } : chunk({ content: 'hello' });
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    const output = mode === 'chat' ? await chat.transformResponseIn(source)
      : mode === 'responses-in' ? await responses.transformResponseIn(source, {})
      : await responses.transformResponseOut(source, {});
    const reader = output.body!.getReader();
    await reader.read();
    await reader.cancel('client disconnected');
    expect(cancelled).toBe(true);
  });
  it('recognizes a headerless Responses SSE prefix split across individual bytes', async () => {
    const source = sse([
      { type: 'response.output_text.delta', delta: 'hello' },
      { type: 'response.completed', response: { model: 'gpt-5' } },
    ], true);
    source.headers.delete('content-type');
    const wire = await events(await responses.transformResponseOut(source, {}));
    expect(wire[0].choices[0].delta).toMatchObject({ content: 'hello' });
  });
  it('sends explicit off instead of re-enabling the upstream reasoning default', async () => {
    const request: UnifiedChatRequest = {
      model: 'gpt-5.2', messages: [{ role: 'user', content: 'hello' }],
      reasoning: { effort: 'none', enabled: false },
    };
    const chatBody = await chat.transformRequestIn(request, provider, {});
    expect(chatBody.reasoning_effort).toBe('none');
    const responseBody = await responses.transformRequestIn(request, provider, {});
    expect(responseBody.body).toMatchObject({ reasoning: { effort: 'none' } });
  });
});
