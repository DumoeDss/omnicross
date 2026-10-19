/**
 * DeepSeek key reuse: the search provider borrows the official key from the
 * LLM provider catalog. The rules under test are the ones that decide whether a
 * credential is shared — official host, enabled row, preferred key — because a
 * false positive here sends one provider's credential to another endpoint.
 */

import { describe, expect, it } from 'vitest';

import type { DaemonProviderConfig } from '../config';
import {
  deepseekLlmProviderApiKey,
  hasReusableDeepseekKey,
  isOfficialDeepseekBaseUrl,
} from '../search/deepseekKeyReuse';

function row(overrides: Partial<DaemonProviderConfig> = {}): DaemonProviderConfig {
  return {
    id: 'deepseek',
    apiFormat: 'openai',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-fixture-deepseek-key',
    ...overrides,
  };
}

describe('isOfficialDeepseekBaseUrl', () => {
  it('matches the official host in every URL form the presets write', () => {
    expect(isOfficialDeepseekBaseUrl('https://api.deepseek.com')).toBe(true);
    expect(isOfficialDeepseekBaseUrl('https://api.deepseek.com/v1')).toBe(true);
    expect(isOfficialDeepseekBaseUrl('https://api.deepseek.com/v1/chat/completions')).toBe(true);
    expect(isOfficialDeepseekBaseUrl('https://API.DEEPSEEK.COM/anthropic')).toBe(true);
  });

  it('rejects relays, lookalikes and malformed values', () => {
    expect(isOfficialDeepseekBaseUrl('https://relay.example.test/deepseek')).toBe(false);
    expect(isOfficialDeepseekBaseUrl('https://api.deepseek.com.evil.test')).toBe(false);
    expect(isOfficialDeepseekBaseUrl('not a url')).toBe(false);
  });
});

describe('deepseekLlmProviderApiKey', () => {
  it('returns the key of an enabled official row', () => {
    expect(deepseekLlmProviderApiKey([row()])).toBe('sk-fixture-deepseek-key');
    expect(hasReusableDeepseekKey([row()])).toBe(true);
  });

  it('ignores disabled, non-official and keyless rows', () => {
    const unrelated = [
      row({ id: 'proxy', baseUrl: 'https://relay.example.test', apiKey: 'proxy-key' }),
      row({ id: 'disabled', enabled: false }),
      row({ id: 'empty', apiKey: '' }),
      row({ id: 'pool-empty', apiKey: '', apiKeys: [{ id: 'k', apiKey: '', enabled: true }] }),
    ];
    expect(deepseekLlmProviderApiKey(unrelated, {})).toBeUndefined();
    expect(hasReusableDeepseekKey(unrelated, {})).toBe(false);
  });

  it('falls back to the first enabled pool key, matching the outbound precedence', () => {
    expect(
      deepseekLlmProviderApiKey([
        row({
          apiKey: '',
          apiKeys: [
            { id: 'off', apiKey: 'sk-disabled-pool', enabled: false },
            { id: 'on', apiKey: 'sk-enabled-pool' },
          ],
        }),
      ]),
    ).toBe('sk-enabled-pool');
  });

  it('resolves an $ENV reference at call time', () => {
    expect(
      deepseekLlmProviderApiKey([row({ apiKey: '$DEEPSEEK_FIXTURE_KEY' })], {
        DEEPSEEK_FIXTURE_KEY: 'sk-from-env',
      }),
    ).toBe('sk-from-env');
    // Unset resolves to nothing — never the literal "$NAME" sent as a bearer.
    expect(deepseekLlmProviderApiKey([row({ apiKey: '$MISSING_KEY' })], {})).toBeUndefined();
  });

  it('takes the first official row in catalog order, so ordering controls the choice', () => {
    expect(
      deepseekLlmProviderApiKey([
        row({ id: 'first', apiKey: 'sk-first' }),
        row({ id: 'second', apiKey: 'sk-second' }),
      ]),
    ).toBe('sk-first');
  });
});
