/**
 * GeminiTransformer — tool-call round-trip coverage (fix-omni-conversions-gemini).
 *
 * The Gemini wire shape carries tool interaction as:
 *   - tools declared via `tools[].functionDeclarations`
 *   - model tool invocation as `contents[].parts[].functionCall`
 *   - tool results as `contents[].parts[].functionResponse`
 *
 * The unified (OpenAI-chat-like) intermediate carries:
 *   - `messages[].tool_calls` on the assistant turn
 *   - `role:"tool"` messages with `tool_call_id` for results
 *
 * This suite covers BOTH directions, streaming and non-streaming:
 *   1. transformRequestOut  — Gemini client request  → unified (endpoint decode)
 *   2. buildRequestBody     — unified                → Gemini provider request
 *   3. handleJsonResponse   — Gemini non-stream JSON → OpenAI non-stream JSON
 *   4. handleStreamResponse — Gemini SSE             → OpenAI SSE tool_calls deltas
 *   5. convertOpenAIResponseToGemini — OpenAI JSON   → Gemini JSON (endpoint encode)
 *   6. convertOpenAIStreamToGemini   — OpenAI SSE    → Gemini SSE functionCall
 *
 * @module transformer/__tests__/GeminiTransformer.toolcalls.test
 */

import { describe, expect, it } from 'vitest';

import {
  buildRequestBody,
  transformRequestOut,
} from '../transformers/utils/gemini.util';
import { transformResponseOut } from '../transformers/utils/gemini.stream';
import {
  convertOpenAIResponseToGemini,
  convertOpenAIStreamToGemini,
  transformResponseIn,
} from '../transformers/utils/gemini.response-in';
import type { UnifiedChatRequest } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
async function drainSseEvents(response: Response): Promise<Array<Record<string, any>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<Record<string, any>> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]' || data === '') continue;
    events.push(JSON.parse(data));
  }
  return events;
}

