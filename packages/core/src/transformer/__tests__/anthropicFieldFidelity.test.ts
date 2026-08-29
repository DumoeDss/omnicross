/**
 * Field-fidelity tests for the R7 hub fields (`claude-api-transform-fidelity`,
 * §11.4 rows 1/2 + last row): stop/top_p reach OpenAI-chat upstreams via the
 * blacklist passthrough; top_k/metadata_user_id map-or-audit per target;
 * Gemini gets conditional generationConfig keys; the Anthropic builder
 * backfills symmetrically; absent fields change NOTHING; and the
 * `_transformWarnings` channel never serializes into any upstream body.
 *
 * @module transformer/__tests__/anthropicFieldFidelity.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider, TransformerContext, UnifiedChatRequest } from '../types';
import { transformAnthropicRequestToUnified } from '../transformers/AnthropicConversion';
import { buildAnthropicRequestBody } from '../transformers/AnthropicRequestBuilder';
import { OpenAIResponseTransformer } from '../transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../transformers/OpenAITransformer';
import { buildRequestBody as buildGeminiRequestBody } from '../transformers/utils/gemini.util';
import {
  __resetDroppedFieldCountsForTests,
  droppedFieldCounts,
} from '../transformWarnings';

const provider = { baseUrl: 'https://x/v1', apiKey: 'k', models: ['m'] } as unknown as LLMProvider;
const context = {} as TransformerContext;

function anthropicRequest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-x',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  };
}

function decode(over: Record<string, unknown> = {}): UnifiedChatRequest {
  return transformAnthropicRequestToUnified(anthropicRequest(over));
}

beforeEach(() => {
  __resetDroppedFieldCountsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('decoder captures the R7 hub fields', () => {
  it('stop_sequences→stop, top_p, top_k, metadata.user_id', () => {
    const unified = decode({
      stop_sequences: ['END', 'STOP'],
      top_p: 0.5,
      top_k: 40,
      metadata: { user_id: 'user-123' },
    });
    expect(unified.stop).toEqual(['END', 'STOP']);
    expect(unified.top_p).toBe(0.5);
    expect(unified.top_k).toBe(40);
    expect(unified.metadata_user_id).toBe('user-123');
  });

  it('absent fields stay undefined (zero-regression ground truth)', () => {
    const unified = decode();
    expect(unified.stop).toBeUndefined();
    expect(unified.top_p).toBeUndefined();
    expect(unified.top_k).toBeUndefined();
    expect(unified.metadata_user_id).toBeUndefined();
    expect((unified as unknown as Record<string, unknown>)._transformWarnings).toBeUndefined();
  });

  it('assistant thinking blocks concatenate IN ORDER with redacted placeholders', () => {
    const unified = decode({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'part-a', signature: 'sig1' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'thinking', thinking: 'part-b' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: 'next' },
      ],
    });
    const assistant = unified.messages.find((m) => m.role === 'assistant');
    expect(assistant?.thinking?.content).toBe(
      'part-a\n[redacted thinking omitted]\npart-b',
    );
    expect(assistant?.thinking?.signature).toBe('sig1');
    expect(droppedFieldCounts['redacted_thinking\0unified']).toBe(1);
  });

  it('a single thinking block is unchanged (regression)', () => {
    const unified = decode({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'only', signature: 'sig' }],
        },
      ],
    });
    const assistant = unified.messages.find((m) => m.role === 'assistant');
    expect(assistant?.thinking).toEqual({ content: 'only', signature: 'sig' });
    expect(droppedFieldCounts['redacted_thinking\0unified']).toBeUndefined();
  });
});

describe('OpenAI-chat encoder (blacklist passthrough + map-or-audit)', () => {
  it('stop and top_p reach the upstream body untouched', async () => {
    const transformer = new OpenAITransformer();
    const body = (await transformer.transformRequestIn(decode({
      stop_sequences: ['END'],
      top_p: 0.25,
    }), provider, context)) as Record<string, unknown>;
    expect(body['stop']).toEqual(['END']);
    expect(body['top_p']).toBe(0.25);
  });

  it('metadata_user_id maps to body.user; top_k dropped + audited (no value anywhere)', async () => {
    const transformer = new OpenAITransformer();
    const request = decode({ top_k: 40, metadata: { user_id: 'user-9' } });
    const body = (await transformer.transformRequestIn(request, provider, context)) as Record<string, unknown>;
    expect(body['user']).toBe('user-9');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('metadata_user_id');
    expect(droppedFieldCounts['top_k\0openai-chat']).toBe(1);
    // The audit channel + warning text never carry values.
    expect(JSON.stringify(body)).not.toContain('40');
    const warnings = (request as unknown as { _transformWarnings?: Array<{ field: string }> })
      ._transformWarnings ?? [];
    expect(warnings).toEqual([{ field: 'top_k', target: 'openai-chat' }]);
    expect(body).not.toHaveProperty('_transformWarnings');
  });

  it('a request without the hub fields produces a body with none of them', async () => {
    const transformer = new OpenAITransformer();
    const body = (await transformer.transformRequestIn(decode(), provider, context)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('_transformWarnings');
  });
});

describe('Responses encoder (top_p mapped; stop/top_k/metadata audited)', () => {
  it('maps top_p and drops the rest with per-field audit entries', async () => {
    const transformer = new OpenAIResponseTransformer();
    const request = decode({
      stop_sequences: ['END'],
      top_p: 0.5,
      top_k: 40,
      metadata: { user_id: 'u1' },
    });
    const result = await transformer.transformRequestIn(request, provider, context);
    const body = result.body as Record<string, unknown>;
    expect(body['top_p']).toBe(0.5);
    expect(body).not.toHaveProperty('stop');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('user');
    expect(droppedFieldCounts['stop\0openai-responses']).toBe(1);
    expect(droppedFieldCounts['top_k\0openai-responses']).toBe(1);
    expect(droppedFieldCounts['metadata_user_id\0openai-responses']).toBe(1);
  });

  it('absent fields → no top_p key (zero regression)', async () => {
    const transformer = new OpenAIResponseTransformer();
    const result = await transformer.transformRequestIn(decode(), provider, context);
    expect(result.body).not.toHaveProperty('top_p');
  });
});

describe('Gemini builder (conditional generationConfig)', () => {
  it('maps stop→stopSequences, top_p→topP, top_k→topK', () => {
    const body = buildGeminiRequestBody(decode({
      stop_sequences: ['END'],
      top_p: 0.5,
      top_k: 40,
    }));
    expect(body.generationConfig).toMatchObject({
      stopSequences: ['END'],
      topP: 0.5,
      topK: 40,
    });
  });

  it('absent fields → no generationConfig keys beyond the existing ones', () => {
    const body = buildGeminiRequestBody(decode({ max_tokens: 10 }));
    expect(body.generationConfig).toEqual({ maxOutputTokens: 10 });
    const bare = buildGeminiRequestBody({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    });
    expect(bare.generationConfig).toBeUndefined();
  });

  it('metadata_user_id is audited, never serialized', () => {
    const request = decode({ metadata: { user_id: 'u1' } });
    const body = buildGeminiRequestBody(request);
    expect(JSON.stringify(body)).not.toContain('u1');
    expect(droppedFieldCounts['metadata_user_id\0gemini']).toBe(1);
  });
});

describe('Anthropic builder (symmetric backfill)', () => {
  it('returns the four fields to their Anthropic spellings', () => {
    const body = buildAnthropicRequestBody(decode({
      stop_sequences: ['END'],
      top_p: 0.5,
      top_k: 40,
      metadata: { user_id: 'u1' },
    })) as Record<string, unknown>;
    expect(body['stop_sequences']).toEqual(['END']);
    expect(body['top_p']).toBe(0.5);
    expect(body['top_k']).toBe(40);
    expect(body['metadata']).toEqual({ user_id: 'u1' });
  });

  it('absent fields → no keys (zero regression)', () => {
    const body = buildAnthropicRequestBody(decode()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('stop_sequences');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body).not.toHaveProperty('metadata');
  });
});
