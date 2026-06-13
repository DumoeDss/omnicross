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
});
