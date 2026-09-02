/**
 * serverConfigAdapter search-mutation tests (search-settings-ui): the
 * layer-replace rebuild for `updateSearchConfig` (masked-read → edit one field
 * → PUT carries the FULL segment, no markers, no secret fields), the
 * older-daemon null path for diagnostics, and the never-thrown test outcome.
 * `adminClient` is mocked so no transport is exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../adminClient';
import { createApiServiceAdapter } from '../serverConfigAdapter';

import type { OutboundApiServerConfig, SearchServerConfig } from '../types-server';

const mocked = vi.mocked(adminClient);

/** A masked admin read, exactly as the daemon serializes it. */
const MASKED_SEARCH: SearchServerConfig = {
  modes: { codex: 'managed', responses: 'native', anthropic: 'native' },
  providers: {
    tavily: { apiKeyConfigured: true },
    searxng: {
      apiHost: 'https://searx.internal.example.test',
      basicAuthUsername: 'svc',
      basicAuthPasswordConfigured: true,
    },
    jina: { apiKeyConfigured: false },
  },
  egress: { allowedPrivateHosts: ['searx.internal.example.test'] },
  policy: { preferred: 'tavily', fallbackEnabled: true, maxAttempts: 3 },
};

const CONFIG: OutboundApiServerConfig = {
  enabled: false,
  networkBinding: false,
  endpoints: [],
  search: MASKED_SEARCH,
};