function baseRequest(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'search the web for cats' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. transformRequestOut — Gemini client request → unified
// ---------------------------------------------------------------------------

describe('transformRequestOut (Gemini request → unified)', () => {
  it('maps a model functionCall part to an assistant message with tool_calls', () => {
    const geminiReq = {
      model: 'gemini-2.5-pro',
      contents: [
        { role: 'user', parts: [{ text: 'find cats' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_1', name: 'search', args: { q: 'cats' } } },
          ],
        },
      ],
    };
    const unified = transformRequestOut(geminiReq);

    const assistant = unified.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: JSON.stringify({ q: 'cats' }) },
      },
    ]);
  });

  it('maps a user functionResponse part to a role:tool message', () => {
    const geminiReq = {
      model: 'gemini-2.5-pro',
      contents: [
        { role: 'user', parts: [{ text: 'find cats' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_42', name: 'search', args: { q: 'cats' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'search',
                response: { result: '32 cats found' },
              },
            },
          ],
        },
      ],
    };
    const unified = transformRequestOut(geminiReq);

    // The functionResponse must become its own role:tool message paired with
    // the previous tool_call's id (matched by NAME since Gemini carries no id).
    const toolMsg = unified.messages[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_42');
    expect(toolMsg.content).toBe('32 cats found');
  });

  it('falls back to a synthetic id when no prior functionCall name matches', () => {
    const geminiReq = {
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'orphan',
                response: { result: { ok: true } },
              },
            },
          ],
        },
      ],
    };
    const unified = transformRequestOut(geminiReq);
    const toolMsg = unified.messages[0];
    expect(toolMsg.role).toBe('tool');
    expect(typeof toolMsg.tool_call_id).toBe('string');
    // Non-string result is JSON-stringified.
    expect(toolMsg.content).toBe(JSON.stringify({ ok: true }));
  });

  it('preserves inlineData and file_data parts as image_url content blocks', () => {
    const geminiReq = {
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'describe this' },
            { inlineData: { mime_type: 'image/png', data: 'BASE64===' } },
            { file_data: { mime_type: 'image/jpeg', file_uri: 'https://x/y.jpg' } },
          ],
        },
      ],
    };
    const unified = transformRequestOut(geminiReq);
    const user = unified.messages[0];
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(parts[1].type).toBe('image_url');
    expect((parts[1].image_url as { url: string }).url).toContain('data:image/png;base64,');
    expect(parts[2].type).toBe('image_url');
    expect((parts[2].image_url as { url: string }).url).toBe('https://x/y.jpg');
  });

  it('maps functionDeclarations to unified tools (preferring parameters over parametersJsonSchema)', () => {
    const geminiReq = {
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search',
              description: 'search the web',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
            {
              name: 'noParams',
              parametersJsonSchema: { type: 'object' },
            },
          ],
        },
      ],
    };
    const unified = transformRequestOut(geminiReq);
    expect(unified.tools).toBeDefined();
    expect(unified.tools!.map((t) => t.function.name)).toEqual(['search', 'noParams']);
    expect(unified.tools![0].function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    expect(unified.tools![1].function.parameters).toEqual({ type: 'object' });
  });

  it('round-trips a multi-turn tool loop through buildRequestBody → transformRequestOut', () => {
    // Start from unified, encode to Gemini (buildRequestBody), then decode back
    // (transformRequestOut). The tool_calls / tool messages must survive.
    const original: UnifiedChatRequest = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user', content: 'find cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_7',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"cats"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_7', content: '32 cats' },
        { role: 'assistant', content: 'found 32 cats' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: '',
            parameters: { type: 'object' as const },
          },
        },
      ],
    };

    const geminiBody = buildRequestBody(original);
    const decoded = transformRequestOut({
      model: original.model,
      contents: geminiBody.contents,
      tools: geminiBody.tools,
    });

    // The assistant tool_call round-trips with the SAME id (no random fallback).
    const decodedAssistant = decoded.messages.find((m) => m.tool_calls?.length);
    expect(decodedAssistant).toBeDefined();
    expect(decodedAssistant!.tool_calls![0].id).toBe('call_7');
    expect(decodedAssistant!.tool_calls![0].function.name).toBe('search');
    expect(decodedAssistant!.tool_calls![0].function.arguments).toBe('{"q":"cats"}');

    // The tool result message round-trips with the matching tool_call_id.
    const toolMsg = decoded.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe('call_7');
    expect(toolMsg!.content).toBe('32 cats');
  });

  it('regression: a part carrying BOTH text and thoughtSignature keeps the text', () => {
    // Gemini attaches thoughtSignature to ANY part kind on a thinking turn; a
    // `{text, thoughtSignature}` part must not lose its text (previously the
    // signature branch preempted the text branch).
    const decoded = transformRequestOut({
      model: 'gemini-2.5-pro',
      contents: [
        { role: 'model', parts: [{ text: 'Here is my answer', thoughtSignature: 'sig_1' }] },
      ],
    });
    const asst = decoded.messages.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(asst!.content).toBe('Here is my answer');
    expect((asst!.thinking as { signature?: string })?.signature).toBe('sig_1');
  });

  it('regression: parallel same-name tool calls pair results to the correct ids (by order)', () => {
    // Two concurrent `search` calls: Gemini functionResponse carries no id, so
    // the decoder pairs by NAME+ORDER. Both results must not collapse onto the
    // last call's id.
    const decoded = transformRequestOut({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'c1', name: 'search', args: { q: 'cats' } } },
            { functionCall: { id: 'c2', name: 'search', args: { q: 'dogs' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'search', response: { result: '32 cats' } } },
            { functionResponse: { name: 'search', response: { result: '7 dogs' } } },
          ],
        },
      ],
    });
    const toolMsgs = decoded.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].tool_call_id).toBe('c1');
    expect(toolMsgs[0].content).toBe('32 cats');
    expect(toolMsgs[1].tool_call_id).toBe('c2');
    expect(toolMsgs[1].content).toBe('7 dogs');
  });
});

