import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderProxy } from '../ProviderProxy';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { aggregateAnthropicSseToJsonBody, aggregateGeminiSseToJsonBody, aggregateOpenAIChatChunksToJsonBody, aggregateResponsesSseToJsonBody } from '../ingress/providerProxyShared';
import type { ProviderConfigSource } from '../../ports';
import type { Transformer } from '../../transformer/types';
import type { RouteContext } from '../types';

type Wire = Record<string, unknown>;
function object(value: unknown): Wire {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Wire;
}
function list(value: unknown): Wire[] {
  assert.ok(Array.isArray(value));
  return value.map(object);
}
function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}
const json = (value: unknown): Wire => object(JSON.parse(text(value)));
export const MATRIX_FORMATS = ['chat', 'anthropic', 'responses', 'gemini'] as const;
export type MatrixFormat = typeof MATRIX_FORMATS[number];
const MODELS: Record<MatrixFormat, string> = { chat: 'deepseek-flash', anthropic: 'claude-sonnet-4-5', responses: 'gpt-5', gemini: 'gemini-2.5-flash' };
const THOUGHT = 'Inspect both directories before answering.';
const ANSWER = 'Completed: a.txt and b.txt.';
const CALLS = [
  { id: 'call_alpha', name: 'lookup', arguments: '{"directory":"alpha"}' },
  { id: 'call_beta', name: 'lookup', arguments: '{"directory":"beta"}' },
];
const SCHEMA = { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] };
const fn = { name: 'lookup', description: 'List a directory', parameters: SCHEMA };
const chatTools = CALLS.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
function wireResponse(format: MatrixFormat, final: boolean): Wire {
  const model = MODELS[format];
  if (format === 'chat') return { id: 'chatcmpl_matrix', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: final ? ANSWER : null, reasoning_content: THOUGHT, ...(!final ? { tool_calls: chatTools } : {}) }, finish_reason: final ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } } };
  if (format === 'anthropic') return { id: 'msg_matrix', type: 'message', role: 'assistant', model, content: [{ type: 'thinking', thinking: THOUGHT }, ...(final ? [{ type: 'text', text: ANSWER }] : CALLS.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: json(call.arguments) })))], stop_reason: final ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 30 } };
  if (format === 'responses') return { id: 'resp_matrix', object: 'response', model, status: 'completed', output: [{ id: 'rs_matrix', type: 'reasoning', summary: [{ type: 'summary_text', text: THOUGHT }] }, ...(final ? [{ id: 'msg_matrix', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ANSWER, annotations: [] }] }] : CALLS.map(call => ({ id: `fc_${call.id}`, type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' })))], usage: { input_tokens: 20, output_tokens: 30, total_tokens: 50, output_tokens_details: { reasoning_tokens: 10 } } };
  return { responseId: 'gemini_matrix', modelVersion: model, candidates: [{ index: 0, content: { role: 'model', parts: [{ text: THOUGHT, thought: true }, ...(final ? [{ text: ANSWER }] : CALLS.map(call => ({ functionCall: { id: call.id, name: call.name, args: json(call.arguments) } })))] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 50 } };
}
function streamResponse(format: MatrixFormat, final: boolean): string {
  const value = wireResponse(format, final);
  const events: Wire[] = [];
  if (format === 'chat') {
    const chunk = (delta: Wire, finish_reason: string | null = null): Wire => ({ id: value.id, object: 'chat.completion.chunk', created: 1, model: value.model, choices: [{ index: 0, delta, finish_reason }] });
    events.push(chunk({ role: 'assistant', reasoning_content: THOUGHT }));
    events.push(chunk(final ? { content: ANSWER } : { tool_calls: chatTools.map((call, index) => ({ index, ...call })) }));
    events.push({ ...chunk({}, final ? 'stop' : 'tool_calls'), usage: value.usage });
  } else if (format === 'anthropic') {
    events.push({ type: 'message_start', message: { ...value, content: [], stop_reason: null } });
    list(value.content).forEach((block, index) => {
      events.push({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, [block.type === 'thinking' ? 'thinking' : 'text']: '' } });
      events.push({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'text_delta', text: block.text } });
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: value.stop_reason, stop_sequence: null }, usage: value.usage }, { type: 'message_stop' });
  } else if (format === 'responses') {
    events.push({ type: 'response.created', response: { ...value, status: 'in_progress', output: [] } });
    list(value.output).forEach((item, output_index) => {
      events.push({ type: 'response.output_item.added', output_index, item: item.type === 'reasoning' ? { ...item, summary: [] } : item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } });
      if (item.type === 'reasoning') {
        events.push({ type: 'response.reasoning_summary_part.added', item_id: item.id, output_index, summary_index: 0, part: { type: 'summary_text', text: '' } }, { type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index, summary_index: 0, delta: THOUGHT }, { type: 'response.reasoning_summary_text.done', item_id: item.id, output_index, summary_index: 0, text: THOUGHT }, { type: 'response.reasoning_summary_part.done', item_id: item.id, output_index, summary_index: 0, part: list(item.summary)[0] });
      } else if (item.type === 'function_call') {
        events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments }, { type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
      } else {
        events.push({ type: 'response.content_part.added', item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: ANSWER }, { type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: ANSWER }, { type: 'response.content_part.done', item_id: item.id, output_index, content_index: 0, part: list(item.content)[0] });
      }
      events.push({ type: 'response.output_item.done', output_index, item });
    });
    events.push({ type: 'response.completed', response: value });
  } else {
    const candidate = list(value.candidates)[0];
    const parts = list(object(candidate.content).parts);
    events.push({ ...value, candidates: [{ index: 0, content: { role: 'model', parts: parts.slice(0, 1) } }], usageMetadata: undefined });
    events.push({ ...value, candidates: [{ ...candidate, content: { role: 'model', parts: parts.slice(1) } }] });
  }
  return events.map(event => `${event.type ? `event: ${String(event.type)}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (format === 'chat' ? 'data: [DONE]\n\n' : '');
}
function initialRequest(format: MatrixFormat, stream: boolean): Wire {
  const common = { model: 'client-model', stream };
  if (format === 'chat') return { ...common, max_tokens: 4096, reasoning_effort: 'high', messages: [{ role: 'user', content: 'List alpha and beta.' }], tools: [{ type: 'function', function: fn }] };
  if (format === 'anthropic') return { ...common, max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'List alpha and beta.' }], tools: [{ name: fn.name, description: fn.description, input_schema: SCHEMA }] };
  if (format === 'responses') return { ...common, max_output_tokens: 4096, reasoning: { effort: 'high' }, input: [{ role: 'user', content: [{ type: 'input_text', text: 'List alpha and beta.' }] }], tools: [{ type: 'function', ...fn }] };
  return { contents: [{ role: 'user', parts: [{ text: 'List alpha and beta.' }] }], generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } }, tools: [{ functionDeclarations: [fn] }] };
}
function followUp(format: MatrixFormat, first: Wire, original: Wire): Wire {
  const body = structuredClone(original);
  if (format === 'chat') {
    const message = object(list(first.choices)[0].message);
    assert.equal(message.reasoning_content, THOUGHT);
    const calls = list(message.tool_calls);
    assert.deepEqual(calls.map(call => json(object(call.function).arguments)), [{ directory: 'alpha' }, { directory: 'beta' }]);
    body.messages = [...list(body.messages), message, ...calls.map((call, index) => ({ role: 'tool', tool_call_id: call.id, content: index ? 'b.txt' : 'a.txt' }))];
  } else if (format === 'anthropic') {
    const content = list(first.content);
    assert.equal(content.filter(part => part.type === 'thinking').map(part => part.thinking).join(''), THOUGHT);
    const calls = content.filter(part => part.type === 'tool_use');
    assert.deepEqual(calls.map(call => call.input), [{ directory: 'alpha' }, { directory: 'beta' }]);
    body.messages = [...list(body.messages), { role: 'assistant', content }, { role: 'user', content: calls.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, content: index ? 'b.txt' : 'a.txt' })) }];
  } else if (format === 'responses') {
    const output = list(first.output);
    assert.equal(output.filter(item => item.type === 'reasoning').flatMap(item => list(item.summary ?? [])).map(part => part.text).join(''), THOUGHT);
    const calls = output.filter(item => item.type === 'function_call');
    assert.deepEqual(calls.map(call => json(call.arguments)), [{ directory: 'alpha' }, { directory: 'beta' }]);
    body.input = [...list(body.input), ...output, ...calls.map((call, index) => ({ type: 'function_call_output', call_id: call.call_id, output: index ? 'b.txt' : 'a.txt' }))];
  } else {
    const content = object(list(first.candidates)[0].content);
    const parts = list(content.parts);
    assert.equal(parts.filter(part => part.thought).map(part => part.text ?? '').join(''), THOUGHT);
    const calls = parts.filter(part => part.functionCall).map(part => object(part.functionCall));
    assert.deepEqual(calls.map(call => call.args), [{ directory: 'alpha' }, { directory: 'beta' }]);
    body.contents = [...list(body.contents), content, { role: 'user', parts: calls.map((call, index) => ({ functionResponse: { id: call.id, name: call.name, response: { result: index ? 'b.txt' : 'a.txt' } } })) }];
  }
  return body;
}
function validateUpstream(format: MatrixFormat, body: Wire, model: string): boolean {
  assert.equal(body.model ?? model, model);
  if (format === 'chat') {
    const messages = list(body.messages);
    const results = messages.filter(message => message.role === 'tool');
    if (!results.length) return false;
    const assistant = object(messages.find(message => message.role === 'assistant'));
    assert.equal(assistant.reasoning_content, THOUGHT);
    assert.deepEqual(results.map(message => message.tool_call_id), list(assistant.tool_calls).map(call => call.id));
    assert.deepEqual(results.map(message => message.content), ['a.txt', 'b.txt']);
  } else if (format === 'anthropic') {
    const messages = list(body.messages);
    const results = messages.flatMap(message => Array.isArray(message.content) ? list(message.content) : []).filter(part => part.type === 'tool_result');
    if (!results.length) return false;
    const assistant = object(messages.find(message => message.role === 'assistant'));
    const content = list(assistant.content);
    assert.equal(content.filter(part => part.type === 'thinking').map(part => part.thinking).join(''), THOUGHT);
    assert.deepEqual(results.map(part => part.tool_use_id), content.filter(part => part.type === 'tool_use').map(part => part.id));
  } else if (format === 'responses') {
    const input = list(body.input);
    const results = input.filter(item => item.type === 'function_call_output');
    if (!results.length) return false;
    assert.deepEqual(results.map(item => item.call_id), input.filter(item => item.type === 'function_call').map(item => item.call_id));
    assert.deepEqual(results.map(item => item.output), ['a.txt', 'b.txt']);
  } else {
    assert.equal('model' in body, false);
    assert.equal('stream' in body, false);
    const parts = list(body.contents).flatMap(content => list(content.parts));
    const results = parts.filter(part => part.functionResponse);
    if (!results.length) return false;
    const calls = parts.filter(part => part.functionCall);
    assert.equal(calls.length, 2);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(part => object(part.functionResponse).name), ['lookup', 'lookup']);
  }
  return true;
}

