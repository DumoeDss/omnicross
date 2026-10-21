import { describe, expect, it } from 'vitest';

import { parseProviderInput } from '../admin/adminApi';
import { validateConfig } from '../config';
import { listMappablePresets } from '../preset-map';

const row = { id: 'logjev', apiFormat: 'openai', baseUrl: 'https://example.test/v1', apiKey: '', models: ['model'], category: 'other' };
const settings = { kind: 'chat', promptMode: 'minimal', concurrency: 2, topk: 10, extraBody: { chat_template_kwargs: { enable_thinking: false } } };

describe('LogJev provider configuration', () => {
  it.each(['logjev', 'logjev-openrouter', 'openrouter-decisions'])('round-trips %s settings through file validation and admin writes', (id) => {
    const provider = { ...row, id };
    const config = validateConfig({ providers: [{ ...provider, logjev: settings }] });
    expect(config.providers[0].id).toBe(id);
    expect(config.providers[0].category).toBe('other');
    expect(config.providers[0].logjev).toEqual(settings);
    expect(parseProviderInput({ ...provider, logjev: settings }, undefined)?.logjev).toEqual(settings);
    expect(parseProviderInput(provider, config.providers[0])?.logjev).toEqual(settings);
    expect(parseProviderInput({ ...provider, logjev: null }, config.providers[0])?.logjev).toBeUndefined();
  });
  it('rejects invalid mode and credentials in nonsecret model options', () => {
    expect(() => validateConfig({ providers: [{ ...row, logjev: { kind: 'auto' } }] })).toThrow('logjev.kind');
    expect(parseProviderInput({ ...row, logjev: { ...settings, extraBody: { apiKey: 'fixture-key' } } }, undefined)).toBeNull();
  });
  it('offers OpenRouter Decisions in place of the retired logjev-openrouter preset', () => {
    const { mappable } = listMappablePresets();
    expect(mappable.find(p => p.id === 'jev')?.logjev?.kind).toBe('jev');
    expect(mappable.find(p => p.id === 'logjev')?.logjev?.kind).toBe('chat');
    // OpenRouter preset: native kind by default — the client routes it to
    // OpenRouter's /api/alpha/decisions (isOpenRouterUpstream).
    const openrouter = mappable.find(p => p.id === 'openrouter-decisions');
    expect(openrouter?.category).toBe('other');
    expect(openrouter?.logjev?.kind).toBe('jev');
    expect(openrouter?.models).toContain('typesafe/jev-1.14');
    expect(mappable.find(p => p.id === 'logjev-openrouter')).toBeUndefined();
    // The open-jev PRESET is gone; already-configured open-jev provider rows
    // keep working (jevSystemone's row fallback), but the catalog no longer
    // offers it.
    expect(mappable.find(p => p.id === 'open-jev')).toBeUndefined();
  });
});
