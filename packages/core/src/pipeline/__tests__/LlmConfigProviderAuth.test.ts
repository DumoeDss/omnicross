/**
 * Focused unit tests for `LlmConfigProviderAuth` (Phase 2, task 4.2).
 *
 * Asserts:
 *  - `applyHeaders` produces output IDENTICAL to a direct `getProviderHeaders`
 *    call (anthropic / openai / google / openrouter formats), merged into the
 *    caller's header object.
 *  - `onResult` reports + returns the new key on 429/401/403/529, and no-ops
 *    on success (2xx) / other statuses / non-pool requests — mirroring
 *    `callWithPoolReporting`'s reportable + success branches.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyPoolService } from '../../completion/ApiKeyPoolService';
import { getProviderHeaders } from '../../completion/header-builder';
import { LlmConfigProviderAuth } from '../LlmConfigProviderAuth';

// Minimal provider rows for each auth format. Only fields read by
// `resolveApiFormat` / `isOpenRouterProvider` / `getProviderHeaders` matter.
function makeProvider(over: Partial<LLMProvider> & { id: string }): LLMProvider {
  return {
    name: over.id,
    api_base_url: 'https://api.example.com',
    api_key: 'unused',
    models: [],
    ...over,
  } as LLMProvider;
}

const hints = { upstreamUrl: 'https://api.example.com/v1', model: 'm-1' };

describe('LlmConfigProviderAuth.applyHeaders', () => {
  it('matches getProviderHeaders for an OpenAI-format provider', () => {
    const provider = makeProvider({ id: 'openai', apiFormat: 'openai' });
    const auth = new LlmConfigProviderAuth({ provider, apiKey: 'sk-abc' });

    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, hints);

    expect(headers).toEqual(getProviderHeaders(provider, 'sk-abc'));
    expect(headers.Authorization).toBe('Bearer sk-abc');
  });

  it('matches getProviderHeaders for an Anthropic-format provider', () => {
    const provider = makeProvider({ id: 'p-anthropic', apiFormat: 'anthropic' });
    const auth = new LlmConfigProviderAuth({ provider, apiKey: 'sk-ant' });

    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, hints);

    expect(headers).toEqual(getProviderHeaders(provider, 'sk-ant'));
    expect(headers['x-api-key']).toBe('sk-ant');
  });

  it('matches getProviderHeaders for a Google-format provider', () => {
    const provider = makeProvider({ id: 'google', apiFormat: 'google' });
    const auth = new LlmConfigProviderAuth({ provider, apiKey: 'sk-goog' });

    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, hints);

    expect(headers).toEqual(getProviderHeaders(provider, 'sk-goog'));
    expect(headers['x-goog-api-key']).toBe('sk-goog');
  });

  it('merges into an existing header object without dropping unrelated keys', () => {
    const provider = makeProvider({ id: 'openai', apiFormat: 'openai' });
    const auth = new LlmConfigProviderAuth({ provider, apiKey: 'sk-abc' });

    const headers: Record<string, string> = { 'x-pre-existing': 'keep' };
    auth.applyHeaders(headers, hints);

    expect(headers['x-pre-existing']).toBe('keep');
    expect(headers.Authorization).toBe('Bearer sk-abc');
  });
});

// ---------------------------------------------------------------------------
// onResult — pool-rotation seam (D5). Isolated; no caller wires it in Phase 2.
// ---------------------------------------------------------------------------

function makePool(over: Partial<ApiKeyPoolService> = {}): ApiKeyPoolService {
  return {
    reportError: vi.fn(async () => null),
    reportSuccess: vi.fn(),
    getKeyIdForSession: vi.fn(() => null),
    ...over,
  } as unknown as ApiKeyPoolService;
}

const poolProvider = makeProvider({ id: 'openai', apiFormat: 'openai' });

function makePoolAuth(pool: ApiKeyPoolService) {
  return new LlmConfigProviderAuth({
    provider: poolProvider,
    apiKey: 'sk-initial',
    apiKeyPool: pool,
    providerId: 'openai',
    sessionId: 'sess-1',
  });
}

describe('LlmConfigProviderAuth.onResult', () => {
  it.each([429, 529, 401, 403])(
    'reports a reportable status (%i) and returns the rebound new key',
    async (status) => {
      const reportError = vi.fn(async () => 'sk-rotated');
      const pool = makePool({ reportError });
      const auth = makePoolAuth(pool);

      const outcome = await auth.onResult(status);

      expect(reportError).toHaveBeenCalledWith('openai', 'sess-1', status);
      expect(outcome).toEqual({ rebound: true, newKey: 'sk-rotated' });
      // The source adopts the rotated key.
      expect(auth.apiKey).toBe('sk-rotated');
    },
  );

  it('reports a reportable status but returns rebound:false when no key is available', async () => {
    const reportError = vi.fn(async () => null);
    const pool = makePool({ reportError });
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(429);

    expect(reportError).toHaveBeenCalledWith('openai', 'sess-1', 429);
    expect(outcome).toEqual({ rebound: false });
    // No rotation → key unchanged.
    expect(auth.apiKey).toBe('sk-initial');
  });

  it('calls reportSuccess on a 2xx status and does not rebind', async () => {
    const reportSuccess = vi.fn();
    const reportError = vi.fn(async () => null);
    const pool = makePool({ reportSuccess, reportError });
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(200);

    expect(reportSuccess).toHaveBeenCalledWith('sess-1');
    expect(reportError).not.toHaveBeenCalled();
    expect(outcome).toEqual({ rebound: false });
  });

  it('no-ops on a non-reportable, non-success status (e.g. 500)', async () => {
    const reportSuccess = vi.fn();
    const reportError = vi.fn(async () => null);
    const pool = makePool({ reportSuccess, reportError });
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(500);

    expect(reportError).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(outcome).toEqual({ rebound: false });
  });

  it('no-ops on a null status (network error)', async () => {
    const reportSuccess = vi.fn();
    const reportError = vi.fn(async () => null);
    const pool = makePool({ reportSuccess, reportError });
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(null);

    expect(reportError).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(outcome).toEqual({ rebound: false });
  });

  it('no-ops entirely for a non-pool request (no apiKeyPool / sessionId)', async () => {
    const auth = new LlmConfigProviderAuth({
      provider: poolProvider,
      apiKey: 'sk-initial',
      // no pool, no session → fromPool === false equivalent
    });

    expect(await auth.onResult(429)).toEqual({ rebound: false });
    expect(await auth.onResult(200)).toEqual({ rebound: false });
  });
});
