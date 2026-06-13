/**
 * pool-config.test.ts — `validateProvider`/`validateConfig` shape-guard for the
 * optional `apiKeys[]` pool (key-pool change, design D1 / spec
 * "多 key provider 行 schema").
 *
 * Asserts: a legal `apiKeys[]` is parsed (defaults filled), bad entries are
 * skipped (no throw), a non-array collapses to `undefined`, and an absent
 * `apiKeys` keeps the row's single-key shape byte-identical.
 */

import { describe, expect, it } from 'vitest';

import { type DaemonProviderConfig,validateConfig } from '../config';

function rowFrom(provider: Record<string, unknown>): DaemonProviderConfig {
  const cfg = validateConfig({ providers: [provider] });
  return cfg.providers[0];
}

describe('config apiKeys shape-guard', () => {
  it('absent apiKeys → undefined (single-key behavior unchanged)', () => {
    const row = rowFrom({ id: 'p', apiFormat: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-x' });
    expect(row.apiKeys).toBeUndefined();
    expect(row.apiKey).toBe('sk-x');
  });

  it('parses a legal apiKeys array, filling enabled/label defaults', () => {
    const row = rowFrom({
      id: 'p',
      apiFormat: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: '',
      apiKeys: [
        { id: 'k1', apiKey: 'sk-a', weight: 3 },
        { id: 'k2', apiKey: '$OAI', enabled: false },
      ],
    });
    expect(row.apiKeys).toHaveLength(2);
    const [k1, k2] = row.apiKeys!;
    expect(k1).toEqual({ id: 'k1', apiKey: 'sk-a', weight: 3 });
    // enabled left unset (defaults to true at load time); label absent (defaults to id).
    expect(k1.enabled).toBeUndefined();
    expect(k1.label).toBeUndefined();
    expect(k2.enabled).toBe(false);
    expect(k2.apiKey).toBe('$OAI');
  });

  it('skips bad entries (missing id / missing apiKey) without throwing', () => {
    const row = rowFrom({
      id: 'p',
      apiFormat: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-x',
      apiKeys: [
        { apiKey: 'sk-no-id' }, // no id → skipped
        { id: 'k-no-key' }, // no apiKey → skipped
        { id: 'good', apiKey: 'sk-good' },
        'not-an-object', // skipped
      ],
    });
    expect(row.apiKeys).toHaveLength(1);
    expect(row.apiKeys![0].id).toBe('good');
  });

  it('non-array apiKeys → undefined, rest of the row parses', () => {
    const row = rowFrom({
      id: 'p',
      apiFormat: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-x',
      apiKeys: 'oops-a-string',
    });
    expect(row.apiKeys).toBeUndefined();
    expect(row.apiFormat).toBe('openai');
    expect(row.baseUrl).toBe('https://x/v1');
  });

  it('all-bad / empty apiKeys array → undefined (falls back to single key)', () => {
    const row = rowFrom({
      id: 'p',
      apiFormat: 'openai',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-x',
      apiKeys: [{ id: '' }, { apiKey: '' }],
    });
    expect(row.apiKeys).toBeUndefined();
  });
});
