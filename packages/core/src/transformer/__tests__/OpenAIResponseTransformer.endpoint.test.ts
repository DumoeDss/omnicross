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

      // developer → system, user → user
      expect(unified.messages).toEqual([
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
