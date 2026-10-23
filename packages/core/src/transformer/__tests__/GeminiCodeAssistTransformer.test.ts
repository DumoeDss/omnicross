/**
 * GeminiCodeAssistTransformer envelope tests — deterministic, no live network.
 *
 * Asserts:
 *  - `transformRequestIn` produces the exact Code Assist wrapper
 *    `{ model, project, user_prompt_id, request: <inner> }` where the inner
 *    `request` EQUALS the shared `buildRequestBody` output (delegation), the URL
 *    is the `v1internal:generateContent` / `:streamGenerateContent?alt=sse`
 *    colon-method endpoint (NO `/v1beta/models/...`), and the headers clear
 *    x-goog-api-key (Bearer-only, injected downstream by the auth strategy).
 *  - response unwrap (`.response`) round-trips to the existing gemini parser
 *    for BOTH non-stream JSON and SSE.
 */

import { describe, expect, it } from 'vitest';

import { GeminiCodeAssistTransformer } from '../transformers/GeminiCodeAssistTransformer';
import { AntigravityTransformer } from '../transformers/AntigravityTransformer';
import { unwrapCcaResponse } from '../transformers/ccaEnvelope';
import { buildRequestBody } from '../transformers/utils/gemini.util';
import type { LLMProvider, TransformerContext, UnifiedChatRequest } from '../types';

const ctx: TransformerContext = {};

function provider(geminiProject?: string): LLMProvider {
  return {
    name: 'gemini',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    apiKey: '',
    models: ['gemini-2.5-pro'],
    geminiProject,
  };
}

function baseRequest(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', content: 'Hello CA' }],
    ...overrides,
  };
}

describe('GeminiCodeAssistTransformer.transformRequestIn', () => {
  it('wraps the inner buildRequestBody output in the Code Assist envelope (non-stream)', async () => {
    const t = new GeminiCodeAssistTransformer();
    const request = baseRequest();
    const out = await t.transformRequestIn(request, provider('my-proj-123'), ctx);

    const body = (out as { body: Record<string, unknown> }).body;
    // Top-level envelope fields.
    expect(body.model).toBe('gemini-2.5-pro');
    expect(body.project).toBe('my-proj-123');
    expect(typeof body.user_prompt_id).toBe('string');
    expect((body.user_prompt_id as string).length).toBeGreaterThan(0);

    // Inner `request` EQUALS the shared buildRequestBody output (delegation).
    expect(body.request).toEqual(buildRequestBody(request));
    // `model` must NOT leak into the inner request.
    expect((body.request as Record<string, unknown>).model).toBeUndefined();
  });

  it('builds the v1internal:generateContent URL (non-stream, no /models path)', async () => {
    const t = new GeminiCodeAssistTransformer();
    const out = await t.transformRequestIn(baseRequest(), provider('p'), ctx);
    const url = (out as { config: { url: string } }).config.url;
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(url).not.toContain('/v1beta/models/');
    expect(url).not.toContain('gemini-2.5-pro'); // model is NOT in the path
  });

  it('builds the streamGenerateContent?alt=sse URL when stream=true', async () => {
    const t = new GeminiCodeAssistTransformer();
    const out = await t.transformRequestIn(baseRequest({ stream: true }), provider('p'), ctx);
    const url = (out as { config: { url: string } }).config.url;
    expect(url).toBe(
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    );
  });

  it('clears x-goog-api-key (Bearer-only auth, injected downstream)', async () => {
    const t = new GeminiCodeAssistTransformer();
    const out = await t.transformRequestIn(baseRequest(), provider('p'), ctx);
    const headers = (out as { config: { headers: Record<string, string | undefined> } }).config
      .headers;
    expect(headers['x-goog-api-key']).toBeUndefined();
    expect(headers['X-Goog-Api-Key']).toBeUndefined();
    // The transformer does NOT set an api key header itself.
    expect('x-goog-api-key' in headers).toBe(true); // present-as-undefined to UNSET it
  });

  it('carries the GeminiCLI masquerade identity on every request', async () => {
    const t = new GeminiCodeAssistTransformer();
    const out = await t.transformRequestIn(baseRequest({ model: 'gemini-2.5-pro' }), provider('p'), ctx);
    const headers = (out as { config: { headers: Record<string, string | undefined> } }).config
      .headers;
    expect(headers['User-Agent']).toMatch(/^GeminiCLI\/\d+\.\d+\.\d+\/gemini-2\.5-pro \((win32|darwin|linux); (x64|arm64); terminal\)$/);
    expect(headers['Client-Metadata']).toBe(
      'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
    );
  });

  it('leaves project undefined for a fresh free-tier account', async () => {
    const t = new GeminiCodeAssistTransformer();
    const out = await t.transformRequestIn(baseRequest(), provider(undefined), ctx);
    const body = (out as { body: Record<string, unknown> }).body;
    expect(body.project).toBeUndefined();
  });
});

