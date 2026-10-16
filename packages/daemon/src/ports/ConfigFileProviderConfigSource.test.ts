import { describe, expect, it } from 'vitest';

import { validateConfig } from '../config';
import { ConfigFileProviderConfigSource } from './ConfigFileProviderConfigSource';

describe('live provider credentials and official model migrations', () => {
  it('preserves disabled state and replaces credentials after reload', async () => {
    const row = { id: 'images', apiFormat: 'openai', baseUrl: 'https://images.example/v1', apiKey: 'first', enabled: false };
    const source = new ConfigFileProviderConfigSource(validateConfig({ providers: [row] }));
    expect(await source.getProvider('images')).toMatchObject({ enabled: false, api_key: 'first' });
    source.reload(validateConfig({ providers: [{ ...row, enabled: true, apiKey: 'second' }] }));
    expect(await source.getProvider('images')).toMatchObject({ enabled: true, api_key: 'second' });
  });
  it('resolves saved MiMo defaults only on official endpoints', async () => {
    const source = new ConfigFileProviderConfigSource(validateConfig({ providers: [
      { id: 'mimo', apiFormat: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'key', models: ['mimo-v2.5'] },
      { id: 'custom', apiFormat: 'openai', baseUrl: 'https://custom.example/v1', apiKey: 'key', models: ['mimo-v2.5'] },
    ] }));
    expect((await source.getProvider('mimo'))?.models).toEqual(['mimo-v2.6-flash']);
    expect(await source.resolveRoutedModel('mimo', 'mimo-v2.5')).toMatchObject({ actualModelId: 'mimo-v2.6-flash' });
    expect(await source.resolveRoutedModel('custom', 'mimo-v2.5')).toBeNull();
  });
});
