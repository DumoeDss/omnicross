/**
 * Unit tests for request-role detection (`outbound-api-server` task 8.9).
 * Covers vision content per format, background/small-tier, the per-endpoint
 * background-model-id override, and the vision > background > default precedence.
 */
import { describe, expect, it } from 'vitest';

import { detectRequestRole, endpointToIngressFormat, isBackgroundTierModel } from '../roleDetection';

describe('detectRequestRole — vision per format', () => {
  it('Anthropic image content → vision', () => {
    const body = {
      model: 'claude-opus-4',
      messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hi' }] }],
    };
    expect(detectRequestRole('anthropic-messages', body)).toBe('vision');
  });

  it('OpenAI Chat image_url content → vision', () => {
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    };
    expect(detectRequestRole('openai-chat', body)).toBe('vision');
  });

  it('OpenAI Responses input_image content → vision', () => {
    const body = {
      model: 'gpt-4o',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }],
    };
    expect(detectRequestRole('openai-responses', body)).toBe('vision');
  });

  it('Gemini inline_data / file_data → vision', () => {
    const inline = { model: 'gemini-2.5-pro', contents: [{ parts: [{ inline_data: { data: 'x' } }] }] };
    const file = { model: 'gemini-2.5-pro', contents: [{ parts: [{ file_data: { fileUri: 'x' } }] }] };
    expect(detectRequestRole('gemini-generatecontent', inline)).toBe('vision');
    expect(detectRequestRole('gemini-generatecontent', file)).toBe('vision');
  });
});

describe('detectRequestRole — background tier', () => {
  it('haiku / mini / flash / 8b model ids → background (token-boundary match)', () => {
    expect(isBackgroundTierModel('claude-3-5-haiku')).toBe(true);
    expect(isBackgroundTierModel('gpt-4o-mini')).toBe(true);
    expect(isBackgroundTierModel('gemini-2.0-flash')).toBe(true);
    expect(isBackgroundTierModel('llama-3.1-8b-instruct')).toBe(true);
    expect(isBackgroundTierModel('claude-opus-4')).toBe(false);
  });

  it('m5: does NOT over-match large models that merely CONTAIN a tier token as a substring', () => {
    // `flashy`, `litellm`, `nanogpt`, `minixl` all contain a tier fragment as a
    // substring but are NOT standalone tier tokens — must classify as default.
    expect(isBackgroundTierModel('gpt-flashy-pro')).toBe(false);
    expect(isBackgroundTierModel('litellm-router-large')).toBe(false);
    expect(isBackgroundTierModel('nanogpt-xl')).toBe(false);
    expect(isBackgroundTierModel('minixl-ultra')).toBe(false);
    // publisher prefix is stripped; a publisher named `flash-labs` must not trip it.
    expect(isBackgroundTierModel('flash-labs/big-model-pro')).toBe(false);
  });

  it('a small-tier requested model → background (no vision)', () => {
    const body = { model: 'claude-3-5-haiku', messages: [{ role: 'user', content: 'probe' }] };
    expect(detectRequestRole('anthropic-messages', body)).toBe('background');
  });

  it('per-endpoint backgroundModelIds override forces background', () => {
    // A model that is NOT small-tier by name, but is in the override list.
    const body = { model: 'my-custom-router', messages: [{ role: 'user', content: 'x' }] };
    expect(detectRequestRole('anthropic-messages', body)).toBe('default');
    expect(
      detectRequestRole('anthropic-messages', body, { backgroundModelIds: ['my-custom-router'] }),
    ).toBe('background');
    // Also accepts a `providerId,modelId` ref form in the override list.
    expect(
      detectRequestRole('anthropic-messages', body, {
        backgroundModelIds: ['someprovider,my-custom-router'],
      }),
    ).toBe('background');
  });
});

describe('detectRequestRole — precedence + default', () => {
  it('vision wins over a background model id', () => {
    const body = {
      model: 'claude-3-5-haiku',
      messages: [{ role: 'user', content: [{ type: 'image' }] }],
    };
    expect(detectRequestRole('anthropic-messages', body)).toBe('vision');
  });

  it('plain request → default', () => {
    const body = { model: 'claude-opus-4', messages: [{ role: 'user', content: 'hello' }] };
    expect(detectRequestRole('anthropic-messages', body)).toBe('default');
  });
});

describe('endpointToIngressFormat', () => {
  it('maps the four endpoints to their ingress formats', () => {
    expect(endpointToIngressFormat('chat')).toBe('openai-chat');
    expect(endpointToIngressFormat('responses')).toBe('openai-responses');
    expect(endpointToIngressFormat('messages')).toBe('anthropic-messages');
    expect(endpointToIngressFormat('gemini')).toBe('gemini-generatecontent');
  });
});
