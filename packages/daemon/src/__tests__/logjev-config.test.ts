import { describe, expect, it } from 'vitest';

import { parseProviderInput } from '../admin/adminApi';
import { validateConfig } from '../config';
import { listMappablePresets } from '../preset-map';

const row = { id: 'logjev', apiFormat: 'openai', baseUrl: 'https://example.test/v1', apiKey: '', models: ['model'], category: 'other' };
const settings = { kind: 'chat', promptMode: 'minimal', concurrency: 2, topk: 10, extraBody: { chat_template_kwargs: { enable_thinking: false } } };

describe('LogJev provider configuration', () => {
  it('round-trips settings through file validation and admin writes', () => {
    const config = validateConfig({ providers: [{ ...row, logjev: settings }] });
    expect(config.providers[0].logjev).toEqual(settings);
    expect(parseProviderInput({ ...row, logjev: settings }, undefined)?.logjev).toEqual(settings);
    expect(parseProviderInput(row, config.providers[0])?.logjev).toEqual(settings);
    expect(parseProviderInput({ ...row, logjev: null }, config.providers[0])?.logjev).toBeUndefined();
  });
  it('rejects invalid mode and credentials in nonsecret model options', () => {
    expect(() => validateConfig({ providers: [{ ...row, logjev: { kind: 'auto' } }] })).toThrow('logjev.kind');
    expect(parseProviderInput({ ...row, logjev: { ...settings, extraBody: { apiKey: 'fixture-key' } } }, undefined)).toBeNull();
  });
  it('offers separate native and logprob presets (legacy open-jev preset removed 2026-09-23)', () => {
    const { mappable } = listMappablePresets();
    expect(mappable.find(p => p.id === 'jev')?.logjev?.kind).toBe('jev');
    expect(mappable.find(p => p.id === 'logjev')?.logjev?.kind).toBe('chat');
    // The open-jev PRESET is gone; already-configured open-jev provider rows
    // keep working (jevSystemone's row fallback), but the catalog no longer
    // offers it.
    expect(mappable.find(p => p.id === 'open-jev')).toBeUndefined();
  });
});
