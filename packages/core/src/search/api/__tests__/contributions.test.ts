/**
 * Contribution gating, declared capabilities, the reader wiring, the SSRF
 * policy as adapters actually experience it, and the leak gate.
 *
 * The leak gate is the security test of record for this change: it collects
 * every error and diagnostic the adapters produce under credential-echoing
 * failures and scans them for the planted key.
 *
 * @module search/api/__tests__/contributions.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isSearchProviderError,
  toSearchErrorShape,
  type SearchProviderContribution,
  type SearchProviderError,
} from '@omnicross/contracts/search-types';
import { describe, expect, it } from 'vitest';

import { createSearchRuntime } from '../../index';
import { apiSearchContributions } from '../contributions';
import { JinaSearchProvider } from '../JinaSearchProvider';
import type { SearchApiFetch, SearchApiProviderConfigs } from '../types';

const QUERY = 'mozilla developer network http headers';

const ALL_CONFIGS: SearchApiProviderConfigs = {
  tavily: { apiKey: 'tavily-key' },
  jina: { apiKey: 'jina-key' },
  searxng: { apiHost: 'https://searx.example.test' },
  zhipu: { apiKey: 'zhipu-key' },
  'z.ai': { apiKey: 'zai-key' },
};

function jsonFetch(body: string, status = 200): SearchApiFetch {
  return () =>
    Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
}

function byId(contributions: SearchProviderContribution[], id: string): SearchProviderContribution {
  const found = contributions.find((contribution) => contribution.id === id);
  if (!found) throw new Error(`no contribution for ${id}`);
  return found;
}

async function failureOf(promise: Promise<unknown>): Promise<SearchProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected a failure, but the call resolved');
}

describe('apiSearchContributions — gating', () => {
  it('returns ONLY the providers the config names', () => {
    const contributions = apiSearchContributions({
      tavily: { apiKey: 'k' },
      searxng: { apiHost: 'https://sx.example.test' },
    });

    expect(contributions.map((contribution) => contribution.id)).toEqual(['tavily', 'searxng']);
  });

  it('returns nothing at all for an empty config', () => {
    expect(apiSearchContributions({})).toEqual([]);
  });

  it('registers all five ids when all five are configured, in baseline order', () => {
    expect(apiSearchContributions(ALL_CONFIGS).map((contribution) => contribution.id)).toEqual([
      'tavily',
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ]);
  });

  it('declares source and kind explicitly on every contribution', () => {
    for (const contribution of apiSearchContributions(ALL_CONFIGS)) {
      expect(contribution.source).toBe('builtin');
      expect(contribution.kind).toBe('api');
      // Ordering is the orchestrator's decision, not a contribution's.
      expect(contribution.priorityHint).toBeUndefined();
      expect(contribution.provider.id).toBe(contribution.id);
    }
  });
});

describe('apiSearchContributions — declared capabilities', () => {
  const contributions = apiSearchContributions(ALL_CONFIGS);

  it.each([
    ['tavily', true, false],
    ['jina', false, true],
    ['searxng', false, false],
    ['zhipu', true, false],
    ['z.ai', true, false],
  ])('%s declares requiresApiKey=%s supportsUrlRead=%s', (id, requiresApiKey, supportsUrlRead) => {
    const { capabilities, provider } = byId(contributions, id);
    expect(capabilities.requiresApiKey).toBe(requiresApiKey);
    expect(capabilities.supportsUrlRead).toBe(supportsUrlRead);
    // A declared capability has to be true of the implementation behind it.
    expect(typeof provider.readUrl === 'function').toBe(supportsUrlRead);
  });

  it('declares cancellation everywhere and region/language/timeRange nowhere', () => {
    for (const { capabilities } of contributions) {
      expect(capabilities.supportsCancellation).toBe(true);
      expect(capabilities.supportsRegion).toBe(false);
      expect(capabilities.supportsLanguage).toBe(false);
      expect(capabilities.supportsTimeRange).toBe(false);
      // None of these APIs documents an upper bound; 5 and 10 are DEFAULTS, and
      // declaring a default as a cap would be a false capability.
      expect(capabilities.maxResults).toBeUndefined();
    }
  });
});

describe('Deferred and unregistered providers stay absent', () => {
  const API_ROOT = new URL('../', import.meta.url);

  it('exposes no exa, bocha, grok or claude provider anywhere in the module', async () => {
    const surface = (await import('../index')) as Record<string, unknown>;
    for (const name of Object.keys(surface)) {
      expect(name).not.toMatch(/exa|bocha|grok|claude/i);
    }

    // And no CODE mentions them as ids. The doc comments deliberately DO name
    // them (explaining why they are absent), so prose is stripped first —
    // the same trap the HTTP slice's boundary test hit.
    const sources = readdirSync(fileURLToPath(API_ROOT), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => readFileSync(fileURLToPath(new URL(entry.name, API_ROOT)), 'utf8'));
    expect(sources.length).toBeGreaterThan(8);

    const code = sources.map(stripComments).join('\n');
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/['"`](?:exa|bocha|grok|claude)['"`]/i);
  });

  it('imports no Elftia package and no Electron', () => {
    const sources = readdirSync(fileURLToPath(API_ROOT), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => readFileSync(fileURLToPath(new URL(entry.name, API_ROOT)), 'utf8'));

    const specifierPatterns = [
      /(?:^|\s)(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm,
      /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    const allowedBareImports = new Set(['@omnicross/contracts/search-types', 'undici']);

    const specifiers = sources.flatMap((source) =>
      specifierPatterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])),
    );
    // Guards against a silently non-matching regex passing this test vacuously.
    expect(specifiers.length).toBeGreaterThan(10);

    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/elftia|electron/i);
      if (specifier.startsWith('.')) continue;
      expect(allowedBareImports.has(specifier) || specifier.startsWith('node:')).toBe(true);
    }
  });
});

describe('End to end through the 阶段3 runtime', () => {
  it('runs a pinned API search and reports one successful attempt', async () => {
    const contributions = apiSearchContributions(
      { tavily: { apiKey: 'k' } },
      {
        fetchImpl: jsonFetch(
          JSON.stringify({
            results: [
              { title: 'HTTP headers', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers', content: 'c' },
            ],
          }),
        ),
      },
    );
    const runtime = createSearchRuntime({ contributions });

    const response = await runtime.search({ query: QUERY, provider: 'tavily' });

    expect(response.providerId).toBe('tavily');
    expect(response.results).toHaveLength(1);
    expect(response.attempts).toEqual([
      expect.objectContaining({ providerId: 'tavily', outcome: 'success', resultCount: 1 }),
    ]);
    expect(response.fallbackCount).toBe(0);
  });

  it('falls back past a failing API provider to a working one', async () => {
    let call = 0;
    const contributions = apiSearchContributions(
      { tavily: { apiKey: 'k' }, jina: {} },
      {
        fetchImpl: () => {
          call += 1;
          return Promise.resolve(
            call === 1
              ? new Response('{"error":"boom"}', { status: 500 })
              : new Response(
                  JSON.stringify({ data: [{ title: 'j', url: 'https://example.test/j', content: 'c' }] }),
                  { status: 200 },
                ),
          );
        },
      },
    );

    const response = await createSearchRuntime({ contributions }).search({ query: QUERY });

    expect(response.providerId).toBe('jina');
    expect(response.attempts.map((attempt) => [attempt.providerId, attempt.outcome])).toEqual([
      ['tavily', 'failed'],
      ['jina', 'success'],
    ]);
  });

  it('surfaces an empty API result set as a SUCCESS with zero results', async () => {
    const contributions = apiSearchContributions(
      { searxng: { apiHost: 'https://searx.example.test' } },
      { fetchImpl: jsonFetch('{"results":[]}') },
    );

    const response = await createSearchRuntime({ contributions }).search({ query: QUERY });
    expect(response.providerId).toBe('searxng');
    expect(response.results).toEqual([]);
  });

  it('lists API providers as serializable descriptors', () => {
    const runtime = createSearchRuntime({ contributions: apiSearchContributions(ALL_CONFIGS) });
    const descriptors = runtime.listProviders();

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      'tavily',
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.kind).toBe('api');
      expect(descriptor).not.toHaveProperty('provider');
    }
  });
});

describe('readUrl wiring', () => {
  it('reaches the reader with the search key on the Jina contribution only', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const contributions = apiSearchContributions(ALL_CONFIGS, {
      fetchImpl: (url, init) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return Promise.resolve(
          new Response('{"data":{"title":"T","content":"C"}}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

    const jina = byId(contributions, 'jina');
    const result = await jina.provider.readUrl!('https://example.test/page');

    expect(result).toEqual({ url: 'https://example.test/page', title: 'T', content: 'C' });
    expect(seen[0].url).toBe(`https://r.jina.ai/${encodeURIComponent('https://example.test/page')}`);
    // Baseline parity: the reader shares the SEARCH key.
    expect(seen[0].headers.Authorization).toBe('Bearer jina-key');

    for (const id of ['tavily', 'searxng', 'zhipu', 'z.ai']) {
      expect(byId(contributions, id).provider.readUrl).toBeUndefined();
    }
  });

  it('is available the moment the provider exists — no setter to forget', () => {
    // Elftia wired the reader through a later `setApiKey` call, so the declared
    // capability was only true after configuration ran. Here it is constructor
    // state, which is what makes `supportsUrlRead: true` honest.
    expect(typeof new JinaSearchProvider({ apiKey: 'k' }).readUrl).toBe('function');
  });
});

describe('Egress policy as the adapters experience it', () => {
  it('denies a SearXNG instance on a private address by default', async () => {
    let called = false;
    const contributions = apiSearchContributions(
      { searxng: { apiHost: 'http://192.168.0.10' } },
      {
        fetchImpl: () => {
          called = true;
          return Promise.resolve(new Response('{"results":[]}'));
        },
      },
    );

    const error = await failureOf(byId(contributions, 'searxng').provider.search(QUERY));
    expect(error.code).toBe('policy_denied');
    expect(error.message).toContain('192.168.0.10');
    expect(called).toBe(false);
  });

  it('admits the same instance once an admin allowlists its hostname', async () => {
    const contributions = apiSearchContributions(
      { searxng: { apiHost: 'http://192.168.0.10' } },
      {
        egressPolicy: { allowedPrivateHosts: ['192.168.0.10'] },
        fetchImpl: jsonFetch('{"results":[]}'),
      },
    );

    await expect(byId(contributions, 'searxng').provider.search(QUERY)).resolves.toEqual([]);
  });

  it('applies the same rule to an apiHost override on a default-host provider', async () => {
    // There is no trusted-default-host bypass: an overridden Tavily host is
    // validated exactly like SearXNG's mandatory one.
    const contributions = apiSearchContributions(
      { tavily: { apiKey: 'k', apiHost: 'http://169.254.169.254' } },
      { fetchImpl: jsonFetch('{"results":[]}') },
    );

    const error = await failureOf(byId(contributions, 'tavily').provider.search(QUERY));
    expect(error.code).toBe('policy_denied');
    expect(error.details?.egressClass).toBe('metadata');
  });
});

describe('Leak gate — a configured credential never reaches an error or a shape', () => {
  const PLANTED_KEY = 'tvly-LEAKCANARY-9f8e7d6c5b4a3210';
  const PLANTED_PASSWORD = 'searx-LEAKCANARY-password';
  const ECHO_FIXTURE = readFileSync(
    fileURLToPath(
      new URL('../../../../test-fixtures/api-search/tavily/tavily-error-echoes-request.synthetic.json', import.meta.url),
    ),
    'utf8',
  );

  /**
   * Every failing path an operator could see, driven with credentials planted
   * in the config AND echoed back by the upstream.
   */
  async function collectDiagnosticText(): Promise<string> {
    const echoBody = ECHO_FIXTURE.replace('__API_KEY__', PLANTED_KEY);
    const basic = Buffer.from(`user:${PLANTED_PASSWORD}`).toString('base64');

    const scenarios: SearchApiFetch[] = [
      // The Tavily case this gate exists for: a 4xx quoting the request body.
      jsonFetch(echoBody, 400),
      jsonFetch(echoBody, 401),
      jsonFetch(echoBody, 429),
      jsonFetch(echoBody, 500),
      // An upstream that quotes the Authorization header instead.
      jsonFetch(`{"error":"rejected Authorization: Bearer ${PLANTED_KEY}"}`, 403),
      jsonFetch(`{"error":"rejected Authorization: Basic ${basic}"}`, 403),
      // A non-JSON error page carrying the key in a URL.
      jsonFetch(`<html>see https://api.example.test/debug?api_key=${PLANTED_KEY}</html>`, 502),
      // A malformed body, so the parse path is covered too.
      jsonFetch(`not json ${PLANTED_KEY}`, 200),
    ];

    const collected: string[] = [];
    for (const fetchImpl of scenarios) {
      const contributions = apiSearchContributions(
        {
          tavily: { apiKey: PLANTED_KEY },
          jina: { apiKey: PLANTED_KEY },
          searxng: {
            apiHost: 'https://searx.example.test',
            basicAuthUsername: 'user',
            basicAuthPassword: PLANTED_PASSWORD,
          },
          zhipu: { apiKey: PLANTED_KEY },
          'z.ai': { apiKey: `${PLANTED_KEY},second-${PLANTED_KEY}` },
        },
        { fetchImpl },
      );

      for (const contribution of contributions) {
        try {
          await contribution.provider.search(QUERY);
        } catch (error) {
          const shape = toSearchErrorShape(error);
          collected.push(
            (error as Error).message,
            JSON.stringify(shape),
            JSON.stringify((error as SearchProviderError).details ?? {}),
            String(error),
          );
        }
        if (contribution.provider.readUrl) {
          try {
            await contribution.provider.readUrl('https://example.test/page');
          } catch (error) {
            collected.push((error as Error).message, JSON.stringify(toSearchErrorShape(error)));
          }
        }
      }
    }
    return collected.join('\n');
  }

  it('produces diagnostics that contain zero occurrences of any planted credential', async () => {
    const text = await collectDiagnosticText();

    // Anti-vacuity: the scan must actually have something to scan.
    expect(text.length).toBeGreaterThan(2000);

    for (const secret of [
      PLANTED_KEY,
      PLANTED_PASSWORD,
      'LEAKCANARY',
      Buffer.from(`user:${PLANTED_PASSWORD}`).toString('base64'),
      encodeURIComponent(PLANTED_KEY),
    ]) {
      expect(text).not.toContain(secret);
    }
    // And the redaction actually fired rather than the text being empty.
    expect(text).toContain('[redacted]');
  });

  it('never lets a fixture carry a credential-shaped value of its own', () => {
    expect(ECHO_FIXTURE).toContain('__API_KEY__');
    expect(ECHO_FIXTURE).not.toMatch(/tvly-[A-Za-z0-9]{8,}/);
  });
});

/** Strip block and line comments so a prose grep cannot match documentation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
