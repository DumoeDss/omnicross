/**
 * OpenAIResponseTransformer — ENDPOINT direction round-trip tests
 *
 * Gate for the `codex-responses-ingress` change (tasks.md Section 2).
 *
 * The Codex CLI ingress uses `OpenAIResponseTransformer` as the
 * `endpointTransformer`. Its endpoint direction is:
 *   - `transformRequestOut`  : Responses-API `/v1/responses` body → UnifiedChatRequest
 *                              (DECODE inbound from the Codex CLI client)
 *   - `transformResponseIn`  : Unified / OpenAI-CC response → Responses-API
 *                              (ENCODE the core's response back to the client, incl. SSE)
 *   - `transformResponseOut` : Responses-API → OpenAI-CC (reverse SSE path)
 *
 * Today this endpoint direction is un-exercised (the transformer ships only as a
 * PROVIDER transformer in the Codex subscription chain), so these tests probe it
 * for latent fidelity bugs. Any genuine fidelity gap is annotated with a comment
 * referencing the section number and surfaced in the test name, NOT silently
 * worked around.
 *
 * @module transformer/__tests__/OpenAIResponseTransformer.endpoint.test
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import type { TransformerContext, UnifiedChatRequest } from '../types';

const mockContext: TransformerContext = {
  providerName: 'codex-ingress',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a non-streaming JSON Response (the core's OpenAI-CC reply). */
function ccJsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a text/event-stream Response from a list of raw SSE frame strings. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Drain an SSE Response body into the parsed `data:` JSON events. */
async function drainSseEvents(response: Response): Promise<unknown[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: unknown[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]' || data === '') continue;
    events.push(JSON.parse(data));
  }
  return events;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OpenAIResponseTransformer — endpoint direction', () => {
  let transformer: OpenAIResponseTransformer;

  beforeEach(() => {
    transformer = new OpenAIResponseTransformer();
  });

  // =========================================================================
  // 2.1 Plain text round-trip
  // =========================================================================
  describe('2.1 plain text', () => {
    it('transformRequestOut: Responses body → UnifiedChatRequest', async () => {
      const responsesBody = {
        model: 'gpt-5-codex',
        instructions: 'You are a helpful coding assistant.',
        input: [
          { role: 'developer', content: 'You operate in a sandbox.' },
          { role: 'user', content: 'Say hello.' },
        ],
        max_output_tokens: 256,
        temperature: 0.4,
        stream: false,
      };

      const unified = await transformer.transformRequestOut(responsesBody, mockContext);

      expect(unified.model).toBe('gpt-5-codex');
      expect(unified.max_tokens).toBe(256);
      expect(unified.temperature).toBe(0.4);
      expect(unified.stream).toBe(false);

      // `instructions` (the public Responses API's system prompt) leads, then
      // developer → system, user → user. `instructions` used to be dropped,
      // silently losing the caller's whole system prompt.
      expect(unified.messages).toEqual([
        { role: 'system', content: 'You are a helpful coding assistant.' },
        { role: 'system', content: 'You operate in a sandbox.' },
        { role: 'user', content: 'Say hello.' },
      ]);
    });

    it('transformResponseIn: OpenAI-CC JSON → valid Responses-API JSON', async () => {
      const ccResponse = ccJsonResponse({
        id: 'chatcmpl-abc',
        object: 'chat.completion',
        model: 'gpt-5-codex',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });

      const out = await transformer.transformResponseIn(ccResponse, mockContext);
      expect(out.headers.get('Content-Type')).toContain('application/json');
      const json = (await out.json()) as Record<string, any>;

      expect(json.object).toBe('response');
      expect(json.status).toBe('completed');
      expect(json.model).toBe('gpt-5-codex');
      expect(Array.isArray(json.output)).toBe(true);

      const message = json.output.find((o: any) => o.type === 'message');
      expect(message).toBeDefined();
      expect(message.role).toBe('assistant');
      expect(message.content).toEqual([{ type: 'output_text', text: 'Hello there!' }]);

      // usage mapped CC → Responses
      expect(json.usage).toEqual({
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      });
    });

    it('round-trips a plain-text exchange (decode request, encode reply)', async () => {
      // Decode an inbound Responses request the way the ingress would.
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [{ role: 'user', content: 'What is 2+2?' }],
        },
        mockContext
      );
      expect(unified.messages[0]).toEqual({ role: 'user', content: 'What is 2+2?' });

      // The core answers in OpenAI-CC; encode it back to Responses for the client.
      const out = await transformer.transformResponseIn(
        ccJsonResponse({
          model: unified.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' },
          ],
        }),
        mockContext
      );
      const json = (await out.json()) as Record<string, any>;
      const message = json.output.find((o: any) => o.type === 'message');
      expect(message.content[0].text).toBe('4');
    });
  });

  // =========================================================================
  // 2.2 Tool round-trips
  // =========================================================================
  describe('2.2 tools', () => {
    it('transformRequestOut: function_call_output → tool message with call_id', async () => {
      const responsesBody = {
        model: 'gpt-5-codex',
        input: [
          { role: 'user', content: 'Read the file.' },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_abc',
            name: 'read_file',
            arguments: '{"path":"/tmp/a.txt"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_abc',
            output: 'file contents here',
          },
        ],
      };

      const unified = await transformer.transformRequestOut(responsesBody, mockContext);

      // The tool RESULT must survive as a `tool` message carrying its call_id.
      const toolMsg = unified.messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toBe('file contents here');
      expect(toolMsg!.tool_call_id).toBe('call_abc');

      // FIDELITY (2.2, gap closed): the inbound assistant `function_call` REQUEST
      // item (the tool *call*, name='read_file', args, call_id='call_abc') is now
      // decoded into an assistant message carrying a matching tool_call. This keeps
      // the tool_call/tool_result pairing intact across a multi-turn Codex
      // conversation (Codex resends full history each turn).
      const assistantWithToolCall = unified.messages.find(
        (m) => m.role === 'assistant' && m.tool_calls?.length
      );
      expect(
        assistantWithToolCall,
        'function_call request item must decode to an assistant tool_call'
      ).toBeDefined();
      expect(assistantWithToolCall!.tool_calls).toEqual([
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
        },
      ]);
    });

    it('FIDELITY 2.2: inbound function_call item decodes to an assistant tool_call', async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_abc',
              name: 'read_file',
              arguments: '{"path":"/tmp/a.txt"}',
            },
          ],
        },
        mockContext
      );

      // A faithful ingress decode produces an assistant message carrying a tool_call
      // with the same call_id / name / arguments, so the core sees a well-formed
      // tool turn. (call_id is preferred over id, matching the encode in
      // transformRequestIn which sets call_id = tc.id.)
      expect(unified.messages).toEqual([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
            },
          ],
        },
      ]);
    });

    it('round-trips an assistant tool-call turn: unified → Responses → unified', async () => {
      // Build an assistant turn carrying tool_calls in unified (OpenAI-CC) form.
      const original: UnifiedChatRequest = {
        model: 'gpt-5-codex',
        messages: [
          { role: 'user', content: 'Read the file.' },
          {
            role: 'assistant',
            content: 'Let me read it.',
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
              },
            ],
          },
        ],
      };

      // ENCODE: unified → Responses items (PROVIDER-encode direction).
      const encoded = await transformer.transformRequestIn(
        original,
        { name: 'codex', baseUrl: 'https://api.openai.com', apiKey: 'k', models: [] },
        mockContext
      );
      const body = (encoded as Record<string, any>).body ?? encoded;
      // The assistant turn is emitted as a text item + a function_call item.
      const fcItem = (body.input as Array<Record<string, any>>).find(
        (i) => i.type === 'function_call'
      );
      expect(fcItem).toBeDefined();
      expect(fcItem!.name).toBe('read_file');

      // DECODE: Responses items → unified (ENDPOINT-decode direction).
      const decoded = await transformer.transformRequestOut(body, mockContext);

      const assistant = decoded.messages.find(
        (m) => m.role === 'assistant' && m.tool_calls?.length
      );
      expect(assistant, 'assistant tool-call turn must survive the round-trip').toBeDefined();
      expect(assistant!.tool_calls).toEqual([
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' },
        },
      ]);
    });

    it('transformResponseIn: CC tool_calls → Responses function_call output items', async () => {
      const ccResponse = ccJsonResponse({
        model: 'gpt-5-codex',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_xyz',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"/tmp/b.txt","data":"hi"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });

      const out = await transformer.transformResponseIn(ccResponse, mockContext);
      const json = (await out.json()) as Record<string, any>;

      const fc = json.output.find((o: any) => o.type === 'function_call');
      expect(fc, 'function_call output item must be present').toBeDefined();
      expect(fc.call_id).toBe('call_xyz');
      expect(fc.name).toBe('write_file');
      expect(fc.arguments).toBe('{"path":"/tmp/b.txt","data":"hi"}');
    });

    it('transformRequestOut: decodes function tools definitions', async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [{ role: 'user', content: 'go' }],
          tools: [
            {
              type: 'function',
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
        },
        mockContext
      );

      expect(unified.tools).toHaveLength(1);
      expect(unified.tools![0].function.name).toBe('read_file');
      expect(unified.tools![0].function.description).toBe('Read a file');
      expect(unified.tools![0].function.parameters).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } },
      });
    });
  });

  // =========================================================================
  // 2.5 Codex history decode — the shapes a RESUMED session replays
  //
  // Codex resends its whole history every turn (`store:false`). A resumed
  // session therefore replays item shapes a fresh session never produces, and
  // each one below used to corrupt or break the outbound OpenAI-chat request.
  // The fixtures are trimmed from a real rollout that reproduced the bug.
  // =========================================================================
  describe('2.5 codex history decode', () => {
    it('function_call_output with ARRAY output flattens to text (not a parts array)', async () => {
      // codex splits a multi-segment tool result into several `input_text`
      // parts. Relaying that array verbatim as an OpenAI-chat `content` made
      // upstreams 400 (`messages[N].content[0].type type error`).
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: [
                { type: 'input_text', text: 'Script completed' },
                { type: 'input_text', text: 'Exit code: 0' },
              ],
            },
          ],
        },
        mockContext
      );

      const toolMsg = unified.messages.find((m) => m.role === 'tool')!;
      expect(typeof toolMsg.content, 'tool content must be a plain string').toBe('string');
      expect(toolMsg.content).toBe('Script completed\nExit code: 0');
      expect(toolMsg.tool_call_id).toBe('call_1');
    });

    it('message content parts flatten to text instead of being JSON.stringify-d', async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
          ],
        },
        mockContext
      );

      expect(unified.messages).toEqual([
        { role: 'system', content: 'You are Codex.' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: 'Hi!' },
      ]);
    });

    it('drops provider-internal item types instead of emitting junk messages', async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            // Carries role:'developer' but NO content — used to become
            // `{"role":"system"}` with `content: undefined`.
            { type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'exec' }] },
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' },
            { type: 'agent_message', author: '/root/sub', content: [{ type: 'input_text', text: 'done' }] },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go on' }] },
          ],
        },
        mockContext
      );

      // Only the real user turn becomes a message; the tool DECLARATIONS from
      // `additional_tools` land in `tools`, never as a message.
      expect(unified.messages).toEqual([{ role: 'user', content: 'go on' }]);
      for (const message of unified.messages) {
        expect(message.content, 'no message may carry undefined content').toBeTypeOf('string');
      }
    });

    it('custom_tool_call/_output survive as a tool_call + tool result pair', async () => {
      // Upstreams validate that every assistant tool_call is answered by a tool
      // message and vice versa. Both halves of the codex custom-tool protocol
      // must map, or the history silently loses every `exec` the agent ran.
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            { type: 'custom_tool_call', call_id: 'call_x', name: 'exec', input: 'const a = 1;' },
            {
              type: 'custom_tool_call_output',
              call_id: 'call_x',
              output: [{ type: 'input_text', text: 'ok' }],
            },
            { type: 'function_call', call_id: 'call_y', name: 'wait', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_y', output: 'done' },
          ],
        },
        mockContext
      );

      const toolCallIds = unified.messages.flatMap((m) => m.tool_calls?.map((t) => t.id) ?? []);
      const toolResultIds = unified.messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.tool_call_id);
      expect(toolCallIds).toEqual(['call_x', 'call_y']);
      expect(toolResultIds).toEqual(['call_x', 'call_y']);

      // The free-form custom payload is wrapped into the `{input:…}` envelope
      // the flattened function tool declares.
      const execCall = unified.messages
        .flatMap((m) => m.tool_calls ?? [])
        .find((t) => t.function.name === 'exec')!;
      expect(JSON.parse(execCall.function.arguments)).toEqual({ input: 'const a = 1;' });
      // And its multi-part result is flattened like any other tool result.
      expect(unified.messages.find((m) => m.tool_call_id === 'call_x')!.content).toBe('ok');
    });

    it('additional_tools becomes real tools: function, namespaced, and custom', async () => {
      // codex does NOT use the top-level `tools` field. Dropping this item left
      // the upstream request with no tools at all — the agent loop was dead.
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [
            {
              type: 'additional_tools',
              role: 'developer',
              tools: [
                {
                  type: 'custom',
                  name: 'exec',
                  description: 'Run JavaScript',
                  format: { type: 'grammar', syntax: 'lark', definition: 'start: …' },
                },
                {
                  type: 'function',
                  name: 'wait',
                  description: 'Wait on a cell',
                  parameters: { type: 'object', properties: { cell_id: { type: 'string' } } },
                },
                {
                  type: 'namespace',
                  name: 'collaboration',
                  tools: [
                    {
                      type: 'function',
                      name: 'spawn_agent',
                      description: 'Spawn a sub-agent',
                      parameters: { type: 'object', properties: { task: { type: 'string' } } },
                    },
                  ],
                },
              ],
            },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
          ],
        },
        mockContext
      );

      expect(unified.tools?.map((t) => t.function.name)).toEqual(['exec', 'wait', 'spawn_agent']);

      // A custom tool has no JSON schema of its own — it is exposed as one
      // required free-form `input` string.
      const exec = unified.tools!.find((t) => t.function.name === 'exec')!;
      expect(exec.function.parameters).toMatchObject({
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      });
      // A namespaced tool keeps its BARE name (that is what the model calls).
      expect(unified.tools!.find((t) => t.function.name === 'spawn_agent')!.function.parameters)
        .toMatchObject({ properties: { task: { type: 'string' } } });

      // The protocol state the response encoder needs is threaded on `meta`.
      expect(unified.meta?.codexTools).toEqual({
        customToolNames: ['exec'],
        toolNamespaces: { spawn_agent: 'collaboration' },
      });
    });
  });

  // =========================================================================
  // 2.6 Custom-tool protocol — ENCODE direction (unified reply → codex wire)
  //
  // A tool codex declared `type:'custom'` must come back as a `custom_tool_call`
  // item carrying free-form `input`. The upstream answers in OpenAI-chat, which
  // has only JSON-argument function calls, so the encoder restores the protocol
  // using the state `transformRequestOut` recorded on `meta.codexTools` and
  // `executeResponseChain` threads back on `context.req`.
  // =========================================================================
  describe('2.6 custom-tool encode', () => {
    const codexContext = (customToolNames: string[], toolNamespaces: Record<string, string> = {}) =>
      ({
        ...mockContext,
        req: { model: 'gpt-5-codex', messages: [], meta: { codexTools: { customToolNames, toolNamespaces } } },
      }) as TransformerContext;

    it('JSON: a custom tool call encodes to custom_tool_call with unwrapped input', async () => {
      const out = await transformer.transformResponseIn(
        ccJsonResponse({
          model: 'gpt-5-codex',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'exec', arguments: '{"input":"const a = 1;"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        codexContext(['exec'])
      );
      const json = (await out.json()) as Record<string, any>;

      const item = json.output.find((o: any) => o.type === 'custom_tool_call');
      expect(item, 'must be custom_tool_call, not function_call').toBeDefined();
      expect(item.call_id).toBe('call_abc');
      expect(item.name).toBe('exec');
      // Free-form payload, unwrapped from the `{input:…}` envelope.
      expect(item.input).toBe('const a = 1;');
      expect(item.id).toMatch(/^ctc_/);
      expect(json.output.some((o: any) => o.type === 'function_call')).toBe(false);
    });

    it('JSON: a namespaced function call keeps function_call and regains its namespace', async () => {
      const out = await transformer.transformResponseIn(
        ccJsonResponse({
          model: 'gpt-5-codex',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_z', type: 'function', function: { name: 'spawn_agent', arguments: '{"task":"x"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        codexContext(['exec'], { spawn_agent: 'collaboration' })
      );
      const json = (await out.json()) as Record<string, any>;

      const item = json.output.find((o: any) => o.type === 'function_call');
      expect(item.name).toBe('spawn_agent');
      expect(item.namespace).toBe('collaboration');
      expect(item.arguments).toBe('{"task":"x"}');
      expect(item.id).toMatch(/^fc_/);
    });

    it('SSE: a custom tool streams added → input delta+done → item.done', async () => {
      // The upstream streams the arguments JSON in fragments; the free-form
      // `input` is only recoverable once complete, so it is emitted at finish.
      const out = await transformer.transformResponseIn(
        sseResponse([
          'data: {"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"exec","arguments":"{\\"input\\":\\"con"}}]},"finish_reason":null}]}\n\n',
          'data: {"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"st a = 1;\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        codexContext(['exec'])
      );

      const events = (await drainSseEvents(out)) as Array<Record<string, any>>;
      const types = events.map((e) => e.type);

      // Opened as a custom_tool_call, not a function_call.
      const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'custom_tool_call');
      expect(added, 'custom_tool_call item must be opened').toBeDefined();
      expect(added!.item.call_id).toBe('call_abc');

      // No half-parsed JSON leaked as function-call argument deltas.
      expect(types).not.toContain('response.function_call_arguments.delta');

      const inputDelta = events.find((e) => e.type === 'response.custom_tool_call_input.delta')!;
      expect(inputDelta.delta).toBe('const a = 1;');
      const inputDone = events.find((e) => e.type === 'response.custom_tool_call_input.done')!;
      expect(inputDone.input).toBe('const a = 1;');

      const done = events.find((e) => e.type === 'response.output_item.done')!;
      expect(done.item.type).toBe('custom_tool_call');
      expect(done.item.input).toBe('const a = 1;');
      expect(done.item.status).toBe('completed');

      // The terminal response carries the same item.
      const completed = events.find((e) => e.type === 'response.completed')!;
      expect(completed.response.output[0]).toMatchObject({
        type: 'custom_tool_call',
        name: 'exec',
        input: 'const a = 1;',
      });
    });

    it('SSE: without codex custom-tool state, tool calls stay plain function_calls', async () => {
      // A non-codex client declares no custom tools — behaviour is unchanged.
      const out = await transformer.transformResponseIn(
        sseResponse([
          'data: {"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]},"finish_reason":null}]}\n\n',
          'data: {"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        ]),
        mockContext
      );

      const events = (await drainSseEvents(out)) as Array<Record<string, any>>;
      const added = events.find((e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call');
      expect(added).toBeDefined();
      expect(events.map((e) => e.type)).toContain('response.function_call_arguments.delta');
      expect(events.some((e) => e.item?.type === 'custom_tool_call')).toBe(false);
    });

    it('malformed custom-tool arguments pass through raw instead of dropping the call', async () => {
      const out = await transformer.transformResponseIn(
        ccJsonResponse({
          model: 'm',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                // Model ignored the schema and emitted bare text.
                tool_calls: [{ id: 'call_q', type: 'function', function: { name: 'exec', arguments: 'not json' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        codexContext(['exec'])
      );
      const json = (await out.json()) as Record<string, any>;
      expect(json.output[0].type).toBe('custom_tool_call');
      expect(json.output[0].input).toBe('not json');
    });
  });

  // =========================================================================
  // 2.3 reasoning.effort mapping (both directions)
  // =========================================================================
  describe('2.3 reasoning.effort', () => {
    it('transformRequestOut: maps reasoning.effort into unified.reasoning', async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [{ role: 'user', content: 'think hard' }],
          reasoning: { effort: 'high' },
        },
        mockContext
      );

      expect(unified.reasoning).toBeDefined();
      expect(unified.reasoning!.effort).toBe('high');
      expect(unified.reasoning!.enabled).toBe(true);
    });

    it.each(['minimal', 'xhigh', 'max'] as const)(
      'transformRequestOut: accepts extended effort %s',
      async (effort) => {
        const unified = await transformer.transformRequestOut({
          model: 'unknown-target',
          input: [{ role: 'user', content: 'think' }],
          reasoning: { effort: effort.toUpperCase() },
        }, mockContext);
        expect(unified.reasoning).toEqual({ effort, enabled: true });
      },
    );

    it('ignores malformed effort and decodes explicit none as disabled', async () => {
      const malformed = await transformer.transformRequestOut({
        model: 'm', input: [], reasoning: { effort: 'turbo' },
      }, mockContext);
      expect(malformed.reasoning).toBeUndefined();
      const disabled = await transformer.transformRequestOut({
        model: 'm', input: [], reasoning: { effort: 'none' },
      }, mockContext);
      expect(disabled.reasoning).toEqual({ effort: 'none', enabled: false });
    });

    it('transformRequestIn (reverse): maps unified.reasoning.effort back to Responses reasoning', async () => {
      // transformRequestIn is the PROVIDER-encode direction (unified → Responses);
      // verifying it confirms effort survives a full effort round-trip.
      const body = await transformer.transformRequestIn(
        {
          model: 'gpt-5-codex',
          messages: [{ role: 'user', content: 'think hard' }],
          reasoning: { effort: 'high', enabled: true },
        },
        { name: 'codex', baseUrl: 'https://api.openai.com', apiKey: 'k', models: [] },
        mockContext
      );

      const innerBody = (body as Record<string, any>).body ?? body;
      expect(innerBody.reasoning).toBeDefined();
      expect(innerBody.reasoning.effort).toBe('high');
    });

    it("round-trips effort: request effort → unified → request effort", async () => {
      const unified = await transformer.transformRequestOut(
        {
          model: 'gpt-5-codex',
          input: [{ role: 'user', content: 'x' }],
          reasoning: { effort: 'medium' },
        },
        mockContext
      );
      const body = await transformer.transformRequestIn(
        unified,
        { name: 'codex', baseUrl: 'https://api.openai.com', apiKey: 'k', models: [] },
        mockContext
      );
      const innerBody = (body as Record<string, any>).body ?? body;
      expect(innerBody.reasoning.effort).toBe('medium');
    });

    it('extracts native Chat effort and negotiates it for a Responses target', async () => {
      const body = await transformer.transformRequestIn({
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'x' }],
        reasoning_effort: 'xhigh',
      }, { name: 'codex', baseUrl: 'https://api.openai.com', apiKey: 'k', models: [] }, mockContext);
      expect(((body as Record<string, any>).body ?? body).reasoning.effort).toBe('xhigh');
    });

    it('preserves Chat max when converting to a GPT-5.6 Responses target', async () => {
      const body = await transformer.transformRequestIn({
        model: 'gpt-5.6',
        messages: [{ role: 'user', content: 'x' }],
        reasoning_effort: 'max',
      }, { name: 'codex', baseUrl: 'https://api.openai.com', apiKey: 'k', models: [] }, mockContext);
      expect(((body as Record<string, any>).body ?? body).reasoning.effort).toBe('max');
    });
  });

  // =========================================================================
  // 2.4 Streaming SSE round-trip (transformResponseIn — encode CC → Responses SSE)
  // =========================================================================
  describe('2.4 streaming SSE', () => {
    it('transformResponseIn: CC stream → valid Responses-API SSE', async () => {
      const ccFrames = [
        'data: {"id":"1","model":"gpt-5-codex","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"1","model":"gpt-5-codex","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","model":"gpt-5-codex","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","model":"gpt-5-codex","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ];

      const out = await transformer.transformResponseIn(sseResponse(ccFrames), mockContext);
      expect(out.headers.get('Content-Type')).toContain('text/event-stream');

      const events = (await drainSseEvents(out)) as Array<Record<string, any>>;
      const types = events.map((e) => e.type);

      // Responses-API SSE protocol shape
      expect(types).toContain('response.created');
      expect(types).toContain('response.output_text.delta');
      expect(types).toContain('response.completed');

      // text deltas reassemble to "Hello"
      const deltaText = events
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.delta)
        .join('');
      expect(deltaText).toBe('Hello');

      // completed event carries the final assembled message + usage
      const completed = events.find((e) => e.type === 'response.completed')!;
      expect(completed.response.status).toBe('completed');
      expect(completed.response.output[0].content[0].text).toBe('Hello');
      expect(completed.response.usage).toEqual({
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
      });
    });

    it('transformResponseOut (reverse SSE): Responses stream → OpenAI-CC SSE', async () => {
      // Reverse path via convertResponseApiStreamToOpenAI, reachable through
      // transformResponseOut (the PROVIDER-decode direction).
      const respFrames = [
        'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","model":"gpt-5-codex"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Hi","response":{"model":"gpt-5-codex"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"!","response":{"model":"gpt-5-codex"}}\n\n',
        'data: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
        'data: [DONE]\n\n',
      ];

      const out = await transformer.transformResponseOut(sseResponse(respFrames), mockContext);
      expect(out.headers.get('Content-Type')).toContain('text/event-stream');

      const events = (await drainSseEvents(out)) as Array<Record<string, any>>;
      // OpenAI-CC chunk shape
      for (const e of events) {
        expect(e.object).toBe('chat.completion.chunk');
      }
      const contentText = events
        .map((e) => e.choices?.[0]?.delta?.content ?? '')
        .join('');
      expect(contentText).toBe('Hi!');

      const finalChunk = events.find((e) => e.choices?.[0]?.finish_reason === 'stop')!;
      expect(finalChunk).toBeDefined();
      expect(finalChunk.usage).toEqual({
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      });
    });
  });
});
