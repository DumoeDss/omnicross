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
  it('decodes discrete and legacy thinking configuration without includeThoughts inference', () => {
    expect(transformRequestOut({
      model: 'gemini-3-flash',
      contents: [],
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
    }).reasoning).toEqual({ effort: 'high', enabled: true });
    expect(transformRequestOut({
      model: 'gemini-2.5-flash',
      contents: [],
      generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
    }).reasoning).toEqual({ effort: 'medium', enabled: true, max_tokens: 8192 });
    expect(transformRequestOut({
      model: 'gemini-2.5-flash',
      contents: [],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    }).reasoning).toEqual({ effort: 'none', enabled: false, max_tokens: 0 });
    expect(transformRequestOut({
      model: 'gemini-2.5-flash',
      contents: [],
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    }).reasoning).toBeUndefined();
  });

  it('does not enable malformed or absent thinking levels', () => {
    expect(transformRequestOut({
      model: 'gemini-3-flash', contents: [],
      generationConfig: { thinkingConfig: { thinkingLevel: 'turbo' } },
    }).reasoning).toBeUndefined();
    expect(transformRequestOut({ model: 'gemini-3-flash', contents: [] }).reasoning).toBeUndefined();
  });

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

  it('maps functionDeclarations with either schema representation to unified tools', () => {
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
    expect(buildRequestBody(decoded).contents[0].parts).toEqual([{ text: 'Here is my answer', thoughtSignature: 'sig_1' }]);
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
      id: 'call_7',
      name: 'search',
      response: { result: '32 cats' },
    });
  });

  it('encodes negotiated levels and rejects unsupported disablement', () => {
    const discrete = buildRequestBody(baseRequest({
      model: 'gemini-3-flash',
      reasoning: { effort: 'xhigh', enabled: true },
    }));
    expect(discrete.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
    expect(() => buildRequestBody(baseRequest({
      model: 'gemini-3-flash',
      reasoning: { effort: 'none', enabled: false },
    }))).toThrow('Thinking cannot be disabled');
  });

  it.each([
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ])('encodes numeric budgets and disablement for %s', (model) => {
    const enabled = buildRequestBody(baseRequest({
      model,
      reasoning: { effort: 'high', enabled: true },
    }));
    expect(enabled.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 19660,
    });

    for (const budget of [0, 8192]) {
      const unified = transformRequestOut({
        model,
        contents: [],
        generationConfig: { thinkingConfig: { thinkingBudget: budget } },
      });
      const roundTrip = buildRequestBody(unified, undefined, true);
      expect(roundTrip.generationConfig?.thinkingConfig).toEqual({
        thinkingBudget: budget,
      });
    }
  });

  it('uses legacy limits, clamps explicit budgets, and computes a default', () => {
    const provider = {
      modelConfigs: [{
        id: 'legacy-gemini',
        thinkingTokenLimit: { min: 100, max: 1000 },
      }],
    };
    const explicit = buildRequestBody(baseRequest({
      model: 'legacy-gemini',
      reasoning: { effort: 'high', enabled: true, max_tokens: 5000 },
    }), provider);
    expect(explicit.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1000);
    const computed = buildRequestBody(baseRequest({
      model: 'legacy-gemini',
      reasoning: { effort: 'medium', enabled: true },
    }), provider);
    expect(computed.generationConfig?.thinkingConfig?.thinkingBudget).toBe(550);
  });

  it('uses legacy budget encoding when an empty row override shadows canonical levels', () => {
    const body = buildRequestBody(baseRequest({
      model: 'gemini-3-flash',
      reasoning: { effort: 'xhigh', enabled: true, max_tokens: 4096 },
    }), {
      modelConfigs: [{
        id: 'gemini-3-flash',
        thinkingLevels: [],
        thinkingTokenLimit: { min: 0, max: 24576 },
      }],
    });

    expect(body.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 4096,
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

  it('emits text and tool calls even when Gemini 3 never returns a signature', async () => {
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
    expect(events.map((event) => event.choices?.[0]?.delta?.content ?? '').join('')).toBe('calling tool now');
    expect(events.flatMap((event) => event.choices ?? []).every((choice) => choice.index === 0)).toBe(true);
    expect(events.map((event) => event.choices?.[0]?.delta?.thinking?.signature).filter(Boolean)).toEqual([]);
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

describe('Gemini protocol fidelity', () => {
  it('keeps system priority, sampling, native dynamic thinking and schema constraints', () => {
    const native = {
      model: 'gemini-2.5-flash',
      systemInstruction: { parts: [{ text: 'System policy' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        temperature: 0, topP: 0.8, topK: 9, stopSequences: ['END'],
        thinkingConfig: { thinkingBudget: -1, includeThoughts: false },
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } } },
      },
    };
    const unified = transformRequestOut(native);
    expect(unified.messages[0]).toMatchObject({ role: 'system', content: 'System policy' });
    expect(unified.reasoning).toEqual({ enabled: true });
    const encoded = buildRequestBody(unified);
    expect(encoded.systemInstruction).toEqual(native.systemInstruction);
    expect(encoded.contents).toEqual(native.contents);
    expect(encoded.generationConfig).toEqual(native.generationConfig);
  });

  it('preserves the MIME and ordering of interleaved images and text', () => {
    const decoded = transformRequestOut({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
        { text: 'first image' },
        { fileData: { mimeType: 'image/webp', fileUri: 'gs://bucket/image.webp' } },
      ] }],
    });
    expect(decoded.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' }, media_type: 'image/jpeg' },
      { type: 'text', text: 'first image' },
      { type: 'image_url', image_url: { url: 'gs://bucket/image.webp' }, media_type: 'image/webp' },
    ]);
    const encoded = buildRequestBody(baseRequest({ messages: [{
      role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }],
    }] }));
    expect(encoded.contents[0].parts).toEqual([{ inlineData: { mime_type: 'image/jpeg', data: 'AAAA' } }]);
  });

  it('matches reversed parallel same-name results by ID and never invents missing results', () => {
    const decoded = transformRequestOut({
      model: 'gemini-3-flash', contents: [
        { role: 'model', parts: [
          { functionCall: { id: 'a', name: 'lookup', args: { key: 1 } }, thoughtSignature: 'opaque-a' },
          { functionCall: { id: 'b', name: 'lookup', args: { key: 2 } }, thoughtSignature: 'opaque-b' },
        ] },
        { role: 'user', parts: [
          { functionResponse: { id: 'b', name: 'lookup', response: { error: 'failed' } } },
          { functionResponse: { id: 'a', name: 'lookup', response: { result: 'ok' } } },
        ] },
      ],
    });
    expect(decoded.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['b', 'a']);
    const encoded = buildRequestBody(decoded);
    expect(encoded.contents[0].parts.map((part) => 'thoughtSignature' in part ? part.thoughtSignature : undefined)).toEqual(['opaque-a', 'opaque-b']);
    expect(encoded.contents[1].parts[0]).toMatchObject({ functionResponse: { response: { error: 'failed' } } });
    const unfinished = buildRequestBody(baseRequest({ messages: [decoded.messages[0]] }));
    expect(unfinished.contents).toHaveLength(1);
  });

  it('keeps unsigned thinking in JSON and does not copy another vendor signature', async () => {
    const decoded = await transformResponseOut(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ thought: true, text: 'reasoning' }, { text: 'answer' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 10 },
    }), { headers: { 'Content-Type': 'application/json' } }), 'gemini');
    const chat = await decoded.json();
    expect(chat.choices[0].message.thinking).toEqual({ content: 'reasoning' });
    expect(chat.choices[0].finish_reason).toBe('length');
    expect(chat.usage.completion_tokens).toBe(5);
    expect(convertOpenAIResponseToGemini(chat).usageMetadata).toMatchObject({ candidatesTokenCount: 2, thoughtsTokenCount: 3 });
    const crossVendor = convertOpenAIResponseToGemini({ choices: [{ message: {
      content: 'answer', thinking: { content: 'reasoning', signature: 'claude-only' },
    } }] });
    expect(crossVendor.candidates[0].content.parts).toEqual([{ text: 'reasoning', thought: true }, { text: 'answer' }]);
  });

  it('round-trips every signed native part without moving or duplicating signatures', async () => {
    const parts = [
      { text: 'reason', thought: true, thoughtSignature: 'opaque-1' },
      { functionCall: { id: 'one', name: 'lookup', args: {} }, thoughtSignature: 'opaque-2' },
      { functionCall: { id: 'two', name: 'lookup', args: {} }, thoughtSignature: 'opaque-3' },
    ];
    const decoded = await transformResponseOut(new Response(JSON.stringify({
      candidates: [{ content: { parts }, finishReason: 'STOP' }],
    }), { headers: { 'Content-Type': 'application/json' } }), 'gemini');
    expect(convertOpenAIResponseToGemini(await decoded.json()).candidates[0].content.parts).toEqual(parts);
  });

  it('decodes fragmented multiline CRLF SSE and preserves final usage-only events', async () => {
    const wire = 'data:{"candidates":[{"index":0,"content":{"parts":[{"text":"你好","thought":true}]}}],\r\n'
      + 'data:"modelVersion":"gemini-2.5-flash"}\r\n\r\n'
      + 'data:{"candidates":[{"index":0,"finishReason":"STOP"}]}\r\n\r\n'
      + 'data:{"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"thoughtsTokenCount":3,"totalTokenCount":9}}';
    const bytes = new TextEncoder().encode(wire);
    const upstream = new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    const output = await drainSseEvents(await transformResponseOut(upstream, 'gemini'));
    expect(output[0].choices[0].delta.thinking.content).toBe('你好');
    expect(output[1].choices[0].finish_reason).toBe('stop');
    expect(output[2].usage).toMatchObject({ completion_tokens: 5, total_tokens: 9 });
  });

  it('converts interleaved duplicate-name tool deltas and usage after finish', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: 'plan', tool_calls: [
        { index: 0, id: 'a', function: { name: 'lookup', arguments: '{"n":' } },
        { index: 1, id: 'b', function: { name: 'lookup', arguments: '{"n":' } },
      ] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } },
      ] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, completion_tokens_details: { reasoning_tokens: 3 } } },
    ];
    const output = await drainSseEvents(await transformResponseIn(sseResponse(chunks.map((chunk) => `data:${JSON.stringify(chunk)}\r\n\r\n`))));
    const parts = output.flatMap((chunk) => chunk.candidates?.[0]?.content.parts ?? []);
    expect(parts[0]).toEqual({ text: 'plan', thought: true });
    expect(parts.filter((part) => part.functionCall).map((part) => part.functionCall)).toEqual([
      { id: 'a', name: 'lookup', args: { n: 1 } }, { id: 'b', name: 'lookup', args: { n: 2 } },
    ]);
    expect(output.at(-1)?.usageMetadata).toMatchObject({ candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 });
  });

  it('preserves provider errors and safety blocks instead of reporting success', async () => {
    const error = { error: { code: 429, message: 'quota' } };
    const failed = new Response(JSON.stringify(error), { status: 429, headers: { 'Content-Type': 'application/json' } });
    const output = await transformResponseOut(failed, 'gemini');
    expect(output.status).toBe(429);
    expect(await output.json()).toEqual(error);
    const events = await drainSseEvents(await transformResponseOut(sseResponse([`data:${JSON.stringify(error)}\n\n`]), 'gemini'));
    expect(events).toEqual([error]);
    const blocked = await transformResponseOut(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), {
      headers: { 'Content-Type': 'application/json' },
    }), 'gemini');
    expect((await blocked.json()).choices[0].finish_reason).toBe('content_filter');
    expect(() => convertOpenAIResponseToGemini({ choices: [{ message: {
      tool_calls: [{ id: 'bad', function: { name: 'run', arguments: '{"broken":' } }],
    } }] })).toThrow();
  });
});

