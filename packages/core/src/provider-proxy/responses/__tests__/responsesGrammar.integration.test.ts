import { describe, expect, it } from 'vitest';

import { executeProviderCall } from '../../../pipeline/executeProviderCall';
import type { LLMProvider, Transformer } from '../../../transformer';
import { TransformerChainExecutor } from '../../../transformer/TransformerChainExecutor';
import { AnthropicTransformer } from '../../../transformer/transformers/AnthropicTransformer';
import { GeminiTransformer } from '../../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../../transformer/transformers/OpenAITransformer';
import { resolveReducedResponsesCapabilities, validateReducedResponsesRequest } from '../responsesProfile';

interface GrammarCase {
  name: string;
  format: { type: 'grammar'; syntax: 'lark' | 'regex'; definition: string };
  valid: string;
  invalid: string[];
}

const grammars: GrammarCase[] = [
  {
    name: 'recursive Lark',
    format: {
      type: 'grammar',
      syntax: 'lark',
      definition: String.raw`start: tree /[ \t\r\n]*/
?tree: "node" "(" tree ("," tree)* ")" | STRING
STRING: /"([^"\\]|\\.)*"/
%ignore /[ \t\r\n]+/
`,
    },
    valid: String.raw`node( "雪", node("line\n", "quote\"") )` + '\r\n',
    invalid: ['node("leaf", node("unclosed")', '"valid"INVALID_SUFFIX', 'INVALID_PREFIX"valid"'],
  },
  {
    name: 'regex',
    format: { type: 'grammar', syntax: 'regex', definition: String.raw`(?:MOVE|TURN) [A-Z][A-Z0-9_]*\r?\n` },
    valid: 'MOVE NORTH_2\r\n',
    invalid: ['MOVE', 'MOVE NORTH_2\r\nINVALID_SUFFIX', 'INVALID_PREFIXMOVE NORTH_2\r\n'],
  },
];

interface Target {
  name: string;
  transformer: Transformer;
  declarations(body: Record<string, unknown>): Array<Record<string, unknown>>;
}

const targets: Target[] = [
  {
    name: 'OpenAI Chat',
    transformer: new OpenAITransformer(),
    declarations: (body) => (body.tools as Array<{ function: Record<string, unknown> }>).map((tool) => tool.function),
  },
  {
    name: 'Anthropic',
    transformer: new AnthropicTransformer(),
    declarations: (body) => body.tools as Array<Record<string, unknown>>,
  },
  {
    name: 'Gemini',
    transformer: new GeminiTransformer(),
    declarations: (body) => (body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)
      .flatMap((tool) => tool.functionDeclarations),
  },
];

const provider: LLMProvider = {
  name: 'grammar-loopback', baseUrl: 'https://example.test/v1/', apiKey: 'test-key', models: ['mapped-model'],
};
// Reuse the real executor and transformer instances to expose cross-request state leaks.
const executor = new TransformerChainExecutor();
const endpointTransformer = new OpenAIResponseTransformer();
const placements = ['top-level', 'additional', 'namespaced additional'] as const;
type Placement = typeof placements[number];

function requestFor(format: unknown, placement: Placement): Record<string, unknown> {
  const tool = { type: 'custom', name: 'exec', description: 'Execute the declared language', ...(format === undefined ? {} : { format }) };
  const input: Array<Record<string, unknown>> = [{ type: 'message', role: 'user', content: 'Run the tool' }];
  if (placement === 'top-level') return { model: 'mapped-model', input, tools: [tool] };
  input.unshift({
    type: 'additional_tools', role: 'developer',
    tools: placement === 'additional' ? [tool] : [{ type: 'namespace', name: 'functions', tools: [tool] }],
  });
  return { model: 'mapped-model', input };
}

