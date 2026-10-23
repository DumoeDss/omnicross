/** Wire auth context and real-pool feedback remain isolated by provider. */

import type { ApiKeyEntry, LLMProvider } from '@omnicross/contracts/llm-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyPoolService } from '../../completion/ApiKeyPoolService';
import { getOpenCodeGoUserAgent } from '../../provider-proxy/identity/openCodeGoHeaders';
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
// applyHeaders — opencode.ai egress identity (opencodego-egress-identity BYO
// half). A provider row pointing at opencode.ai picks up `user-agent` +
// `x-opencode-session`; the session value prefers the caller's own header,
// else the ingress-derived per-conversation key. The resolved URL, not merely
// the stored provider URL, controls these identity headers.
// ---------------------------------------------------------------------------

describe('LlmConfigProviderAuth.applyHeaders opencode identity', () => {
  const ocgProvider = makeProvider({
    id: 'ocg-byo',
    apiFormat: 'openai',
    api_base_url: 'https://opencode.ai/zen/v1',
  });
  const ocgHints = { upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions', model: 'm-1' };

  it('forwards the caller session verbatim', () => {
    const auth = new LlmConfigProviderAuth({ provider: ocgProvider, apiKey: 'sk-ocg' });
    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, { ...ocgHints, callerOpenCodeSession: 'client-sess-42' });
    expect(headers['x-opencode-session']).toBe('client-sess-42');
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
  });

  it('falls back to the derived session key when the caller sent none', () => {
    const auth = new LlmConfigProviderAuth({ provider: ocgProvider, apiKey: 'sk-ocg' });
    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, { ...ocgHints, sessionKey: 'fnv1a8hex' });
    expect(headers['x-opencode-session']).toBe('fnv1a8hex');
  });

  it('omits the session header entirely when neither is present', () => {
    const auth = new LlmConfigProviderAuth({ provider: ocgProvider, apiKey: 'sk-ocg' });
    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, ocgHints);
    expect(headers['x-opencode-session']).toBeUndefined();
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
  });

  it('keys off hints.upstreamUrl, not just the row base', () => {
    // A NON-opencode row whose resolved upstream was overridden to opencode.ai.
    const provider = makeProvider({ id: 'openai', apiFormat: 'openai' });
    const auth = new LlmConfigProviderAuth({ provider, apiKey: 'sk-abc' });
    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, {
      ...hints,
      upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions',
      sessionKey: 'anchor-key',
    });
    expect(headers['x-opencode-session']).toBe('anchor-key');
  });
});

describe('LlmConfigProviderAuth real-pool feedback', () => {
  let pool: ApiKeyPoolService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    pool?.dispose();
    vi.useRealTimers();
  });

  function createPool(keyCount: number): void {
    const rows: Record<string, ApiKeyEntry[]> = {};
    for (const providerId of ['openai', 'secondary']) {
      rows[providerId] = Array.from({ length: keyCount }, (_, index) => ({
        id: `${providerId}-${index + 1}`,
        providerId,
        label: `${providerId}-${index + 1}`,
        apiKey: `fixture-${providerId}-${index + 1}`,
        enabled: true,
        weight: 1,
        sortOrder: index,
      }));
    }
    pool = new ApiKeyPoolService(
      async (providerId) => rows[providerId] ?? [],
      (value) => value,
      { debug() {}, info() {}, warn() {}, error() {} },
    );
  }

  function auth(): LlmConfigProviderAuth {
    return new LlmConfigProviderAuth({
      provider: makeProvider({ id: 'openai', apiFormat: 'openai' }),
      apiKey: 'fixture-openai-1',
      apiKeyPool: pool,
      providerId: 'openai',
      sessionId: 'conversation',
    });
  }

  it('retries with the failed provider’s next key without rotating the last auxiliary provider', async () => {
    createPool(2);
    await pool.getKeyForSession('openai', 'conversation');
    await pool.getKeyForSession('secondary', 'conversation');
    const source = auth();

    expect(await source.onResult(429)).toEqual({
      rebound: true, newKey: 'fixture-openai-2',
    });
    const headers: Record<string, string> = {};
    source.applyHeaders(headers, hints);
    expect(headers.Authorization).toBe('Bearer fixture-openai-2');
    expect(await pool.getKeyHealth('openai')).toEqual({
      'openai-1': { until: Date.now() + 60_000, errors: 1, lastStatus: 429 },
    });
    expect(await pool.getKeyHealth('secondary')).toEqual({});
    expect(await pool.getKeyForSession('secondary', 'conversation')).toBe('fixture-secondary-1');
  });

  it('clears only the successful provider’s cooldown after both providers failed', async () => {
    createPool(1);
    await pool.getKeyForSession('openai', 'conversation');
    await pool.getKeyForSession('secondary', 'conversation');
    await pool.reportError('openai', 'conversation', 429);
    await pool.reportError('secondary', 'conversation', 529);

    await auth().onResult(200);

    expect(await pool.getKeyHealth('openai')).toEqual({});
    expect(await pool.getKeyHealth('secondary')).toEqual({
      'secondary-1': { until: Date.now() + 60_000, errors: 1, lastStatus: 529 },
    });
    expect(await pool.getKeyForSession('openai', 'conversation')).toBe('fixture-openai-1');
    expect(await pool.getPoolAvailability('secondary')).toEqual({
      outcome: 'exhausted', retryAfterSeconds: 60,
    });
  });

  it('preserves a rate-limit cooldown through server and network failures', async () => {
    createPool(1);
    await pool.getKeyForSession('openai', 'conversation');
    await pool.reportError('openai', 'conversation', 429);

    await auth().onResult(500);
    await auth().onResult(null);

    expect(await pool.getKeyHealth('openai')).toEqual({
      'openai-1': { until: Date.now() + 60_000, errors: 1, lastStatus: 429 },
    });
    expect(await pool.getPoolAvailability('openai')).toEqual({
      outcome: 'exhausted', retryAfterSeconds: 60,
    });
  });
});
