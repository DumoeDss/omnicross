/**
 * OpenCodeGoModelDiscovery tests — the zen-half `/v1/models` probe behind
 * `GET /accounts/opencodego/models`: URL construction (default + override),
 * payload parsing, failure honesty, and the route handler's account
 * resolution. Secret-free assertions only (the key never crosses the route).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  fetchOpenCodeGoModels,
  handleOpenCodeGoModelsRoute,
  openCodeGoModelsUrl,
  parseOpenCodeGoModelsPayload,
} from '../allowance/OpenCodeGoModelDiscovery';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: ok ? 'OK' : 'Error' });
}

describe('openCodeGoModelsUrl', () => {
  it('defaults to the zen root /v1/models', () => {
    expect(openCodeGoModelsUrl()).toBe('https://opencode.ai/zen/v1/models');
  });

  it('normalizes an override host (trailing slash + /v1 suffix stripped)', () => {
    expect(openCodeGoModelsUrl('https://mirror.example/zen/v1/')).toBe('https://mirror.example/zen/v1/models');
    expect(openCodeGoModelsUrl('https://mirror.example')).toBe('https://mirror.example/v1/models');
  });
});

describe('parseOpenCodeGoModelsPayload', () => {
  it('collects OpenAI-wire data[].id entries, trimmed and deduped', () => {
    expect(parseOpenCodeGoModelsPayload({ data: [{ id: ' kimi-k2.6 ' }, { id: 'glm-5' }, { id: 'kimi-k2.6' }, { id: 42 }, {}] }))
      .toEqual(['kimi-k2.6', 'glm-5']);
  });

  it('rejects non-array payloads', () => {
    expect(parseOpenCodeGoModelsPayload(null)).toEqual([]);
    expect(parseOpenCodeGoModelsPayload({ data: 'nope' })).toEqual([]);
    expect(parseOpenCodeGoModelsPayload([])).toEqual([]);
  });
});

describe('fetchOpenCodeGoModels', () => {
  it('answers an honest error when the account has no key', async () => {
    const result = await fetchOpenCodeGoModels({ apiKey: null });
    expect(result.models).toEqual([]);
    expect(result.error).toContain('no API key');
  });

  it('sends the bearer key + library UA and parses the ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'kimi-k2.6' }, { id: 'glm-5' }] }));
    const result = await fetchOpenCodeGoModels({ apiKey: 'sk-test' }, fetchImpl);
    expect(result.models).toEqual(['kimi-k2.6', 'glm-5']);
    expect(result.error).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://opencode.ai/zen/v1/models');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['User-Agent']).toMatch(/^omnicross\//);
  });

  it('honors the account zenBaseUrl override', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'glm-5' }] }));
    await fetchOpenCodeGoModels({ apiKey: 'sk-test', zenBaseUrl: 'https://mirror.example/zen' }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://mirror.example/zen/v1/models');
  });

  it('surfaces a non-2xx as { models: [], error } — never throws', async () => {
    const result = await fetchOpenCodeGoModels(
      { apiKey: 'sk-test' },
      async () => jsonResponse({ error: { message: 'bad key' } }, false, 401),
    );
    expect(result.models).toEqual([]);
    expect(result.error).toContain('(401)');
  });

  it('surfaces a network failure as { models: [], error } — never throws', async () => {
    const result = await fetchOpenCodeGoModels(
      { apiKey: 'sk-test' },
      async () => { throw new Error('ECONNRESET'); },
    );
    expect(result.models).toEqual([]);
    expect(result.error).toContain('ECONNRESET');
  });

  it('rejects an empty / unexpected payload', async () => {
    const result = await fetchOpenCodeGoModels({ apiKey: 'sk-test' }, async () => jsonResponse({ object: 'list' }));
    expect(result.models).toEqual([]);
    expect(result.error).toContain('unexpected /models payload');
  });
});

describe('handleOpenCodeGoModelsRoute', () => {
  it('answers discovered:false when no account resolves', async () => {
    const result = await handleOpenCodeGoModelsRoute({ resolveAccount: async () => null });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ models: [], discovered: false, error: 'no opencodego account configured' });
  });

  it('resolves the REQUESTED account id and answers its live list', async () => {
    const resolveAccount = vi.fn(async (accountId?: string) => (
      accountId === 'acc-2'
        ? { apiKey: 'sk-2', zenBaseUrl: 'https://mirror.example/zen' }
        : { apiKey: 'sk-1' }
    ));
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'glm-5' }] }));
    const result = await handleOpenCodeGoModelsRoute({ resolveAccount, fetchImpl }, 'acc-2');
    expect(resolveAccount).toHaveBeenCalledWith('acc-2');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://mirror.example/zen/v1/models');
    expect(result.body).toEqual({ models: ['glm-5'], discovered: true });
  });

  it('treats an empty accountId as the ACTIVE account (undefined)', async () => {
    const resolveAccount = vi.fn(async () => ({ apiKey: 'sk-1' }));
    await handleOpenCodeGoModelsRoute({ resolveAccount, fetchImpl: async () => jsonResponse({ data: [{ id: 'glm-5' }] }) }, '');
    expect(resolveAccount).toHaveBeenCalledWith(undefined);
  });

  it('a resolveAccount throw degrades to discovered:false (never a 500)', async () => {
    const result = await handleOpenCodeGoModelsRoute({
      resolveAccount: async () => { throw new Error('store unavailable'); },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ models: [], discovered: false, error: 'no opencodego account configured' });
  });
});
