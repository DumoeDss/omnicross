/**
 * Pool-rotation SEQUENCE regression — Phase 3, task 5.3.
 *
 * Pins the EXACT report/rebind/success ordering that the host engine
 * adapter's `callWithPoolReporting` performs today, expressed against
 * `LlmConfigProviderAuth.onResult` (the class that now OWNS the rotation
 * DECISION). These tests are the byte-identical gate for routing the adapter's
 * inline decision through `onResult` (task 5.2): they encode the CURRENT
 * behavior so any drift in the decision surface fails loudly.
 *
 * The orchestration that the adapter keeps (the inline re-issue of
 * `issueCall(newKey)`, the `currentApiKeyId` re-point, the throw-path rebind)
 * is driven BY this decision; the adapter-level observable sequence is pinned
 * separately in the host adapter's own test suite ("multi-API-key-pool
 * reporting (D6)"). Together they fix the full sequence.
 *
 * Decision contract (lifted verbatim from `callWithPoolReporting`):
 *
 *   reportable status = 429 | 529 | 401 | 403
 *   - reportable on a POOL request → reportError(providerId, sessionId, status);
 *     newKey present ⇒ adopt it (auth.apiKey := newKey) and return
 *     { rebound:true, newKey } (caller re-issues ONCE inline); newKey absent ⇒
 *     { rebound:false } (no inline retry; outer loop picks up the rebind).
 *   - success / 2xx → reportSuccess(sessionId); { rebound:false }.
 *   - non-pool request (no apiKeyPool / sessionId) → never touches the pool
 *     ({ rebound:false }), matching fromPool === false.
 *   - non-reportable non-2xx (e.g. 500) / null (network) → no pool interaction.
 *
 * @module pipeline/__tests__/poolReportingSequence.test
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyPoolService } from '../../completion/ApiKeyPoolService';
import { LlmConfigProviderAuth } from '../LlmConfigProviderAuth';

function makeProvider(): LLMProvider {
  return {
    id: 'openai',
    name: 'openai',
    apiFormat: 'openai',
    api_base_url: 'https://api.example.com',
    api_key: 'unused',
    models: [],
  } as unknown as LLMProvider;
}

interface PoolDouble {
  pool: ApiKeyPoolService;
  reportError: ReturnType<typeof vi.fn>;
  reportSuccess: ReturnType<typeof vi.fn>;
  /** Records the chronological order of pool method names invoked. */
  order: string[];
}

function makePool(newKeyOnError: string | null): PoolDouble {
  const order: string[] = [];
  const reportError = vi.fn(async () => {
    order.push('reportError');
    return newKeyOnError;
  });
  const reportSuccess = vi.fn(() => {
    order.push('reportSuccess');
  });
  const pool = {
    reportError,
    reportSuccess,
    getKeyIdForSession: vi.fn(() => 'keyid-x'),
  } as unknown as ApiKeyPoolService;
  return { pool, reportError, reportSuccess, order };
}

function makePoolAuth(pool: ApiKeyPoolService): LlmConfigProviderAuth {
  return new LlmConfigProviderAuth({
    provider: makeProvider(),
    apiKey: 'sk-A',
    apiKeyPool: pool,
    providerId: 'openai',
    sessionId: 'sess-1',
  });
}

describe('poolReportingSequence — onResult decision parity with callWithPoolReporting', () => {
  // (a) reportable status (429/529/401/403) from a POOL key → reportError →
  //     newKey returned ⇒ rebind + adopt key + signal a single inline re-issue.
  it.each([429, 529, 401, 403])(
    'reportable %i on a pool key → reportError then adopt rebound newKey (rebound:true)',
    async (status) => {
      const { pool, reportError, order } = makePool('sk-B');
      const auth = makePoolAuth(pool);

      const outcome = await auth.onResult(status);

      expect(reportError).toHaveBeenCalledWith('openai', 'sess-1', status);
      expect(outcome).toEqual({ rebound: true, newKey: 'sk-B' });
      // Adapter re-points usage attribution + re-issues with this key.
      expect(auth.apiKey).toBe('sk-B');
      // reportError fired; reportSuccess NOT (the inline retry's success is
      // reported by the NEXT onResult call the orchestrator makes).
      expect(order).toEqual(['reportError']);
    },
  );

  // (a') reportable but pool returns NO key → report fires, no rebind, no
  //      inline retry (outer loop picks up the cooldown rebind naturally).
  it('reportable 429 with no rebound key → reportError only, rebound:false, key unchanged', async () => {
    const { pool, reportError, reportSuccess, order } = makePool(null);
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(429);

    expect(reportError).toHaveBeenCalledWith('openai', 'sess-1', 429);
    expect(reportSuccess).not.toHaveBeenCalled();
    expect(outcome).toEqual({ rebound: false });
    expect(auth.apiKey).toBe('sk-A');
    expect(order).toEqual(['reportError']);
  });

  // (b) success path: 2xx → reportSuccess(sessionId); never reportError.
  it('2xx success on a pool key → reportSuccess(sessionId) only', async () => {
    const { pool, reportError, reportSuccess, order } = makePool(null);
    const auth = makePoolAuth(pool);

    const outcome = await auth.onResult(200);

    expect(reportSuccess).toHaveBeenCalledWith('sess-1');
    expect(reportError).not.toHaveBeenCalled();
    expect(outcome).toEqual({ rebound: false });
    expect(order).toEqual(['reportSuccess']);
  });

  // (b') the full 429→rotate→retry-once→success sequence, as the adapter
  //      drives it: onResult(429) → { rebound, newKey } → (caller re-issues) →
  //      onResult(200) → reportSuccess. The chronological pool order across the
  //      two calls is exactly reportError, then reportSuccess.
  it('429 → rebind → retry-once → success drives [reportError, reportSuccess] in order', async () => {
    const { pool, order } = makePool('sk-B');
    const auth = makePoolAuth(pool);

    const first = await auth.onResult(429);
    expect(first).toEqual({ rebound: true, newKey: 'sk-B' });
    expect(auth.apiKey).toBe('sk-B');
    // Orchestrator now re-issues issueCall(newKey) and reports the result:
    const second = await auth.onResult(200);
    expect(second).toEqual({ rebound: false });

    expect(order).toEqual(['reportError', 'reportSuccess']);
  });

  // (c) legacy single-key (fromPool === false equivalent) → pool NEVER touched.
  it('non-pool request never touches the pool on any status', async () => {
    const { pool, reportError, reportSuccess } = makePool('sk-B');
    // Construct WITHOUT apiKeyPool/sessionId → the fromPool===false branch.
    const auth = new LlmConfigProviderAuth({ provider: makeProvider(), apiKey: 'sk-A' });

    expect(await auth.onResult(429)).toEqual({ rebound: false });
    expect(await auth.onResult(200)).toEqual({ rebound: false });
    expect(await auth.onResult(401)).toEqual({ rebound: false });
    expect(reportError).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    void pool;
  });

  // (d) non-reportable non-success status / null network error → no pool I/O.
  it('500 and null (network) status → no reportError / reportSuccess', async () => {
    const { pool, reportError, reportSuccess } = makePool(null);
    const auth = makePoolAuth(pool);

    expect(await auth.onResult(500)).toEqual({ rebound: false });
    expect(await auth.onResult(null)).toEqual({ rebound: false });
    expect(reportError).not.toHaveBeenCalled();
    expect(reportSuccess).not.toHaveBeenCalled();
    void pool;
  });
});