interface GeneratedCall { name: string; input: string }
interface ToolItem {
  type?: string;
  status?: string;
  name?: string;
  namespace?: string;
  call_id?: string;
  input?: string;
}
interface ClientEvent {
  type?: string;
  delta?: string;
  input?: string;
  item?: ToolItem;
  response?: { status?: string; output?: ToolItem[]; error?: { code?: string } };
  error?: { code?: string };
}

function upstreamJson(target: Target, calls: GeneratedCall[]): Record<string, unknown> {
  if (target.name === 'OpenAI Chat') return {
    id: 'chatcmpl-grammar', object: 'chat.completion', model: 'mapped-model', created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls.map((call, index) => ({
      id: `call_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify({ input: call.input }) },
    })) }, finish_reason: 'tool_calls' }],
  };
  if (target.name === 'Anthropic') return {
    id: 'msg_grammar', type: 'message', role: 'assistant', model: 'mapped-model',
    content: calls.map((call, index) => ({ type: 'tool_use', id: `call_${index}`, name: call.name, input: { input: call.input } })),
    stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
  };
  return {
    responseId: 'resp_grammar', modelVersion: 'mapped-model',
    candidates: [{ content: { role: 'model', parts: calls.map((call, index) => ({
      functionCall: { id: `call_${index}`, name: call.name, args: { input: call.input } },
    })) }, finishReason: 'STOP' }],
  };
}

function upstreamFrames(target: Target, calls: GeneratedCall[]): string[] {
  const frame = (body: Record<string, unknown>) => `${target.name === 'Anthropic' ? `event: ${body.type}\n` : ''}data: ${JSON.stringify(body)}\n\n`;
  if (target.name === 'Gemini') return [frame(upstreamJson(target, calls))];
  const frames: string[] = [];
  const chat = (delta: Record<string, unknown>, finishReason: string | null = null) => frame({
    id: 'chatcmpl-grammar', object: 'chat.completion.chunk', model: 'mapped-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  if (target.name === 'Anthropic') frames.push(frame({
    type: 'message_start', message: { id: 'msg_grammar', type: 'message', role: 'assistant', model: 'mapped-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
  }));
  for (const [index, call] of calls.entries()) {
    frames.push(target.name === 'OpenAI Chat'
      ? chat({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] })
      : frame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call_${index}`, name: call.name, input: {} } }));
    const argumentsJson = JSON.stringify({ input: call.input });
    // Split inside the JSON envelope and the escaped raw input, not only at token boundaries.
    for (let offset = 0; offset < argumentsJson.length; offset += 7) {
      const fragment = argumentsJson.slice(offset, offset + 7);
      frames.push(target.name === 'OpenAI Chat'
        ? chat({ tool_calls: [{ index, function: { arguments: fragment } }] })
        : frame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fragment } }));
    }
    if (target.name === 'Anthropic') frames.push(frame({ type: 'content_block_stop', index }));
  }
  if (target.name === 'OpenAI Chat') frames.push(chat({}, 'tool_calls'), 'data: [DONE]\n\n');
  else frames.push(
    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    frame({ type: 'message_stop' }),
  );
  return frames;
}

async function exchange(target: Target, request: Record<string, unknown>, calls: GeneratedCall[], stream: boolean) {
  const capabilities = resolveReducedResponsesCapabilities({ authMode: 'subscription', subscriptionTransformerNames: [target.transformer.name] });
  expect(validateReducedResponsesRequest(request, capabilities)).toEqual([]);
  let upstreamBody: Record<string, unknown> | undefined;
  let fetchCount = 0;
  let response: Response | undefined;
  let error: unknown;
  try {
    const result = await executeProviderCall({
      executor, request: { ...request, stream }, provider,
      chain: { providerTransformers: [target.transformer], modelTransformers: [] }, endpointTransformer,
      resolveUrl: () => 'https://example.test/upstream', buildHeaders: () => ({}),
      fetchFn: async (_url, _headers, body) => {
        fetchCount += 1;
        upstreamBody = body as Record<string, unknown>;
        if (!stream) return Response.json(upstreamJson(target, calls));
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of upstreamFrames(target, calls)) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      },
      runResponseChain: true, preserveEndpointRequestForResponseChain: true,
    });
    response = result.response;
  } catch (caught) { error = caught; }
  return { response, error, upstreamBody, fetchCount };
}

