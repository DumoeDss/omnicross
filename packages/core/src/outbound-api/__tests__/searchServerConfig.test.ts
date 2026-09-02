/**
 * The daemon `search` config section: tolerant read, strict report, and the
 * rule that no validation message ever echoes a configured value.
 *
 * @module outbound-api/__tests__/searchServerConfig.test
 */

import { describe, expect, it } from 'vitest';

import { defaultServerConfig, normalizeServerConfig } from '../apiServerConfig';
import {
  DEFAULT_SEARCH_SERVER_CONFIG,
  normalizeSearchApiProviderConfigs,
  normalizeSearchServerConfig,
  validateSearchServerConfig,
} from '../searchServerConfig';

const TAVILY_KEY = 'tvly-fixture-not-a-real-key';
const SEARXNG_PASSWORD = 'fixture-basic-auth-password';

describe('normalizeSearchServerConfig', () => {
  it('yields the behavior-preserving defaults for an absent section', () => {
    const config = normalizeSearchServerConfig(undefined);

    expect(config.modes).toEqual({ codex: 'off', responses: 'native', anthropic: 'native' });
    expect(config.providers).toEqual({});
    expect(config.egress.allowedPrivateHosts).toEqual([]);
    expect(config.policy).toEqual({ fallbackEnabled: true });
  });

  it('never hands back the shared default arrays', () => {
    const first = normalizeSearchServerConfig(undefined);
    first.egress.allowedPrivateHosts.push('mutated.example');

    expect(normalizeSearchServerConfig(undefined).egress.allowedPrivateHosts).toEqual([]);
    expect(DEFAULT_SEARCH_SERVER_CONFIG.egress.allowedPrivateHosts).toEqual([]);
  });

  it('round-trips providers, an allowlist, modes and policy knobs', () => {
    const config = normalizeSearchServerConfig({
      modes: { codex: 'managed', responses: 'managed', anthropic: 'off' },
      providers: {
        tavily: { apiKey: TAVILY_KEY },
        searxng: { apiHost: 'https://searx.internal.corp', basicAuthUsername: 'ops', basicAuthPassword: SEARXNG_PASSWORD },
      },
      egress: { allowedPrivateHosts: ['searx.internal.corp', 'searx.internal.corp'] },
      policy: { preferred: 'tavily', allowed: ['tavily', 'http-bing'], fallbackEnabled: false, maxAttempts: 2 },
    });

    expect(config.modes).toEqual({ codex: 'managed', responses: 'managed', anthropic: 'off' });
    expect(config.providers.tavily).toEqual({ apiKey: TAVILY_KEY });
    expect(config.providers.searxng?.apiHost).toBe('https://searx.internal.corp');
    // Duplicates collapse: the allowlist is a set of hostnames, not a log.
    expect(config.egress.allowedPrivateHosts).toEqual(['searx.internal.corp']);
    expect(config.policy).toEqual({
      preferred: 'tavily',
      allowed: ['tavily', 'http-bing'],
      fallbackEnabled: false,
      maxAttempts: 2,
    });
  });

  it('drops unusable provider entries instead of throwing', () => {
    const config = normalizeSearchServerConfig({
      providers: {
        tavily: { apiKey: '   ' },
        searxng: { apiHost: 42 },
        zhipu: { apiKey: 'zhipu-fixture-key' },
        unknown: { apiKey: 'x' },
      },
    });

    expect(config.providers.tavily).toBeUndefined();
    expect(config.providers.searxng).toBeUndefined();
    expect(config.providers.zhipu).toEqual({ apiKey: 'zhipu-fixture-key' });
  });

  it('keeps a keyless jina entry, because jina really does run keyless', () => {
    expect(normalizeSearchApiProviderConfigs({ jina: {} }).jina).toEqual({});
  });

  it('falls back per-member on a malformed mode rather than discarding the section', () => {
    const config = normalizeSearchServerConfig({
      modes: { codex: 'managed', responses: 'nonsense' },
      policy: { maxAttempts: -3 },
    });

    expect(config.modes).toEqual({ codex: 'managed', responses: 'native', anthropic: 'native' });
    expect(config.policy.maxAttempts).toBeUndefined();
  });

  it('rejects control characters in a configured string', () => {
    const withControl = `key${String.fromCharCode(10)}injected`;
    expect(normalizeSearchApiProviderConfigs({ tavily: { apiKey: withControl } }).tavily)
      .toBeUndefined();
  });
});

describe('validateSearchServerConfig', () => {
  it('accepts an absent or valid section', () => {
    expect(validateSearchServerConfig(undefined)).toEqual([]);
    expect(validateSearchServerConfig({
      modes: { codex: 'managed' },
      providers: { tavily: { apiKey: TAVILY_KEY } },
      egress: { allowedPrivateHosts: ['searx.internal.corp'] },
      policy: { fallbackEnabled: true, maxAttempts: 3 },
    })).toEqual([]);
  });

  it('names the offending field for every kind of malformation', () => {
    const errors = validateSearchServerConfig({
      modes: { responses: 'nonsense', bogus: 'native' },
      providers: { tavily: {}, unknown: {} },
      egress: { allowedPrivateHosts: 'searx.internal.corp' },
      policy: { maxAttempts: 0, fallbackEnabled: 'yes' },
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('$.search.modes.responses'),
      expect.stringContaining('$.search.modes.bogus'),
      expect.stringContaining('$.search.providers.tavily.apiKey'),
      expect.stringContaining('$.search.providers.unknown'),
      expect.stringContaining('$.search.egress.allowedPrivateHosts'),
      expect.stringContaining('$.search.policy.maxAttempts'),
      expect.stringContaining('$.search.policy.fallbackEnabled'),
    ]));
  });

  it('never echoes a configured secret value', () => {
    const errors = validateSearchServerConfig({
      // Every one of these is malformed in a way that names its field, and the
      // key/password values must not travel with the complaint.
      providers: {
        tavily: { apiHost: 'https://api.tavily.com' },
        searxng: { basicAuthPassword: SEARXNG_PASSWORD },
      },
      policy: { preferred: { nested: TAVILY_KEY } },
    });

    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.join('\n');
    expect(joined).not.toContain(TAVILY_KEY);
    expect(joined).not.toContain(SEARXNG_PASSWORD);
  });
});

describe('server config integration', () => {
  it('fills the search section on the default config', () => {
    expect(defaultServerConfig().search).toEqual(DEFAULT_SEARCH_SERVER_CONFIG);
  });

  it('normalizes a persisted search section through the server config', () => {
    const config = normalizeServerConfig({
      search: { modes: { codex: 'managed' }, providers: { tavily: { apiKey: TAVILY_KEY } } },
    } as never);

    expect(config.search?.modes.codex).toBe('managed');
    expect(config.search?.providers.tavily?.apiKey).toBe(TAVILY_KEY);
    // The other frontends keep today's behavior.
    expect(config.search?.modes.responses).toBe('native');
    expect(config.search?.modes.anthropic).toBe('native');
  });
});
