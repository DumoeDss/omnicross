/**
 * endpoints tests — OpenCodeGo URL building across 4 shapes × 2 halves.
 *
 * Covers the go-half byte-identity (no override), the four zen defaults, the
 * per-half base override interplay (`baseUrl` → go only, `zenBaseUrl` → zen only),
 * and the gemini BASE trailing-slash invariant the `gemini` transformer's
 * `new URL('./{model}:{action}', base)` depends on.
 */

import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeGoUrl,
  OPENCODEGO_ANTHROPIC_SHAPE_URL,
  OPENCODEGO_OPENAI_SHAPE_URL,
  OPENCODEGO_ZEN_ANTHROPIC_URL,
  OPENCODEGO_ZEN_CHAT_URL,
  OPENCODEGO_ZEN_GEMINI_BASE,
  OPENCODEGO_ZEN_RESPONSES_URL,
} from '../endpoints';

describe('buildOpenCodeGoUrl — defaults (no override)', () => {
  it('GO half is byte-identical to the existing constants', () => {
    expect(buildOpenCodeGoUrl('go', 'anthropic')).toBe(OPENCODEGO_ANTHROPIC_SHAPE_URL);
    expect(buildOpenCodeGoUrl('go', 'chat')).toBe(OPENCODEGO_OPENAI_SHAPE_URL);
    expect(buildOpenCodeGoUrl('go', 'anthropic')).toBe('https://opencode.ai/zen/go/v1/messages');
    expect(buildOpenCodeGoUrl('go', 'chat')).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('ZEN half resolves the four zen defaults', () => {
    expect(buildOpenCodeGoUrl('zen', 'anthropic')).toBe(OPENCODEGO_ZEN_ANTHROPIC_URL);
    expect(buildOpenCodeGoUrl('zen', 'chat')).toBe(OPENCODEGO_ZEN_CHAT_URL);
    expect(buildOpenCodeGoUrl('zen', 'responses')).toBe(OPENCODEGO_ZEN_RESPONSES_URL);
    expect(buildOpenCodeGoUrl('zen', 'gemini')).toBe(OPENCODEGO_ZEN_GEMINI_BASE);
    // Literal values mirror loader.go:22-25.
    expect(buildOpenCodeGoUrl('zen', 'anthropic')).toBe('https://opencode.ai/zen/v1/messages');
    expect(buildOpenCodeGoUrl('zen', 'chat')).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(buildOpenCodeGoUrl('zen', 'responses')).toBe('https://opencode.ai/zen/v1/responses');
    expect(buildOpenCodeGoUrl('zen', 'gemini')).toBe('https://opencode.ai/zen/v1/models/');
  });
});

describe('buildOpenCodeGoUrl — gemini base trailing slash (transformer URL resolution)', () => {
  it('gemini base ENDS in /v1/models/ (trailing slash load-bearing)', () => {
    const base = buildOpenCodeGoUrl('zen', 'gemini');
    expect(base.endsWith('/v1/models/')).toBe(true);
  });

  it("new URL('./{model}:generateContent', base) resolves to .../v1/models/{model}:generateContent", () => {
    const base = buildOpenCodeGoUrl('zen', 'gemini');
    const nonStream = new URL('./gemini-3-flash:generateContent', base).toString();
    expect(nonStream).toBe('https://opencode.ai/zen/v1/models/gemini-3-flash:generateContent');
    const stream = new URL('./gemini-3-flash:streamGenerateContent?alt=sse', base).toString();
    expect(stream).toBe(
      'https://opencode.ai/zen/v1/models/gemini-3-flash:streamGenerateContent?alt=sse',
    );
  });
});

describe('buildOpenCodeGoUrl — per-half override interplay', () => {
  it('override applies to GO half (preserving the /v1 path suffix)', () => {
    const host = 'https://my-go-host.example.com';
    expect(buildOpenCodeGoUrl('go', 'anthropic', host)).toBe(`${host}/v1/messages`);
    expect(buildOpenCodeGoUrl('go', 'chat', host)).toBe(`${host}/v1/chat/completions`);
  });

  it('override applies to ZEN half (all four shapes)', () => {
    const host = 'https://my-zen-host.example.com';
    expect(buildOpenCodeGoUrl('zen', 'anthropic', host)).toBe(`${host}/v1/messages`);
    expect(buildOpenCodeGoUrl('zen', 'chat', host)).toBe(`${host}/v1/chat/completions`);
    expect(buildOpenCodeGoUrl('zen', 'responses', host)).toBe(`${host}/v1/responses`);
    expect(buildOpenCodeGoUrl('zen', 'gemini', host)).toBe(`${host}/v1/models/`);
  });

  it('zen override + gemini still resolves a per-model URL correctly', () => {
    const host = 'https://my-zen-host.example.com';
    const base = buildOpenCodeGoUrl('zen', 'gemini', host);
    expect(base.endsWith('/v1/models/')).toBe(true);
    expect(new URL('./gemini-3-flash:generateContent', base).toString()).toBe(
      `${host}/v1/models/gemini-3-flash:generateContent`,
    );
  });

  it('normalizes an override host that already carries a /v1 suffix', () => {
    // The normalizer strips a trailing /v1[/...] so the shape path is appended cleanly.
    expect(buildOpenCodeGoUrl('zen', 'responses', 'https://h.example.com/v1')).toBe(
      'https://h.example.com/v1/responses',
    );
    expect(buildOpenCodeGoUrl('zen', 'responses', 'https://h.example.com/')).toBe(
      'https://h.example.com/v1/responses',
    );
  });
});