// ---------------------------------------------------------------------------
// 2. buildRequestBody — unified → Gemini provider request (regression guard)
// ---------------------------------------------------------------------------

describe('buildRequestBody (unified → Gemini request) tool handling', () => {
  it('emits a functionCall part for assistant tool_calls and a functionResponse part for tool results', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'find cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_7',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"cats"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_7', content: '32 cats' },
      ],
    });
    const body = buildRequestBody(req);

    // contents: [user(text), model(functionCall), user(functionResponse)]
    expect(body.contents.length).toBe(3);
    const modelContent = body.contents[1];
    expect(modelContent.role).toBe('model');
    const modelParts = modelContent.parts as Array<Record<string, unknown>>;
    expect(modelParts[0].functionCall).toEqual({
      id: 'call_7',
      name: 'search',
      args: { q: 'cats' },
    });

    const toolContent = body.contents[2];
    expect(toolContent.role).toBe('user');
    const toolParts = toolContent.parts as Array<Record<string, unknown>>;
    expect(toolParts[0].functionResponse).toEqual({
      name: 'search',
      response: { result: '32 cats' },
    });
  });
});

// ---------------------------------------------------------------------------
// 3. handleJsonResponse — Gemini non-stream JSON → OpenAI JSON
// ---------------------------------------------------------------------------