async function readEvents(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let error: unknown;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (caught) { error = caught; }
  const events = text.split('\n').filter((line) => line.startsWith('data:')).flatMap((line) => {
    const data = line.slice(5).trim();
    return data && data !== '[DONE]' ? [JSON.parse(data) as ClientEvent] : [];
  });
  return { events, error };
}

function expectNoRejectedInput(value: unknown, input: string): void {
  if (value instanceof Error) expectNoRejectedInput(value.message, input);
  if (typeof value === 'string') {
    expect(value).not.toContain(input);
    expect(value).not.toContain(JSON.stringify(input).slice(1, -1));
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) expectNoRejectedInput(nested, input);
  }
}

function expectedItem(input: string, placement: Placement) {
  return { type: 'custom_tool_call', name: 'exec', input, ...(placement === 'namespaced additional' ? { namespace: 'functions' } : {}) };
}

for (const target of targets) describe(`${target.name} grammar-constrained Responses tools`, () => {
  for (const grammar of grammars) for (const placement of placements) {
    it.each([false, true])(`${grammar.name}, ${placement}, stream=%s preserves declaration and exact input`, async (stream) => {
      const name = placement === 'namespaced additional' ? 'functions__exec' : 'exec';
      const result = await exchange(target, requestFor(grammar.format, placement), [{ name, input: grammar.valid }], stream);
      expect(result.fetchCount).toBe(1);
      expect(result.error).toBeUndefined();
      const declaration = target.declarations(result.upstreamBody!).find((tool) => tool.name === name)!;
      expect(declaration).toBeDefined();
      expect(declaration.description).toEqual(expect.stringContaining(grammar.format.definition));
      expect(declaration.description).toEqual(expect.stringContaining(grammar.format.syntax));
      const schema = (declaration.parameters ?? declaration.input_schema ?? declaration.parametersJsonSchema) as Record<string, unknown>;
      expect(schema).toMatchObject({ type: 'object', properties: { input: { type: 'string' } }, required: ['input'] });
      expect(result.response!.ok).toBe(true);
      if (!stream) {
        const body = await result.response!.json() as { output: ToolItem[] };
        expect(body.output.filter((item) => item.type === 'custom_tool_call')).toEqual([
          expect.objectContaining({ ...expectedItem(grammar.valid, placement), call_id: 'call_0' }),
        ]);
        return;
      }
      const { events, error } = await readEvents(result.response!);
      expect(error).toBeUndefined();
      const expected = { ...expectedItem(grammar.valid, placement), call_id: 'call_0' };
      expect(events.find((event) => event.type === 'response.output_item.done' && event.item?.type === 'custom_tool_call')?.item).toMatchObject(expected);
      expect(events.find((event) => event.type === 'response.completed')?.response?.output?.filter((item) => item.type === 'custom_tool_call')).toEqual([expect.objectContaining(expected)]);
      expect(events.filter((event) => event.type === 'response.custom_tool_call_input.delta').map((event) => event.delta).join('')).toBe(grammar.valid);
      expect(events.find((event) => event.type === 'response.custom_tool_call_input.done')?.input).toBe(grammar.valid);
      expect(events.some((event) => event.type === 'response.function_call_arguments.delta')).toBe(false);
    });
  }

  for (const grammar of grammars) it.each([false, true])(`${grammar.name}, stream=%s rejects malformed, prefix and suffix input without leaking it`, async (stream) => {
    for (const input of grammar.invalid) {
      const result = await exchange(target, requestFor(grammar.format, 'namespaced additional'), [{ name: 'functions__exec', input }], stream);
      // A request-side rejection must never masquerade as successful output enforcement.
      expect(result.fetchCount).toBe(1);
      if (result.error !== undefined) {
        expect(result.error).toMatchObject({ status: 502, code: 'invalid_upstream_tool_input' });
        expectNoRejectedInput(result.error, input);
        expectNoRejectedInput(result.error, grammar.format.definition);
        continue;
      }
      expect(result.response).toBeDefined();
      if (!stream) {
        const body = await result.response!.json() as { status?: string; output?: ToolItem[]; error?: { code?: string } };
        expectNoRejectedInput(body, input);
        expectNoRejectedInput(body, grammar.format.definition);
        expect((body.output ?? []).some((item) => item.type === 'custom_tool_call')).toBe(false);
        expect(result.response!.status).toBe(502);
        expect(body.error).toMatchObject({ code: 'invalid_upstream_tool_input' });
        continue;
      }
      const { events, error } = await readEvents(result.response!);
      expectNoRejectedInput(events, input);
      expectNoRejectedInput(error, input);
      expectNoRejectedInput(events, grammar.format.definition);
      expectNoRejectedInput(error, grammar.format.definition);
      expect(events.some((event) => event.type === 'response.completed')).toBe(false);
      expect(events.some((event) => event.type === 'response.custom_tool_call_input.delta' && event.delta)).toBe(false);
      expect(events.some((event) => event.type === 'response.custom_tool_call_input.done')).toBe(false);
      expect(events.some((event) => event.item?.type === 'custom_tool_call' && (event.item.input || event.item.status === 'completed'))).toBe(false);
      expect(events.some((event) => event.type === 'response.function_call_arguments.delta')).toBe(false);
      if (error !== undefined) expect(error).toMatchObject({ code: 'invalid_upstream_tool_input' });
      else {
        const failed = events.find((event) => event.type === 'response.failed' || event.type === 'error');
        expect(failed?.response?.error ?? failed?.error).toMatchObject({ code: 'invalid_upstream_tool_input' });
      }
    }
  });

  it.each([false, true])('stream=%s scopes grammars to the declared tool and request, preserving unconstrained tools', async (stream) => {
    const grammar = grammars[1];
    const request = requestFor(grammar.format, 'namespaced additional');
    const additional = (request.input as Array<Record<string, unknown>>)[0];
    (additional.tools as unknown[]).push({ type: 'namespace', name: 'other', tools: [{ type: 'custom', name: 'exec' }] });
    request.tools = [{ type: 'custom', name: 'plain', format: { type: 'text' } }];
    const calls = [
      { name: 'functions__exec', input: grammar.valid },
      { name: 'functions__exec', input: 'TURN LEFT\r\n' },
      { name: 'other__exec', input: 'not in the constrained language\n雪' },
      { name: 'plain', input: 'arbitrary "raw" input\r\n' },
    ];
    const first = await exchange(target, request, calls, stream);
    expect(first.fetchCount).toBe(1);
    expect(first.error).toBeUndefined();
    const firstOutput = stream
      ? (await readEvents(first.response!)).events.find((event) => event.type === 'response.completed')?.response?.output
      : (await first.response!.json() as { output: ToolItem[] }).output;
    const customOutput = firstOutput?.filter((item) => item.type === 'custom_tool_call');
    expect(customOutput).toHaveLength(calls.length);
    for (const [index, call] of calls.entries()) expect(customOutput![index]).toMatchObject({
      type: 'custom_tool_call', call_id: `call_${index}`, name: call.name.split('__').at(-1), input: call.input,
      ...(call.name.includes('__') ? { namespace: call.name.split('__')[0] } : {}),
    });
    for (const format of [undefined, { type: 'grammar', syntax: 'regex', definition: 'different language' }]) {
      const input = format ? 'different language' : 'unconstrained second request';
      const nextRequest = requestFor(format, 'namespaced additional');
      // Executed history obeyed the previous turn's language, not this turn's declaration.
      (nextRequest.input as Array<Record<string, unknown>>).push(
        { type: 'custom_tool_call', call_id: 'call_history', name: 'exec', namespace: 'functions', input: grammar.valid },
        { type: 'custom_tool_call_output', call_id: 'call_history', output: 'already executed' },
        { type: 'message', role: 'user', content: 'Now use the current declaration' },
      );
      const next = await exchange(target, nextRequest, [{ name: 'functions__exec', input }], stream);
      expect(next.fetchCount).toBe(1);
      expect(next.error).toBeUndefined();
      expect(JSON.stringify(next.upstreamBody)).toContain('call_history');
      const output = stream
        ? (await readEvents(next.response!)).events.find((event) => event.type === 'response.completed')?.response?.output
        : (await next.response!.json() as { output: ToolItem[] }).output;
      expect(output?.filter((item) => item.type === 'custom_tool_call')).toEqual([
        expect.objectContaining({ ...expectedItem(input, 'namespaced additional'), call_id: 'call_0' }),
      ]);
    }
  });

  for (const choice of ['custom', 'allowed_tools'] as const) {
    it.each([false, true])(`${choice} choice, stream=%s selects the namespaced grammar tool by its bare name`, async (stream) => {
      const grammar = grammars[1];
      const request = requestFor(grammar.format, 'namespaced additional');
      request.tools = [{
        type: 'custom', name: 'nonselected',
        format: { type: 'grammar', syntax: 'regex', definition: 'OTHER_LANGUAGE_ONLY' },
      }];
      request.tool_choice = choice === 'custom'
        ? { type: 'custom', name: 'exec' }
        : { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', name: 'exec' }] };
      const result = await exchange(target, request, [{ name: 'functions__exec', input: grammar.valid }], stream);
      expect(result.fetchCount).toBe(1);
      expect(result.error).toBeUndefined();
      const body = result.upstreamBody!;
      const declarations = target.declarations(body);
      const selected = declarations.find((tool) => tool.name === 'functions__exec');
      expect(selected?.description).toEqual(expect.stringContaining(grammar.format.definition));
      if (choice === 'allowed_tools') expect(declarations.map((tool) => tool.name)).toEqual(['functions__exec']);
      else expect(declarations.map((tool) => tool.name)).toEqual(expect.arrayContaining(['functions__exec', 'nonselected']));
      if (target.name === 'OpenAI Chat') {
        expect(body.tool_choice).toEqual(choice === 'custom'
          ? { type: 'function', function: { name: 'functions__exec' } }
          : 'required');
      } else if (target.name === 'Anthropic') {
        expect(body.tool_choice).toMatchObject(choice === 'custom'
          ? { type: 'tool', name: 'functions__exec' }
          : { type: 'any' });
      } else {
        expect(body.toolConfig).toMatchObject({
          functionCallingConfig: {
            mode: 'ANY',
            ...(choice === 'custom' ? { allowedFunctionNames: ['functions__exec'] } : {}),
          },
        });
      }
      expect(result.response!.ok).toBe(true);
      let output: ToolItem[] | undefined;
      if (stream) {
        const { events, error } = await readEvents(result.response!);
        expect(error).toBeUndefined();
        output = events.find((event) => event.type === 'response.completed')?.response?.output;
      } else output = (await result.response!.json() as { output: ToolItem[] }).output;
      expect(output?.filter((item) => item.type === 'custom_tool_call')).toEqual([
        expect.objectContaining({ ...expectedItem(grammar.valid, 'namespaced additional'), call_id: 'call_0' }),
      ]);
      const rejected = await exchange(target, request, [{ name: 'functions__exec', input: 'OTHER_LANGUAGE_ONLY' }], stream);
      expect(rejected.fetchCount).toBe(1);
      if (rejected.error !== undefined) {
        expect(rejected.error).toMatchObject({ status: 502, code: 'invalid_upstream_tool_input' });
        expectNoRejectedInput(rejected.error, 'OTHER_LANGUAGE_ONLY');
      } else if (stream) {
        const { events, error } = await readEvents(rejected.response!);
        expect(error).toBeUndefined();
        expectNoRejectedInput(events, 'OTHER_LANGUAGE_ONLY');
        expect(events.find((event) => event.type === 'response.failed')?.response?.error).toMatchObject({
          code: 'invalid_upstream_tool_input',
        });
        expect(events.some((event) => event.type === 'response.completed')).toBe(false);
        expect(events.some((event) => event.type === 'response.custom_tool_call_input.delta' && event.delta)).toBe(false);
      } else {
        expect(rejected.response!.status).toBe(502);
        const failureBody = await rejected.response!.json() as unknown;
        expectNoRejectedInput(failureBody, 'OTHER_LANGUAGE_ONLY');
        expect(failureBody).toMatchObject({ error: { code: 'invalid_upstream_tool_input' } });
      }
    });
  }

  it.each([
    { type: 'grammar', syntax: 'lark', definition: 'start: (' },
    { type: 'grammar', syntax: 'regex', definition: '(' },
  ])('rejects an uncompileable $syntax declaration before any upstream request', async (format) => {
    for (const placement of placements) {
      const result = await exchange(target, requestFor(format, placement), [{ name: 'exec', input: 'unused' }], false);
      expect(result.fetchCount).toBe(0);
      expect(result.upstreamBody).toBeUndefined();
      expect(result.response).toBeUndefined();
      expect(result.error).toMatchObject({ status: 400 });
    }
  });

  it('rejects malformed or unknown format declarations at admission', () => {
    const capabilities = resolveReducedResponsesCapabilities({ authMode: 'subscription', subscriptionTransformerNames: [target.transformer.name] });
    const malformed = [null, 'regex', {}, { type: 'unknown' }, { type: 'grammar', syntax: 'unknown', definition: 'x' },
      { type: 'grammar', syntax: 'regex' }, { type: 'grammar', syntax: 'lark', definition: 42 }];
    for (const placement of placements) for (const format of malformed) {
      expect(() => validateReducedResponsesRequest(requestFor(format, placement), capabilities)).toThrow();
    }
  });

  it('continues rejecting hosted and unrecognized forced or allowlisted choices', () => {
    const capabilities = resolveReducedResponsesCapabilities({ authMode: 'subscription', subscriptionTransformerNames: [target.transformer.name] });
    for (const type of ['web_search', 'unrecognized_choice']) {
      for (const tool_choice of [
        { type, name: 'exec' },
        { type: 'allowed_tools', mode: 'required', tools: [{ type, name: 'exec' }] },
      ]) {
        const request = { ...requestFor(grammars[1].format, 'namespaced additional'), tool_choice };
        expect(() => validateReducedResponsesRequest(request, capabilities)).toThrow(
          expect.objectContaining({ status: 400, code: 'unsupported_capability' }),
        );
      }
    }
  });
});

it('native provider encoding preserves already-executed history when the current grammar has changed', async () => {
  const format = { type: 'grammar', syntax: 'regex', definition: 'NEW_LANGUAGE' };
  const request = requestFor(format, 'top-level');
  (request.input as Array<Record<string, unknown>>).push(
    { type: 'custom_tool_call', call_id: 'call_old_language', name: 'exec', input: 'OLD_LANGUAGE' },
    { type: 'custom_tool_call_output', call_id: 'call_old_language', output: 'already executed' },
    { type: 'message', role: 'user', content: 'Use the new language from now on' },
  );
  const context = { providerName: 'grammar-history-loopback' };
  const unified = await endpointTransformer.transformRequestOut(request, context);
  const encoded = await endpointTransformer.transformRequestIn(unified, provider, context);
  const body = encoded.body as { input: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> };
  expect(body.input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'custom_tool_call', call_id: 'call_old_language', name: 'exec', input: 'OLD_LANGUAGE' }),
    expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'call_old_language', output: 'already executed' }),
  ]));
  expect(body.tools).toEqual([expect.objectContaining({ type: 'custom', name: 'exec', format })]);
});