function putResponse(): { server: OutboundApiServerConfig } {
  return { server: { ...CONFIG } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateSearchConfig — layer-replaced full-segment rebuild', () => {
  it('carries the FULL segment with other entries preserved, no markers, no secret fields', async () => {
    mocked.get.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    await adapter.getConfig(); // populate the cache (trap #1 discipline)

    // The model's payload: the masked read with ONLY the searxng host edited
    // and a NEW tavily key typed into the write-only field.
    const draft: SearchServerConfig = {
      ...MASKED_SEARCH,
      providers: {
        ...MASKED_SEARCH.providers,
        tavily: { ...MASKED_SEARCH.providers.tavily, apiKey: 'NEW_KEY_SENTINEL' },
        searxng: { ...MASKED_SEARCH.providers.searxng, apiHost: 'https://searx2.internal.example.test' },
      },
    };
    mocked.put.mockResolvedValueOnce(putResponse());
    const result = await adapter.updateSearchConfig(draft);
    expect(result.success).toBe(true);

    expect(mocked.put).toHaveBeenCalledTimes(1);
    const [path, body] = mocked.put.mock.calls[0] as unknown as [
      string,
      { search: SearchServerConfig },
    ];
    expect(path).toBe('/server');
    const payload = body.search;

    // The whole tree rides: modes/egress/policy and every provider entry.
    expect(payload.modes).toEqual(MASKED_SEARCH.modes);
    expect(payload.egress).toEqual(MASKED_SEARCH.egress);
    expect(payload.policy).toEqual(MASKED_SEARCH.policy);
    // Untouched entries survive, marker-stripped.
    expect(payload.providers.jina).toEqual({});
    // The edited host lands; the new key rides write-only.
    expect(payload.providers.searxng).toEqual({
      apiHost: 'https://searx2.internal.example.test',
      basicAuthUsername: 'svc',
    });
    expect(payload.providers.tavily).toEqual({ apiKey: 'NEW_KEY_SENTINEL' });

    // No marker ever persists, and no STORED secret value exists to send — the
    // masked read contributed none.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Configured');
    expect(serialized).not.toContain('SECRET');
  });

  it('sends a null secret explicitly when the model clears an optional one', async () => {
    mocked.get.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    await adapter.getConfig();

    const draft: SearchServerConfig = {
      ...MASKED_SEARCH,
      providers: {
        ...MASKED_SEARCH.providers,
        jina: { apiKey: null },
      },
    };
    mocked.put.mockResolvedValueOnce(putResponse());
    await adapter.updateSearchConfig(draft);

    const [, body] = mocked.put.mock.calls[0] as unknown as [
      string,
      { search: SearchServerConfig },
    ];
    expect(body.search.providers.jina).toEqual({ apiKey: null });
  });

  it('drops a provider entry the draft removed (entry removal = secret gone)', async () => {
    mocked.get.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    await adapter.getConfig();

    const { tavily: _removed, ...rest } = MASKED_SEARCH.providers;
    const draft: SearchServerConfig = { ...MASKED_SEARCH, providers: rest };
    mocked.put.mockResolvedValueOnce(putResponse());
    await adapter.updateSearchConfig(draft);

    const [, body] = mocked.put.mock.calls[0] as unknown as [
      string,
      { search: SearchServerConfig },
    ];
    expect(body.search.providers.tavily).toBeUndefined();
    expect(body.search.providers.searxng).toBeDefined();
  });

  it('surfaces a daemon 400 honestly and applies nothing locally', async () => {
    mocked.get.mockResolvedValueOnce({ server: CONFIG });
    const adapter = createApiServiceAdapter();
    await adapter.getConfig();

    mocked.put.mockRejectedValueOnce(
      Object.assign(new Error('invalid search config: $.search.policy.maxAttempts: expected an integer in 1..32')),
    );
    const result = await adapter.updateSearchConfig({
      ...MASKED_SEARCH,
      policy: { ...MASKED_SEARCH.policy, maxAttempts: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('maxAttempts');
  });
});

describe('getSearchDiagnostics — older-daemon compatibility', () => {
  it('returns the snapshot when the daemon exposes it', async () => {
    const snapshot = {
      rows: [
        { providerId: 'http-bing', source: 'builtin', kind: 'http', capabilities: {} },
      ],
      modes: { codex: 'off', responses: 'native', anthropic: 'native' },
      applySemantics: { codex: 'immediate', rest: 'restart' },
    };
    mocked.get.mockResolvedValueOnce({ diagnostics: snapshot });
    const adapter = createApiServiceAdapter();
    const diagnostics = await adapter.getSearchDiagnostics();
    expect(mocked.get).toHaveBeenCalledWith('/search/diagnostics');
    expect(diagnostics).toEqual(snapshot);
  });

  it('returns null (never throws) when the daemon predates the endpoint', async () => {
    mocked.get.mockRejectedValueOnce(new Error('request failed (404)'));
    const adapter = createApiServiceAdapter();
    const diagnostics = await adapter.getSearchDiagnostics();
    expect(diagnostics).toBeNull();
  });
});

describe('runSearchQuery — result-shaped outcomes only', () => {
  it('round-trips the operator query and maps diagnostic + results back verbatim', async () => {
    mocked.post.mockResolvedValueOnce({
      result: {
        diagnostic: { providerId: 'tavily', status: 'healthy', checkedAt: '2026-09-02T00:00:00.000Z' },
        resultCount: 2,
        results: [
          { title: 'Result title', url: 'https://result.example.test/a', content: 'A snippet' },
          { title: 'Another', url: 'https://result.example.test/b', content: 'Another snippet' },
        ],
      },
    });
    const adapter = createApiServiceAdapter();
    const outcome = await adapter.runSearchQuery('tavily', 'omnicross search');
    // The payload places providerId and query exactly where the daemon route
    // reads them.
    expect(mocked.post).toHaveBeenCalledWith('/search/query', {
      providerId: 'tavily',
      query: 'omnicross search',
    });
    expect(outcome).toEqual({
      ok: true,
      result: {
        diagnostic: { providerId: 'tavily', status: 'healthy', checkedAt: '2026-09-02T00:00:00.000Z' },
        resultCount: 2,
        results: [
          { title: 'Result title', url: 'https://result.example.test/a', content: 'A snippet' },
          { title: 'Another', url: 'https://result.example.test/b', content: 'Another snippet' },
        ],
      },
    });
  });

  it('renders a blocked network outcome as a successful call with the diagnostic and no results', async () => {
    mocked.post.mockResolvedValueOnce({
      result: {
        diagnostic: { providerId: 'searxng', status: 'blocked', reason: 'the egress policy refused the request target' },
      },
    });
    const adapter = createApiServiceAdapter();
    const outcome = await adapter.runSearchQuery('searxng', 'internal docs');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.diagnostic.status).toBe('blocked');
      expect(outcome.result.results).toBeUndefined();
    }
  });

  it('never throws — an endpoint refusal is an { ok:false } outcome', async () => {
    mocked.post.mockRejectedValueOnce(new Error("search provider 'z.ai' is not configured"));
    const adapter = createApiServiceAdapter();
    const outcome = await adapter.runSearchQuery('z.ai', 'anything');
    expect(outcome).toEqual({ ok: false, error: "search provider 'z.ai' is not configured" });
  });
});
