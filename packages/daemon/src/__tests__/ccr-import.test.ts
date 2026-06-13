/**
 * ccr-import.test.ts — CCR → omnicross config mapping assertions (design D9).
 *
 * Asserts the pure `parseCcrConfig` + `mapCcrToOmnicross` translation:
 *  - providers carried over (with inferred apiFormat),
 *  - Router roles folded: think/longContext → default, image → vision,
 *  - webSearch DROPPED + recorded as a note.
 */

import { describe, expect, it } from 'vitest';

import { mapCcrToOmnicross, parseCcrConfig } from '../ccr-import';

const SAMPLE_CCR = {
  Providers: [
    {
      name: 'openrouter',
      api_base_url: 'https://openrouter.ai/api/v1',
      api_key: 'sk-or-xxx',
      models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'],
    },
    {
      name: 'anthropic',
      api_base_url: 'https://api.anthropic.com',
      api_key: 'sk-ant-xxx',
      models: ['claude-3-5-sonnet'],
    },
    {
      name: 'gemini-cli',
      api_base_url: 'https://generativelanguage.googleapis.com',
      api_key: 'AIza-xxx',
      models: ['gemini-1.5-pro'],
    },
    {
      // No recognizable host → ambiguous → openai default + note.
      name: 'mystery',
      api_base_url: 'https://example.com/proxy',
      api_key: 'k',
      models: [],
    },
  ],
  Router: {
    default: 'openrouter,anthropic/claude-3.5-sonnet',
    background: 'openrouter,openai/gpt-4o',
    think: 'openrouter,anthropic/claude-3.5-sonnet',
    longContext: 'openrouter,anthropic/claude-3.5-sonnet',
    longContextThreshold: 60000,
    image: 'gemini-cli,gemini-1.5-pro',
    webSearch: 'gemini-cli,gemini-1.5-pro',
    forceUseImageAgent: true,
  },
};

describe('CCR import', () => {
  const ccr = parseCcrConfig(SAMPLE_CCR);
  const { config, notes } = mapCcrToOmnicross(ccr);

  it('carries over every named provider with an inferred apiFormat', () => {
    expect(config.providers).toHaveLength(4);
    const byId = Object.fromEntries(config.providers.map((p) => [p.id, p]));
    expect(byId['openrouter'].apiFormat).toBe('openai');
    expect(byId['openrouter'].baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(byId['openrouter'].apiKey).toBe('sk-or-xxx');
    expect(byId['anthropic'].apiFormat).toBe('anthropic');
    expect(byId['gemini-cli'].apiFormat).toBe('gemini');
    // Unrecognizable host → defaults to openai (ambiguous).
    expect(byId['mystery'].apiFormat).toBe('openai');
  });

  it('notes the ambiguous apiFormat inference', () => {
    expect(notes.some((n) => n.includes("'mystery'") && n.includes('openai'))).toBe(true);
  });

  it('folds think and longContext into default (notes recorded)', () => {
    expect(notes.some((n) => n.includes('think') && n.includes('default'))).toBe(true);
    expect(
      notes.some((n) => n.includes('longContext') && n.includes('default')),
    ).toBe(true);
  });

  it('maps image → vision (forceUseImageAgent dropped, noted)', () => {
    expect(notes.some((n) => n.includes('image') && n.includes('vision'))).toBe(true);
  });

  it('DROPS webSearch and records a note', () => {
    expect(notes.some((n) => n.includes('webSearch') && /drop/i.test(n))).toBe(true);
  });

  it('skips a provider with no name', () => {
    const { config: c2, notes: n2 } = mapCcrToOmnicross(
      parseCcrConfig({ Providers: [{ api_base_url: 'https://x/v1' }], Router: {} }),
    );
    expect(c2.providers).toHaveLength(0);
    expect(n2.some((n) => /no name/i.test(n))).toBe(true);
  });
});