export async function runConversionMatrixCase(
  ingress: MatrixFormat,
  target: MatrixFormat,
  stream: boolean,
  selection?: { model: string; wireModel: string },
): Promise<void> {
  const configuredModel = selection?.model ?? MODELS[target];
  const wireModel = selection?.wireModel ?? MODELS[target];
  let upstreamCalls = 0;
  const errors: Error[] = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        upstreamCalls++;
        const body = json(raw);
        const expectedPath = target === 'chat' ? '/chat/completions' : target === 'anthropic' ? '/messages' : target === 'responses' ? '/responses' : /:streamGenerateContent|:generateContent/;
        assert.ok(typeof expectedPath === 'string' ? req.url?.endsWith(expectedPath) : expectedPath.test(req.url ?? ''), `wrong upstream URL ${req.url}`);
        if (target === 'gemini') assert.ok(req.url?.includes(`/models/${wireModel}:`), `wrong model URL ${req.url}`);
        const final = validateUpstream(target, body, wireModel);
        const streaming = target === 'gemini' ? req.url?.includes(':streamGenerateContent') : body.stream === true;
        res.setHeader('Content-Type', streaming ? 'text/event-stream' : 'application/json');
        const output = streaming ? streamResponse(target, final) : JSON.stringify(wireResponse(target, final));
        const bytes = Buffer.from(output);
        for (let i = 0; i < bytes.length; i += 17) res.write(bytes.subarray(i, i + 17));
        res.end();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const transforms: Record<MatrixFormat, Transformer> = { chat: new OpenAITransformer(), anthropic: new AnthropicTransformer(), responses: new OpenAIResponseTransformer(), gemini: new GeminiTransformer() };
  const formats: Record<MatrixFormat, string> = { chat: 'openai', anthropic: 'anthropic', responses: 'openai-response', gemini: 'google' };
  const provider = { id: target, name: target === 'chat' ? 'deepseek' : target, apiFormat: formats[target], api_base_url: `${base}${target === 'gemini' ? '/v1beta/models/' : '/v1'}`, api_key: 'local-matrix-only', models: [configuredModel], enabled: true };
  // Only the config port is replaced; all transformers, HTTP dispatch and relay are real.
  const llmConfig = {
    getProvider: async () => provider,
    resolveTransformerChain: async (_providerId: string, model: string) => {
      assert.equal(model, configuredModel, 'model transformer lookup retains the selected configuration key');
      return { providerTransformers: [], modelTransformers: [] };
    },
    getMainTransformer: async () => transforms[target],
    getTransformerService: () => ({ getTransformer: (name: string) => Object.values(transforms).find(value => value.name === name) }),
  } as unknown as ProviderConfigSource;
  const proxy = new ProviderProxy({ llmConfig });
  try {
    const port = await proxy.start();
    const ingressFormats: Record<MatrixFormat, RouteContext['ingressFormat']> = { anthropic: 'anthropic-messages', chat: 'openai-chat', responses: 'openai-responses', gemini: 'gemini-generatecontent' };
    const token = proxy.addRoute({ sessionId: `matrix-${ingress}-${target}-${stream}`, targetProviderFormat: 'transform', ingressFormat: ingressFormats[ingress], authMode: 'byo', providerId: target, model: configuredModel });
    const path = ingress === 'chat' ? '/v1/chat/completions' : ingress === 'anthropic' ? '/v1/messages' : ingress === 'responses' ? '/v1/responses' : `/v1beta/models/client-model:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const request = async (body: Wire): Promise<Wire> => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
      if (response.status !== 200) throw new Error(`${ingress}->${target} stream=${stream}: ${response.status} ${await response.text()}`);
      if (!stream) { assert.match(response.headers.get('content-type') ?? '', /application\/json/); return object(await response.json()); }
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const aggregate = ingress === 'chat' ? aggregateOpenAIChatChunksToJsonBody : ingress === 'anthropic' ? aggregateAnthropicSseToJsonBody : ingress === 'responses' ? aggregateResponsesSseToJsonBody : aggregateGeminiSseToJsonBody;
      const value = await aggregate(response);
      assert.notEqual(value, null, 'client stream must have a terminal result');
      return json(value);
    };
    const original = initialRequest(ingress, stream);
    const first = await request(original);
    const last = await request(followUp(ingress, first, original));
    const answer = ingress === 'chat' ? object(list(last.choices)[0].message).content : ingress === 'anthropic' ? list(last.content).filter(part => part.type === 'text').map(part => part.text).join('') : ingress === 'responses' ? list(last.output).filter(item => item.type === 'message').flatMap(item => list(item.content)).filter(part => part.type === 'output_text').map(part => part.text).join('') : list(object(list(last.candidates)[0].content).parts).filter(part => !part.thought).map(part => part.text ?? '').join('');
    assert.equal(answer, ANSWER);
    assert.equal(upstreamCalls, 2);
    assert.deepEqual(errors, []);
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}
