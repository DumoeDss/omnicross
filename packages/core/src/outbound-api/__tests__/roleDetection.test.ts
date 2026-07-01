/**
 * Unit tests for request-role detection (`outbound-api-server`).
 * Covers background/small-tier detection, the per-endpoint background-model-id
 * override, and the background > default precedence. Vision was removed with the
 * model-kind-mapping reshape (kind-mapped endpoints classify in kindDetection).
 */
import { describe, expect, it } from 'vitest';

import { detectRequestRole, endpointToIngressFormat, isBackgroundTierModel } from '../roleDetection';

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

  it('a small-tier requested model → background', () => {
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

describe('detectRequestRole — default', () => {
  it('plain request → default', () => {
    const body = { model: 'claude-opus-4', messages: [{ role: 'user', content: 'hello' }] };
    expect(detectRequestRole('anthropic-messages', body)).toBe('default');
  });

  it('image content no longer forces a special role (vision removed) → default', () => {
    const body = {
      model: 'claude-opus-4',
      messages: [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'hi' }] }],
    };
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
