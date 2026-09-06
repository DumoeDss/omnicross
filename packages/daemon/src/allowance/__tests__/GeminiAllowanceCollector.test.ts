/**
 * GeminiAllowanceCollector.test.ts — the `v1internal:retrieveUserQuota` bucket
 * parse (per-model fractions → percent windows, dedupe, clamping) plus the
 * collector's probe behavior: shared-resolver project threading, masquerade
 * headers, the 401→refresh→retry path, and handshake-failure degradation to a
 * project-less probe.
 */

import { describe, expect, it, vi } from 'vitest';

import type { GeminiTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';

import { GeminiAllowanceCollector, parseGeminiQuotaPayload } from '../GeminiAllowanceCollector';

const NOW = Date.parse('2026-09-07T00:00:00.000Z');

describe('parseGeminiQuotaPayload', () => {
  it('maps per-model buckets to model-family percent windows', () => {
    const windows = parseGeminiQuotaPayload({
      buckets: [
        { modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-09-07T05:00:00Z' },
        { modelId: 'gemini-2.5-flash', remainingFraction: 1, resetTime: '2026-09-07T05:00:00Z' },
      ],
    }, NOW)!;
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      id: 'gemini:gemini-2.5-pro',
      scope: 'model-family',
      modelFamily: 'gemini-2.5-pro',
      usedPercent: 75,
      resetsAt: '2026-09-07T05:00:00.000Z',
      state: 'fresh',
    });
    expect(windows[1]).toMatchObject({ usedPercent: 0 });
  });

  it('a bucket without modelId becomes the account-wide window; duplicates dedupe', () => {
    const windows = parseGeminiQuotaPayload({
      buckets: [
        { remainingFraction: 0.5 },
        { remainingFraction: 0.1 },
      ],
    }, NOW)!;
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: 'gemini:all', scope: 'all', usedPercent: 50 });
    expect(windows[0].resetsAt).toBeUndefined();
  });

  it('clamps out-of-range fractions and tolerates a missing fraction', () => {
    const windows = parseGeminiQuotaPayload({
      buckets: [
        { modelId: 'a', remainingFraction: -0.5 },
        { modelId: 'b', remainingFraction: 1.75 },
        { modelId: 'c', resetTime: '2026-09-07T01:00:00Z' },
      ],
    }, NOW)!;
    expect(windows[0]).toMatchObject({ usedPercent: 100 });
    expect(windows[1]).toMatchObject({ usedPercent: 0 });
    expect(windows[2]).toMatchObject({ usedPercent: null, resetsAt: '2026-09-07T01:00:00.000Z' });
  });

  it('returns null without usable buckets', () => {
    expect(parseGeminiQuotaPayload({}, NOW)).toBeNull();
    expect(parseGeminiQuotaPayload({ buckets: [] }, NOW)).toBeNull();
    expect(parseGeminiQuotaPayload('nope', NOW)).toBeNull();
  });
});

function geminiAccount(overrides: Partial<GeminiTokenConfig> = {}): SubscriptionAccountEntry<GeminiTokenConfig> {
  return { id: 'acct-1', tokens: { authMethod: 'oauth', status: 'authorized', ...overrides } };
}

describe('GeminiAllowanceCollector', () => {
  function build(responses: Response[], options: { project?: string | undefined; projectThrows?: boolean } = {}) {
    const fetchImpl = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error('no more canned responses');
      return next;
    });
    const refreshAccountToken = vi.fn(async () => true);
    const getAccessTokenForAccount = vi.fn(async () => 'ya29-token');
    const resolveProject = vi.fn(async () => {
      if (options.projectThrows) throw new Error('handshake hard failure');
      return options.project;
    });
    const store = new AccountAllowanceStore();
    const collector = new GeminiAllowanceCollector(
      { getAccessTokenForAccount, refreshAccountToken },
      store,
      fetchImpl as unknown as never,
      () => NOW,
      { resolveProject },
    );
    return { collector, fetchImpl, refreshAccountToken, getAccessTokenForAccount, resolveProject, store };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  it('probes retrieveUserQuota with the masquerade identity and threads the project', async () => {
    const { collector, fetchImpl } = build(
      [json({ buckets: [{ modelId: 'gemini-2.5-pro', remainingFraction: 0.25, resetTime: '2026-09-07T05:00:00Z' }] })],
      { project: 'my-proj' },
    );
    const snapshot = await collector.collect(geminiAccount(), { force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ya29-token');
    expect(headers['User-Agent']).toMatch(/^GeminiCLI\//);
    expect(headers['Client-Metadata']).toContain('pluginType=GEMINI');
    expect(init.body).toBe(JSON.stringify({ project: 'my-proj' }));
    expect(snapshot.windows[0]).toMatchObject({ id: 'gemini:gemini-2.5-pro', usedPercent: 75 });
  });

  it('degrades to a project-less probe when the handshake hard-fails (free-tier envelope)', async () => {
    const { collector, fetchImpl } = build([json({ buckets: [{ remainingFraction: 0.9 }] })], {
      projectThrows: true,
    });
    const snapshot = await collector.collect(geminiAccount(), { force: true });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{}');
    expect(snapshot.windows[0]).toMatchObject({ id: 'gemini:all', usedPercent: 10 });
  });

  it('refreshes once on 401 and retries with the fresh token', async () => {
    const { collector, fetchImpl, refreshAccountToken, getAccessTokenForAccount } = build([
      json({ error: 'unauthorized' }, 401),
      json({ buckets: [{ remainingFraction: 0.5 }] }),
    ]);
    getAccessTokenForAccount.mockResolvedValueOnce('ya29-stale').mockResolvedValue('ya29-fresh');
    const snapshot = await collector.collect(geminiAccount(), { force: true });
    expect(refreshAccountToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchImpl.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer ya29-fresh');
    expect(snapshot.windows[0]).toMatchObject({ usedPercent: 50 });
  });

  it('marks the snapshot unauthorized when the retry still fails', async () => {
    const { collector } = build([json({ error: 'unauthorized' }, 401), json({ error: 'unauthorized' }, 401)]);
    const snapshot = await collector.collect(geminiAccount(), { force: true });
    expect(snapshot.lastErrorCode).toBe('gemini_usage_unauthorized');
    expect(snapshot.windows.every((w) => w.state !== 'fresh')).toBe(true);
  });

  it('serves the 5-minute cache without a second probe', async () => {
    const { collector, fetchImpl } = build([json({ buckets: [{ remainingFraction: 0.5 }] })]);
    await collector.collect(geminiAccount(), { force: true });
    const cached = await collector.collect(geminiAccount());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.observedAt).toBe(new Date(NOW).toISOString());
  });

  it('non-oauth accounts are unsupported without a probe', async () => {
    const { collector, fetchImpl } = build([]);
    const snapshot = await collector.collect(geminiAccount({ authMethod: 'manual' }), { force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.windows[0]).toMatchObject({ state: 'unsupported' });
  });
});
