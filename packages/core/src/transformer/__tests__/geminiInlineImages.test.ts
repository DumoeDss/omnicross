/**
 * geminiInlineImages — chat-inline-images (multi-provider-image-generation
 * group 5) unit coverage on the SHARED gemini seam plus the Anthropic face's
 * honest drop:
 *
 *   1. `gemini.stream.ts` JSON + SSE paths keep `inlineData` parts as
 *      `message.images` / `delta.images` data-URL arrays (one delta per source
 *      chunk, multi-image chunks merged).
 *   2. Pure-text traffic is BYTE-IDENTICAL to the pre-images output — no
 *      `images` key is emitted anywhere (the zero-regression hard constraint).
 *   3. `gemini.util.ts buildRequestBody` injects
 *      `generationConfig.responseModalities: ['TEXT','IMAGE']` for canonical
 *      gemini image model ids (contains `-image`), coexisting with
 *      thinkingConfig; non-image models build the same body as before.
 *   4. The Anthropic Messages face (`convertOpenAIResponseToAnthropic` /
 *      `convertOpenAIStreamToAnthropic`) DROPS images with a bounded count
 *      (observable counter; no image data in output or logs).
 *
 * @module transformer/__tests__/geminiInlineImages.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { convertOpenAIResponseToAnthropic } from '../transformers/AnthropicResponseConversion';
import { convertOpenAIStreamToAnthropic } from '../transformers/AnthropicOpenAIToAnthropicStream';
import { transformResponseOut } from '../transformers/utils/gemini.stream';
import { buildRequestBody } from '../transformers/utils/gemini.util';
import {
  __resetAnthropicDroppedImageCountForTests,
  anthropicDroppedImageCount,
} from '../transformers/utils/anthropicImageDrop';
import type { UnifiedChatRequest } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a text/event-stream Response from raw SSE frame strings. */
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

function geminiJson(parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    responseId: 'img-1',
    modelVersion: 'gemini-2.5-flash-image',
    candidates: [{ content: { parts }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  });
}

