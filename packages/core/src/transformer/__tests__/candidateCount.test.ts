import { describe, expect, it } from 'vitest';
import { convertOpenAIToAnthropic } from '../../api-converter/openai-to-anthropic';
import type { UnifiedChatRequest } from '../types';
import { AnthropicTransformer } from '../transformers/AnthropicTransformer';
import { GeminiTransformer } from '../transformers/GeminiTransformer';
import { OpenAITransformer } from '../transformers/OpenAITransformer';
import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';

const provider = { name: 'local', baseUrl: 'https://example.invalid/v1', apiKey: 'not-used', models: ['gemini-2.5-flash'] };
const request: UnifiedChatRequest = { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'two alternatives' }], n: 2 };

describe('alternative candidate semantics', () => {
  it('carries Chat n and Gemini candidateCount in both request directions', async () => {
    const gemini = new GeminiTransformer();
    expect(await gemini.transformRequestIn(request, provider, {})).toMatchObject({ body: { generationConfig: { candidateCount: 2 } } });
    const decoded = await gemini.transformRequestOut({ model: request.model, contents: [{ role: 'user', parts: [{ text: 'two alternatives' }] }], generationConfig: { candidateCount: 2 } }, {});
    expect(await new OpenAITransformer().transformRequestIn(decoded, provider, {})).toMatchObject({ n: 2 });
  });

  it('does not silently drop the independent converter request count', () => {
    expect(() => convertOpenAIToAnthropic({ model: request.model, n: 2, messages: [{ role: 'user', content: 'two alternatives' }] }, { defaultModel: request.model })).toThrow(/only one candidate/);
  });

  for (const encoder of [new AnthropicTransformer(), new OpenAIResponseTransformer()]) {
    it(`${encoder.name} rejects multiple alternatives before upstream encoding`, async () => {
      await expect(encoder.transformRequestIn(request, provider, {})).rejects.toMatchObject({ status: 400, code: 'unsupported_capability' });
    });

    it(`${encoder.name} rejects an unsolicited multi-choice JSON response`, async () => {
      const response = new Response(JSON.stringify({ choices: [0, 1].map(index => ({ index, message: { role: 'assistant', content: `choice ${index}` }, finish_reason: 'stop' })) }), { headers: { 'Content-Type': 'application/json' } });
      await expect(encoder.transformResponseIn(response, {})).rejects.toThrow(/Multiple Chat candidates/);
    });

    it(`${encoder.name} does not mark a second SSE candidate as one successful result`, async () => {
      const response = new Response([0, 1].map(index => `data: ${JSON.stringify({ choices: [{ index, delta: { content: `choice ${index}` }, finish_reason: 'stop' }] })}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      const converted = await encoder.transformResponseIn(response, {});
      const result = await converted.text().then(body => ({ body }), (error: unknown) => ({ error }));
      if ('error' in result) {
        expect(String(result.error)).toMatch(/Multiple Chat candidates/);
      } else {
        expect(result.body).toMatch(/Multiple Chat candidates/);
        expect(result.body).not.toMatch(/"type":"(?:message_stop|response.completed)"/);
      }
    });
  }
});