describe('Gemini tools and schemas', () => {
  it('keeps custom web_search callable and preserves ANY allowlists across protocols', () => {
    const decoded = transformRequestOut({
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: 'search' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search', 'lookup'] } },
      tools: [{ functionDeclarations: [
        { name: 'web_search', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', nullable: true } } } },
        { name: 'lookup', parametersJsonSchema: { type: 'object', additionalProperties: false, properties: {} } },
        { name: 'forbidden', parameters: { type: 'OBJECT' } },
      ] }],
    });
    expect(decoded.messages[0]).toMatchObject({ role: 'user', content: 'search' });
    expect(decoded.tool_choice).toBe('required');
    expect(decoded.tools?.map((tool) => tool.function.name)).toEqual(['web_search', 'lookup']);
    expect(decoded.tools?.[0].function.parameters.properties.query).toEqual({ type: ['string', 'null'] });
    const crossProtocol = buildRequestBody(baseRequest({ tools: decoded.tools, tool_choice: 'required' }));
    expect(crossProtocol.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(crossProtocol.tools?.[0].functionDeclarations?.map((tool) => tool.name)).toEqual(['web_search', 'lookup']);
    expect(crossProtocol.tools?.[0].functionDeclarations?.[1].parametersJsonSchema).toMatchObject({ additionalProperties: false });
  });

  it('keeps tool failure status and image output inside functionResponse parts', () => {
    const body = buildRequestBody(baseRequest({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c', is_error: true, content: [
          { type: 'text', text: 'partial result' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        ] },
      ],
    }));
    expect(body.contents[1].parts).toEqual([{
      functionResponse: {
        id: 'c', name: 'inspect', response: { error: 'partial result' },
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }],
      },
    }]);
    const decoded = transformRequestOut({ model: 'gemini-3-flash', contents: body.contents });
    expect(decoded.messages[1]).toMatchObject({
      role: 'tool', is_error: true,
      content: [{ type: 'text', text: '{"error":"partial result"}' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }],
    });
  });

  it('keeps independent candidates and image output in the reverse JSON direction', async () => {
    const upstream = new Response(JSON.stringify({ candidates: [
      { index: 0, content: { parts: [{ text: 'first' }] }, finishReason: 'STOP' },
      { index: 1, content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'AAAA' } }] }, finishReason: 'MAX_TOKENS' },
    ] }), { headers: { 'Content-Type': 'application/json' } });
    const result = await transformResponseIn(await transformResponseOut(upstream, 'gemini'));
    const parsed = await result.json();
    expect(parsed.candidates.map((candidate: { index: number }) => candidate.index)).toEqual([0, 1]);
    expect(parsed.candidates[1]).toMatchObject({
      finishReason: 'MAX_TOKENS', content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'AAAA' } }] },
    });
  });
});

describe('Gemini terminal failures', () => {
  it('reports malformed upstream tool calls as stream errors, not completed turns', async () => {
    const output = await transformResponseOut(sseResponse([
      'data:{"responseId":"r","modelVersion":"gemini-3-flash","candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}\n\n',
    ]), 'gemini');
    const wire = await output.text();
    expect(wire).toContain('"type":"upstream_generation_error"');
    expect(wire).toContain('MALFORMED_FUNCTION_CALL');
    expect(wire).not.toContain('[DONE]');
    expect(wire).not.toContain('"finish_reason":"stop"');
  });

  it('propagates malformed SSE payloads instead of silently dropping a tool call', async () => {
    const output = await transformResponseIn(sseResponse(['data:{"choices":\n\n']));
    await expect(output.text()).rejects.toThrow('Invalid upstream SSE JSON');
  });
});