describe('GeminiCodeAssistTransformer.transformResponseOut (envelope unwrap)', () => {
  it('peels .response from a non-stream JSON body before the gemini parser', async () => {
    const t = new GeminiCodeAssistTransformer();
    // A Code Assist non-stream body nests the standard GenerateContentResponse
    // under top-level `response`.
    const caBody = {
      response: {
        responseId: 'resp-1',
        modelVersion: 'gemini-2.5-pro',
        candidates: [
          {
            content: { parts: [{ text: 'hi from CA' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          totalTokenCount: 10,
        },
      },
    };
    const upstream = new Response(JSON.stringify(caBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await t.transformResponseOut(upstream, ctx);
    const parsed = (await result.json()) as Record<string, unknown>;
    // The shared gemini parser produced an OpenAI-compatible shape from the
    // UNWRAPPED candidates.
    const choices = parsed.choices as Array<{ message: { content: string } }>;
    expect(choices[0].message.content).toBe('hi from CA');
    const usage = parsed.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(7);
    expect(usage.completion_tokens).toBe(3);
    expect(usage.total_tokens).toBe(10);
  });

  it('peels .response from each SSE chunk before the gemini stream parser', async () => {
    const t = new GeminiCodeAssistTransformer();
    // Two Code Assist SSE chunks, each nesting GenerateContentResponse under `response`.
    const sse =
      `data: ${JSON.stringify({ response: { responseId: 'r', modelVersion: 'gemini-2.5-pro', candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] } })}\n\n` +
      `data: ${JSON.stringify({ response: { responseId: 'r', modelVersion: 'gemini-2.5-pro', candidates: [{ content: { parts: [{ text: 'world' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } } })}\n\n`;
    const upstream = new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const result = await t.transformResponseOut(upstream, ctx);
    const text = await result.text();
    // The gemini stream parser emits OpenAI chat.completion.chunk SSE with the
    // unwrapped content.
    expect(text).toContain('"content":"Hello "');
    expect(text).toContain('"content":"world"');
    expect(text).toContain('chat.completion.chunk');
  });

  it('decodes fragmented CRLF and multiline SSE events without joining separate events', async () => {
    const text = 'data: {"response":\r\ndata: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}}\r\n\r\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}]}}\r\n\r\n';
    const bytes = new TextEncoder().encode(text);
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    const result = await new GeminiCodeAssistTransformer().transformResponseOut(upstream, ctx);
    const events = (await result.text()).split('\n\n').filter((event) => event.startsWith('data: {'));
    const content = events.flatMap((event) => JSON.parse(event.slice(6)).choices ?? [])
      .map((choice) => choice.delta?.content ?? '').join('');
    expect(content).toBe('你好!');
  });

  it('preserves event boundaries for consumers that parse complete SSE frames', async () => {
    const upstream = new Response('data: {"response":{"candidates":[]}}\n\n' +
      'data: {"response":{"usageMetadata":{"totalTokenCount":7}}}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '999' },
    });
    const decoded = await unwrapCcaResponse(upstream);
    const events = (await decoded.text()).trim().split('\n\n');
    expect(events.map((event) => JSON.parse(event.slice(6)))).toEqual([
      { candidates: [] }, { usageMetadata: { totalTokenCount: 7 } },
    ]);
    expect(decoded.headers.has('content-length')).toBe(false);
  });

  it('rejects malformed JSON instead of turning it into a successful empty response', async () => {
    const transformer = new GeminiCodeAssistTransformer();
    await expect(transformer.transformResponseOut(new Response('{broken', {
      headers: { 'Content-Type': 'application/json' },
    }), ctx)).rejects.toThrow();
    await expect(transformer.transformResponseOut(Response.json({ response: null }), ctx))
      .rejects.toThrow('Invalid Code Assist response envelope');
  });

  it('keeps an outer error even when a response key is present', async () => {
    const error = { code: 403, status: 'PERMISSION_DENIED', message: 'project access denied' };
    const response = await unwrapCcaResponse(Response.json({ error, response: {} }, { status: 403 }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error, response: {} });
  });

  it('wraps endpoint SSE responses so they can be consumed as Code Assist events', async () => {
    const transformer = new GeminiCodeAssistTransformer();
    const input = [
      { id: 'r', model: 'gemini-2.5-pro', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
      { id: 'r', model: 'gemini-2.5-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const encoded = await transformer.transformResponseIn(new Response(input, {
      headers: { 'Content-Type': 'text/event-stream' },
    }), ctx);
    const events = (await encoded.text()).split('\n\n').filter((event) => event.startsWith('data: {'))
      .map((event) => JSON.parse(event.slice(6)));
    expect(events.length).toBeGreaterThan(0);
    const text = events.flatMap((event) => event.response.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? []).map((part) => part.text ?? '').join('');
    expect(text).toBe('Hello');
  });

  it.each([GeminiCodeAssistTransformer, AntigravityTransformer])(
    'surfaces nested JSON and SSE errors instead of successful empty completions (%s)',
    async (TransformerClass) => {
      const transformer = new TransformerClass();
      const error = { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exhausted' };
      const json = await transformer.transformResponseOut(Response.json({ response: { error } }), ctx);
      expect(await json.json()).toEqual({ error });
      const stream = await transformer.transformResponseOut(new Response(
        `data: ${JSON.stringify({ response: { error } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ), ctx);
      const text = await stream.text();
      expect(text).toContain('"error"');
      expect(text).toContain('quota exhausted');
      expect(text).not.toContain('chat.completion.chunk');
      expect(text).not.toContain('[DONE]');
    },
  );
});
