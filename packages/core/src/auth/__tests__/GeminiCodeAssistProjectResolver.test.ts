/**
 * GeminiCodeAssistProjectResolver tests — deterministic, mocked fetch, NO live
 * network. Asserts the loadCodeAssist → onboardUser → poll handshake sequence,
 * the free-tier `cloudaicompanionProject: undefined` rule, project caching
 * (handshake runs once per token), and graceful handling of 403 / 429.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FetchLike,
  GeminiCodeAssistHandshakeError,
  GeminiCodeAssistProjectResolver,
} from '../GeminiCodeAssistProjectResolver';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Extract the method name (segment after the colon) from a Code Assist URL. */
function methodOf(url: string): string {
  return url.split(':').pop()?.split('?')[0] ?? '';
}

describe('GeminiCodeAssistProjectResolver', () => {
  beforeEach(() => {
    // Keep poll latency near-zero for the LRO test.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  });

  it('returns the existing project when loadCodeAssist reports a currentTier (no onboard)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      calls.push(methodOf(url));
      return jsonResponse({
        currentTier: { id: 'standard-tier' },
        cloudaicompanionProject: 'existing-proj',
      });
    });
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    const project = await resolver.resolveProject('tok-A');
    expect(project).toBe('existing-proj');
    expect(calls).toEqual(['loadCodeAssist']); // no onboardUser
  });

  it('free-tier onboard MUST send cloudaicompanionProject: undefined', async () => {
    const onboardBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = vi.fn(async (url: string, init) => {
      const method = methodOf(url);
      if (method === 'loadCodeAssist') {
        return jsonResponse({
          allowedTiers: [{ id: 'free-tier', isDefault: true }],
        });
      }
      if (method === 'onboardUser') {
        onboardBodies.push(JSON.parse(init.body as string));
        // LRO done immediately, no project (free-tier).
        return jsonResponse({ done: true, response: {} });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    const project = await resolver.resolveProject('tok-free');
    expect(project).toBeUndefined();
    expect(onboardBodies).toHaveLength(1);
    expect(onboardBodies[0].tierId).toBe('free-tier');
    expect(onboardBodies[0].cloudaicompanionProject).toBeUndefined();
  });

  it('polls getOperation until the LRO is done, then reads the project id', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'my-standard-proj';
    const calls: string[] = [];
    let pollCount = 0;
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      const method = methodOf(url);
      calls.push(method);
      if (method === 'loadCodeAssist') {
        return jsonResponse({
          allowedTiers: [{ id: 'standard-tier', isDefault: true }],
        });
      }
      if (method === 'onboardUser') {
        return jsonResponse({ name: 'operations/123', done: false });
      }
      if (method === 'getOperation') {
        pollCount++;
        if (pollCount < 2) return jsonResponse({ name: 'operations/123', done: false });
        return jsonResponse({
          name: 'operations/123',
          done: true,
          response: { cloudaicompanionProject: { id: 'onboarded-proj' } },
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    const promise = resolver.resolveProject('tok-std');
    // Advance through the two poll delays.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const project = await promise;

    expect(project).toBe('onboarded-proj');
    expect(calls[0]).toBe('loadCodeAssist');
    expect(calls[1]).toBe('onboardUser');
    expect(calls.filter((c) => c === 'getOperation').length).toBe(2);
  });

  it('caches the resolution — handshake runs ONCE per token', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'cached-proj' }),
    );
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    const a = await resolver.resolveProject('tok-cache');
    const b = await resolver.resolveProject('tok-cache');
    expect(a).toBe('cached-proj');
    expect(b).toBe('cached-proj');
    // loadCodeAssist fired exactly once across both calls.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight handshake across concurrent callers', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'p' }),
    );
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    const [a, b, c] = await Promise.all([
      resolver.resolveProject('tok-cc'),
      resolver.resolveProject('tok-cc'),
      resolver.resolveProject('tok-cc'),
    ]);
    expect(a).toBe('p');
    expect(b).toBe('p');
    expect(c).toBe('p');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clear error on 403 SERVICE_DISABLED / PERMISSION_DENIED (not cached)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse(
        { error: { status: 'PERMISSION_DENIED', message: 'Cloud AI Companion API disabled' } },
        403,
      ),
    );
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    await expect(resolver.resolveProject('tok-403')).rejects.toBeInstanceOf(
      GeminiCodeAssistHandshakeError,
    );
    try {
      await resolver.resolveProject('tok-403');
    } catch (err) {
      expect((err as GeminiCodeAssistHandshakeError).status).toBe(403);
    }
    // Not cached on failure → a retry hits the network again.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a clear error on 429 rate-limit', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }, 429),
    );
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    await expect(resolver.resolveProject('tok-429')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('rejects a purely-numeric GOOGLE_CLOUD_PROJECT seed (project NUMBER, not id)', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = '1234567890';
    let loadBody: Record<string, unknown> | undefined;
    const fetchImpl: FetchLike = vi.fn(async (url: string, init) => {
      if (methodOf(url) === 'loadCodeAssist') {
        loadBody = JSON.parse(init.body as string);
        return jsonResponse({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'p' });
      }
      throw new Error('unexpected');
    });
    const resolver = new GeminiCodeAssistProjectResolver(fetchImpl);

    await resolver.resolveProject('tok-num');
    // The numeric seed is dropped → loadCodeAssist sends no project.
    expect(loadBody?.cloudaicompanionProject).toBeUndefined();
  });
});