function baseRequest(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'gemini-2.5-flash-image',
    messages: [{ role: 'user', content: 'draw a cat' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. JSON path — inlineData → message.images
// ---------------------------------------------------------------------------

describe('transformResponseOut JSON: inlineData → message.images', () => {
  it('carries one inlineData part as a data URL alongside the text', async () => {
    const upstream = new Response(
      geminiJson([
        { text: 'Here is your cat' },
        { inlineData: { mimeType: 'image/png', data: 'aVNBRw==' } },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const out = await transformResponseOut(upstream, 'gemini');
    const parsed = await out.json();
    const message = parsed.choices[0].message;

    expect(message.content).toBe('Here is your cat');
    expect(message.images).toEqual(['data:image/png;base64,aVNBRw==']);
  });

  it('keeps multiple inlineData parts as an ordered array', async () => {
    const upstream = new Response(
      geminiJson([
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        { text: 'two variants' },
        { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const out = await transformResponseOut(upstream, 'gemini');
    const parsed = await out.json();
    expect(parsed.choices[0].message.images).toEqual([
      'data:image/png;base64,AAAA',
      'data:image/jpeg;base64,BBBB',
    ]);
    expect(parsed.choices[0].message.content).toBe('two variants');
  });

  it('accepts snake_case inline_data with mime_type (relay dialect)', async () => {
    const upstream = new Response(
      geminiJson([{ inline_data: { mime_type: 'image/webp', data: 'CCCC' } }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const out = await transformResponseOut(upstream, 'gemini');
    const parsed = await out.json();
    expect(parsed.choices[0].message.images).toEqual(['data:image/webp;base64,CCCC']);
  });

  it('zero-regression: pure-text JSON output has NO images key anywhere', async () => {
    const upstream = new Response(geminiJson([{ text: 'just words' }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const out = await transformResponseOut(upstream, 'gemini');
    const raw = await out.text();
    expect(raw).not.toContain('images');
    const parsed = JSON.parse(raw);
    expect(parsed.choices[0].message.content).toBe('just words');
    expect(parsed.choices[0].message).not.toHaveProperty('images');
  });

  it('skips inlineData parts without usable payload', async () => {
    const upstream = new Response(
      geminiJson([{ text: 'no image after all' }, { inlineData: { mimeType: 'image/png' } }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const out = await transformResponseOut(upstream, 'gemini');
    const parsed = await out.json();
    expect(parsed.choices[0].message).not.toHaveProperty('images');
    expect(parsed.choices[0].message.content).toBe('no image after all');
  });
});

// ---------------------------------------------------------------------------
// 2. SSE path — inlineData → delta.images
// ---------------------------------------------------------------------------

describe('transformResponseOut SSE: inlineData → delta.images', () => {
  it('merges ALL images of one chunk into a single delta', async () => {
    const frames = [
      `data: ${geminiJson([
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
        { inlineData: { mimeType: 'image/png', data: 'BBBB' } },
      ])}\n\n`,
    ];
    const out = await transformResponseOut(sseResponse(frames), 'gemini');
    const events = await drainSseEvents(out);

    const imageDeltas = events.filter((e) => Array.isArray(e.choices?.[0]?.delta?.images));
    expect(imageDeltas).toHaveLength(1);
    expect(imageDeltas[0].choices[0].delta.images).toEqual([
      'data:image/png;base64,AAAA',
      'data:image/png;base64,BBBB',
    ]);
  });

  it('emits independent deltas for image chunks in separate chunks', async () => {
    const frames = [
      `data: ${geminiJson([{ text: 'first' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }])}\n\n`,
      `data: ${geminiJson([{ inlineData: { mimeType: 'image/png', data: 'BBBB' } }])}\n\n`,
    ];
    const out = await transformResponseOut(sseResponse(frames), 'gemini');
    const events = await drainSseEvents(out);

    const imageDeltas = events.filter((e) => Array.isArray(e.choices?.[0]?.delta?.images));
    expect(imageDeltas).toHaveLength(2);
    expect(imageDeltas[0].choices[0].delta.images).toEqual(['data:image/png;base64,AAAA']);
    expect(imageDeltas[1].choices[0].delta.images).toEqual(['data:image/png;base64,BBBB']);
    // The text of the first chunk flowed too (before its image).
    const textDeltas = events.filter((e) => typeof e.choices?.[0]?.delta?.content === 'string');
    expect(textDeltas.at(-1).choices[0].delta.content).toBe('first');
  });

  it('attaches finish_reason + usage to an image-only FINAL chunk', async () => {
    const frames = [
      `data: ${geminiJson([{ text: 'rendering…' }])}\n\n`,
      `data: ${JSON.stringify({
        responseId: 'img-1',
        modelVersion: 'gemini-2.5-flash-image',
        candidates: [
          {
            content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 120, totalTokenCount: 125 },
      })}\n\n`,
    ];
    const out = await transformResponseOut(sseResponse(frames), 'gemini');
    const events = await drainSseEvents(out);

    const imageDelta = events.find((e) => Array.isArray(e.choices?.[0]?.delta?.images));
    expect(imageDelta).toBeDefined();
    expect(imageDelta.choices[0].finish_reason).toBe('stop');
    expect(imageDelta.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 120 });
  });

  it('zero-regression: pure-text SSE output has NO images key in any event', async () => {
    const frames = [
      `data: ${geminiJson([{ text: 'hello' }])}\n\n`,
      `data: ${geminiJson([{ text: 'world', thought: true }])}\n\n`,
      `data: ${geminiJson([{ functionCall: { id: 'c1', name: 'draw', args: {} } }])}\n\n`,
    ];
    const out = await transformResponseOut(sseResponse(frames), 'gemini');
    const events = await drainSseEvents(out);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain('images');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. buildRequestBody — responseModalities injection for image models
// ---------------------------------------------------------------------------

describe('buildRequestBody: responseModalities injection', () => {
  it('injects [TEXT, IMAGE] for an image model and coexists with thinkingConfig', () => {
    const body = buildRequestBody(baseRequest({
      model: 'gemini-3.1-flash-image',
      reasoning: { effort: 'high', enabled: true },
    }));

    expect(body.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
    // Coexistence (spec scenario): thinking config is not displaced — the image
    // model is not in the canonical thinking-levels registry, so reasoning
    // resolves to a BUDGET; either shape satisfies coexistence.
    const thinking = body.generationConfig?.thinkingConfig;
    expect(thinking).toBeDefined();
    expect(thinking?.includeThoughts).toBe(true);
    expect(
      thinking?.thinkingLevel !== undefined || thinking?.thinkingBudget !== undefined,
    ).toBe(true);
  });

  it('injects for canonical ids that CONTAIN -image (gemini-3-pro-image-preview)', () => {
    const body = buildRequestBody(baseRequest({ model: 'gemini-3-pro-image-preview' }));
    expect(body.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
  });

  it('zero-regression: a normal gemini model body has NO responseModalities', () => {
    const body = buildRequestBody(baseRequest({
      model: 'gemini-2.5-pro',
      reasoning: { effort: 'high', enabled: true },
    }));
    expect(JSON.stringify(body)).not.toContain('responseModalities');
    expect(body.generationConfig?.thinkingConfig).toBeDefined();
  });

  it('does not inject for non-gemini ids containing -image (gpt-image-2)', () => {
    const body = buildRequestBody(baseRequest({ model: 'gpt-image-2' }));
    expect(JSON.stringify(body)).not.toContain('responseModalities');
  });
});

// ---------------------------------------------------------------------------
// 4. Anthropic face — honest drop with a bounded count
// ---------------------------------------------------------------------------

describe('Anthropic face: images dropped with a bounded count', () => {
  afterEach(() => {
    __resetAnthropicDroppedImageCountForTests();
    vi.restoreAllMocks();
  });

  it('non-stream: drops message.images, keeps text, no base64 in output, counts', () => {
    const before = anthropicDroppedImageCount;
    const result = convertOpenAIResponseToAnthropic({
      id: 'chatcmpl-img',
      model: 'gemini-2.5-flash-image',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Here is your cat',
            images: ['data:image/png;base64,aVNBRw==', 'data:image/png;base64,QkFB'],
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    // Text survived as the only content kind.
    expect(result.content).toEqual([{ type: 'text', text: 'Here is your cat' }]);
    // NO image data leaked into the Anthropic wire body.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('aVNBRw==');
    // The drop is counted (2 images).
    expect(anthropicDroppedImageCount).toBe(before + 2);
  });

  it('non-stream: no images → no count, no warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = anthropicDroppedImageCount;
    convertOpenAIResponseToAnthropic({
      id: 'x',
      model: 'm',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    });
    expect(anthropicDroppedImageCount).toBe(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stream: drops delta.images, keeps text deltas, counts every image, warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetAnthropicDroppedImageCountForTests();
    const frames = [
      'data: {"id":"1","model":"gemini-2.5-flash-image","choices":[{"index":0,"delta":{"role":"assistant","content":"Here"}}]}\n\n',
      'data: {"id":"1","model":"gemini-2.5-flash-image","choices":[{"index":0,"delta":{"images":["data:image/png;base64,QQ==","data:image/png;base64,Qg=="]}}]}\n\n',
      'data: {"id":"1","model":"gemini-2.5-flash-image","choices":[{"index":0,"delta":{"images":["data:image/png;base64,Qw=="]}}]}\n\n',
      'data: {"id":"1","model":"gemini-2.5-flash-image","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    ];
    const upstream = sseResponse(frames);

    const stream = convertOpenAIStreamToAnthropic(upstream.body! as ReadableStream<Uint8Array>);
    const text = await new Promise<string>((resolve, reject) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              resolve(acc);
              return;
            }
            acc += decoder.decode(value, { stream: true });
            pump();
          })
          .catch(reject);
      };
      pump();
    });

    // Text survived; images did not leak into any event.
    expect(text).toContain('"text_delta"');
    expect(text).toContain('Here');
    expect(text).not.toContain('data:image');
    expect(text).not.toContain('QQ==');
    // Counted every image across BOTH image chunks (2 + 1)…
    expect(anthropicDroppedImageCount).toBe(3);
    // …but the bounded log fired only ONCE for the whole stream.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('QQ==');
  });
});