describe('transformResponseOut (Gemini non-stream JSON → OpenAI JSON)', () => {
  it('maps candidates[].content.parts[].functionCall to message.tool_calls', async () => {
    const geminiJson = {
      responseId: 'r-1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { id: 'call_a', name: 'search', args: { q: 'cats' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    };
    const upstream = new Response(JSON.stringify(geminiJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const out = await transformResponseOut(upstream, 'gemini');
    const parsed = await out.json();
    const choice = parsed.choices[0];
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'search', arguments: JSON.stringify({ q: 'cats' }) },
      },
    ]);
    // No text content was emitted, so content should be empty.
    expect(choice.message.content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4. handleStreamResponse — Gemini SSE → OpenAI SSE tool_calls deltas
// ---------------------------------------------------------------------------

describe('transformResponseOut (Gemini SSE → OpenAI SSE) tool-call deltas', () => {
  it('emits tool_calls deltas from a functionCall part in a stream chunk', async () => {
    const frames = [
      `data: ${JSON.stringify({
        responseId: 'r',
        modelVersion: 'gemini-2.5-pro',
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_x',
                    name: 'search',
                    args: { q: 'cats' },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })}\n\n`,
    ];
    const upstream = sseResponse(frames);

    const out = await transformResponseOut(upstream, 'gemini');
    const events = await drainSseEvents(out);

    // At least one chunk must carry a tool_calls delta — this is the bug class
    // (silent drop) we are guarding against.
    const toolDeltas = events.flatMap(
      (e) => e.choices?.[0]?.delta?.tool_calls ?? [],
    );
    expect(toolDeltas.length).toBeGreaterThan(0);
    const opened = toolDeltas.find((tc) => tc.id === 'call_x');
    expect(opened).toBeDefined();
    expect(opened.function.name).toBe('search');
    expect(opened.function.arguments).toBe(JSON.stringify({ q: 'cats' }));
  });

  it('still emits tool_calls when text content was buffered (Gemini 3.x pre-signature)', async () => {
    // Scenario: a Gemini 3 model already streamed thinking content, then sends
    // a chunk with BOTH pre-signature text AND a functionCall. The pre-signature
    // text must be buffered, but the tool call MUST still be emitted.
    const frames = [
      // Thinking delta first.
      `data: ${JSON.stringify({
        responseId: 'r',
        modelVersion: 'gemini-3-pro',
        candidates: [
          {
            content: { parts: [{ text: 'planning', thought: true }] },
          },
        ],
      })}\n\n`,
      // Mixed chunk: pre-signature text + functionCall.
      `data: ${JSON.stringify({
        responseId: 'r',
        modelVersion: 'gemini-3-pro',
        candidates: [
          {
            content: {
              parts: [
                { text: 'calling tool now' },
                {
                  functionCall: {
                    id: 'call_y',
                    name: 'run',
                    args: { x: 1 },
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      })}\n\n`,
    ];
    const upstream = sseResponse(frames);

    const out = await transformResponseOut(upstream, 'gemini');
    const events = await drainSseEvents(out);

    const toolDeltas = events.flatMap(
      (e) => e.choices?.[0]?.delta?.tool_calls ?? [],
    );
    // The bug previously dropped these tool_calls due to an early return.
    expect(toolDeltas.length).toBeGreaterThan(0);
    expect(toolDeltas.some((tc) => tc.id === 'call_y')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. convertOpenAIResponseToGemini — OpenAI JSON → Gemini JSON (endpoint encode)
// ---------------------------------------------------------------------------

describe('convertOpenAIResponseToGemini (OpenAI JSON → Gemini JSON)', () => {
  it('maps message.tool_calls to candidates[].content.parts[].functionCall', () => {
    const openai = {
      id: 'chatcmpl-1',
      model: 'gemini-2.5-pro',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_z',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"dogs"}' },
              },
            ],
          },
        },
      ],
    };
    const gemini = convertOpenAIResponseToGemini(openai);
    const parts = gemini.candidates[0].content.parts;
    const fcPart = parts.find((p) => p.functionCall);
    expect(fcPart).toBeDefined();
    expect(fcPart!.functionCall).toEqual({
      id: 'call_z',
      name: 'search',
      args: { q: 'dogs' },
    });
    // tool_calls finish_reason must map to a Gemini-compatible STOP.
    expect(gemini.candidates[0].finishReason).toBe('STOP');
  });
});

// ---------------------------------------------------------------------------
// 6. convertOpenAIStreamToGemini — OpenAI SSE → Gemini SSE functionCall
// ---------------------------------------------------------------------------

describe('convertOpenAIStreamToGemini (OpenAI SSE → Gemini SSE)', () => {
  async function drainGeminiSse(response: Response): Promise<Array<Record<string, any>>> {
    return drainSseEvents(response);
  }

  it('accumulates OpenAI tool_call deltas and flushes complete functionCall parts on finish_reason', async () => {
    // OpenAI sends tool_call opening + argument deltas + finish_reason.
    const frames = [
      'data: {"id":"1","model":"g","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_w","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n',
      'data: {"id":"1","model":"g","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":\\"birds\\"}"}}]}}]}\n\n',
      'data: {"id":"1","model":"g","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = sseResponse(frames);

    const out = await transformResponseIn(upstream);
    const events = await drainGeminiSse(out);

    // Find the chunk that carries the functionCall part — this is the bug class
    // (silent drop) we are guarding against in the reverse direction.
    const allParts = events.flatMap(
      (e) => e.candidates?.[0]?.content?.parts ?? [],
    );
    const fcPart = allParts.find((p) => p.functionCall);
    expect(fcPart).toBeDefined();
    expect(fcPart.functionCall.id).toBe('call_w');
    expect(fcPart.functionCall.name).toBe('search');
    expect(fcPart.functionCall.args).toEqual({ q: 'birds' });
  });

  it('flushes pending tool_calls even without a finish_reason (stream ended)', async () => {
    // Some upstream relays end the stream after the last argument delta without
    // emitting a finish_reason frame; pending tool_calls must still flush.
    const frames = [
      'data: {"id":"1","model":"g","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_e","type":"function","function":{"name":"run","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstream = sseResponse(frames);

    const out = await transformResponseIn(upstream);
    const events = await drainSseEvents(out);
    const allParts = events.flatMap(
      (e) => e.candidates?.[0]?.content?.parts ?? [],
    );
    const fcPart = allParts.find((p) => p.functionCall);
    expect(fcPart).toBeDefined();
    expect(fcPart.functionCall.name).toBe('run');
  });
});
