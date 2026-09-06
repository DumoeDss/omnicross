import { describe, expect, it, vi } from 'vitest';

import type { DaemonProviderConfig } from '../../config';
import {
  detectProviderKeyQuotaAdapter,
  parseClinePassUsageLimitsPayload,
  parseMiniMaxTokenPlanPayload,
  parseZaiQuotaPayload,
  providerKeyQuotaAuthHeader,
  providerKeyQuotaUrl,
} from '../ProviderKeyQuota';
import {
  PROVIDER_KEY_QUOTA_CACHE_MS,
  ProviderKeyQuotaService,
} from '../ProviderKeyQuotaService';

function zaiRow(overrides: Partial<DaemonProviderConfig> = {}): DaemonProviderConfig {
  return {
    id: 'zhipu',
    name: 'z.ai',
    apiFormat: 'openai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKey: 'key-id-1.key-secret-1',
    apiModes: [
      { id: 'standard', label: 'apiMode.standard', baseUrl: 'https://api.z.ai/api/paas/v4' },
      { id: 'coding-plan', label: 'apiMode.codingPlan', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    ],
    selectedApiModeId: 'coding-plan',
    ...overrides,
  } as DaemonProviderConfig;
}

describe('detectProviderKeyQuotaAdapter', () => {
  it('matches the Z.AI coding endpoint on both intl and CN hosts', () => {
    expect(detectProviderKeyQuotaAdapter('https://api.z.ai/api/coding/paas/v4')).toBe('zai');
    expect(detectProviderKeyQuotaAdapter('https://open.bigmodel.cn/api/coding/paas/v4')).toBe('zai');
    // The Claude Code face carries the SAME plan credential — the monitor is
    // origin-derived, so it reports quota for anthropic-face rows too.
    expect(detectProviderKeyQuotaAdapter('https://api.z.ai/api/anthropic')).toBe('zai');
    expect(detectProviderKeyQuotaAdapter('https://open.bigmodel.cn/api/anthropic')).toBe('zai');
    expect(providerKeyQuotaUrl('zai', 'https://api.z.ai/api/anthropic'))
      .toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    // The PAYG endpoint bypasses plan quota — no adapter there.
    expect(detectProviderKeyQuotaAdapter('https://api.z.ai/api/paas/v4')).toBeNull();
    expect(detectProviderKeyQuotaAdapter(undefined)).toBeNull();
  });

  it('matches the MiniMax openai /v1 surface and rejects the anthropic one', () => {
    expect(detectProviderKeyQuotaAdapter('https://api.minimax.io/v1')).toBe('minimax-token-plan');
    expect(detectProviderKeyQuotaAdapter('https://api.minimaxi.com/v1/')).toBe('minimax-token-plan');
    expect(detectProviderKeyQuotaAdapter('https://api.minimaxi.com/anthropic')).toBeNull();
  });

  it('matches the Cline Pass gateway host', () => {
    expect(detectProviderKeyQuotaAdapter('https://api.cline.bot/api/v1')).toBe('cline-pass');
    expect(providerKeyQuotaUrl('cline-pass', 'https://api.cline.bot/api/v1'))
      .toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits');
    expect(providerKeyQuotaAuthHeader('cline-pass', 'sk_1')).toBe('Bearer sk_1');
  });

  it('builds the quota URL from the row origin and the right auth header', () => {
    expect(providerKeyQuotaUrl('zai', 'https://open.bigmodel.cn/api/coding/paas/v4'))
      .toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    // Z.AI wants the RAW key (no Bearer prefix).
    expect(providerKeyQuotaAuthHeader('zai', 'abc.def')).toBe('abc.def');
    expect(providerKeyQuotaAuthHeader('minimax-token-plan', 'sk-x')).toBe('Bearer sk-x');
  });
});

describe('parseZaiQuotaPayload', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z');

  it('derives exact percent from absolute meters and keeps the most-binding per window', () => {
    const windows = parseZaiQuotaPayload({
      success: true,
      data: {
        level: 'lite',
        limits: [
          // 1438/12000 ≈ 11.98 — the rounded `percentage` says 11; absolutes win.
          { type: 'CREDIT_LIMIT', usage: 12000, currentValue: 1438, percentage: 11, remaining: 10562, nextResetTime: 1757119200, unit: 3, number: 5 },
          { type: 'CREDIT_LIMIT', usage: 60000, currentValue: 9000, percentage: 15, remaining: 51000, nextResetTime: 1757551200, unit: 6 },
          // A TIME_LIMIT on the same 5h window is MORE binding (90%) — it wins
          // the window (mirrors oh-my-pi's most-binding-per-window ranking).
          { type: 'TIME_LIMIT', usage: 100, currentValue: 90, percentage: 90, unit: 3, number: 5 },
        ],
      },
    }, now);
    expect(windows).toMatchObject([
      { id: 'five-hour', usedPercent: 90, windowMinutes: 300, state: 'fresh' },
      { id: 'seven-day', usedPercent: 15, windowMinutes: 10080 },
    ]);
  });

  it('keeps the most-binding duplicate and skips the Zread feature quota', () => {
    const windows = parseZaiQuotaPayload({
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', usage: 100, currentValue: 10, unit: 3, number: 5 },
          { type: 'CREDIT_LIMIT', usage: 100, currentValue: 50, unit: 3, number: 5 },
          { type: 'TIME_LIMIT', usage: 30, currentValue: 3, unit: 3, number: 5,
            usageDetails: [
              { modelCode: 'search-prime', usage: 1 },
              { modelCode: 'web-reader', usage: 2 },
              { modelCode: 'zread', usage: 3 },
            ] },
        ],
      },
    }, now);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: 'five-hour', usedPercent: 50 });
  });

  it('returns null for failed envelopes', () => {
    expect(parseZaiQuotaPayload({ success: false, code: 401, msg: 'unauthorized' }, now)).toBeNull();
    expect(parseZaiQuotaPayload('nope', now)).toBeNull();
  });
});

describe('parseMiniMaxTokenPlanPayload', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z');

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: 'general',
          start_time: 1757115600,
          end_time: 1757133600,
          current_interval_remaining_percent: 55.5,
          current_interval_total_count: 120,
          current_interval_usage_count: 53,
          current_interval_status: 1,
          weekly_start_time: 1756683600,
          weekly_end_time: 1757288400,
          current_weekly_remaining_percent: 80,
          current_weekly_total_count: 600,
          current_weekly_usage_count: 120,
          current_weekly_status: 1,
        },
        // A per-model bucket that must NOT be reported.
        {
          model_name: 'MiniMax-M3',
          end_time: 1757133600,
          current_interval_remaining_percent: 10,
          current_interval_status: 1,
          weekly_end_time: 1757288400,
          current_weekly_remaining_percent: 10,
          current_weekly_status: 1,
        },
      ],
      ...overrides,
    };
  }

  it('reports only the shared general bucket as interval + weekly windows', () => {
    const windows = parseMiniMaxTokenPlanPayload(payload(), now);
    expect(windows).toMatchObject([
      { id: 'five-hour', usedPercent: 44.5, state: 'fresh' },
      { id: 'seven-day', usedPercent: 20, state: 'fresh' },
    ]);
  });

  it('honors the exhausted status over the percentage and the base_resp gate', () => {
    const exhausted = payload({
      model_remains: [{
        model_name: 'general',
        current_interval_remaining_percent: 3,
        current_interval_status: 2,
        current_weekly_remaining_percent: 50,
        current_weekly_status: 1,
      }],
    });
    expect(parseMiniMaxTokenPlanPayload(exhausted, now)).toMatchObject([
      { id: 'five-hour', usedPercent: 100 },
      { id: 'seven-day', usedPercent: 50 },
    ]);
    // HTTP is always 200; a non-zero base_resp.status_code is the real failure.
    expect(parseMiniMaxTokenPlanPayload(payload({ base_resp: { status_code: 1004 } }), now)).toBeNull();
  });
});

describe('parseClinePassUsageLimitsPayload', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z');

  it('maps the three percentage windows with resets and skips unknown types', () => {
    const windows = parseClinePassUsageLimitsPayload({
      data: { limits: [
        { type: 'five_hour', percentUsed: 42.5, resetsAt: '2026-09-06T02:00:00.000Z' },
        { type: 'weekly', percentUsed: 61, resetsAt: '2026-09-08T00:00:00.000Z' },
        { type: 'monthly', percentUsed: 5, resetsAt: '2026-09-30T00:00:00.000Z' },
        { type: 'per_request', percentUsed: 99 },
      ] },
    }, now);
    expect(windows).toMatchObject([
      { id: 'five-hour', usedPercent: 42.5, windowMinutes: 300, resetsAt: '2026-09-06T02:00:00.000Z', state: 'fresh' },
      { id: 'seven-day', usedPercent: 61, windowMinutes: 10080 },
      { id: 'thirty-day', usedPercent: 5, windowMinutes: 43200 },
    ]);
  });

  it('returns null when no usable window survives', () => {
    expect(parseClinePassUsageLimitsPayload({ data: { limits: [] } }, now)).toBeNull();
    expect(parseClinePassUsageLimitsPayload({ data: { limits: [{ type: 'weekly' }] } }, now)).toBeNull();
    expect(parseClinePassUsageLimitsPayload('nope', now)).toBeNull();
  });
});

describe('ProviderKeyQuotaService', () => {
  const box = { decryptMaybe: (value: string) => value };

  it('serves the selected apiMode quota with cache + coalescing and embeds no secret', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => Response.json({
      success: true,
      data: { limits: [
        { type: 'CREDIT_LIMIT', usage: 100, currentValue: 40, unit: 3, number: 5 },
        { type: 'CREDIT_LIMIT', usage: 100, currentValue: 60, unit: 6 },
      ] },
    }));
    const service = new ProviderKeyQuotaService(box, fetchImpl, () => now);
    const row = zaiRow();

    const first = await service.quotaFor(row, 'zhipu:default');
    const second = await service.quotaFor(row, 'zhipu:default');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ adapter: 'zai' });
    expect(second?.windows).toMatchObject([
      { id: 'five-hour', usedPercent: 40 },
      { id: 'seven-day', usedPercent: 60 },
    ]);
    expect(JSON.stringify(second)).not.toContain('key-secret');

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('key-id-1.key-secret-1');

    now += PROVIDER_KEY_QUOTA_CACHE_MS + 1;
    await service.quotaFor(row, 'zhipu:default');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null for rows without an adapter and caches the 401 mismatch', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const service = new ProviderKeyQuotaService(box, fetchImpl);
    expect(await service.quotaFor(zaiRow({ selectedApiModeId: 'standard' }), 'zhipu:default')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();

    const quota = await service.quotaFor(zaiRow(), 'zhipu:default');
    expect(quota).toMatchObject({ errorCode: 'quota_unauthorized', windows: [] });
    // The mismatch is remembered — a re-read within the TTL does not re-probe.
    await service.quotaFor(zaiRow(), 'zhipu:default');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('degrades to a stale snapshot on a transient failure instead of throwing', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: true,
        data: { limits: [{ type: 'CREDIT_LIMIT', usage: 100, currentValue: 10, unit: 3, number: 5 }] },
      }))
      .mockRejectedValueOnce(new Error('upstream detail with no business in a DTO'));
    const service = new ProviderKeyQuotaService(box, fetchImpl);
    const row = zaiRow();

    const good = await service.quotaFor(row, 'zhipu:default', { force: true });
    expect(good?.windows[0]).toMatchObject({ usedPercent: 10, state: 'fresh' });

    const degraded = await service.quotaFor(row, 'zhipu:default', { force: true });
    expect(degraded?.errorCode).toBe('quota_request_failed');
    expect(degraded?.windows[0]).toMatchObject({ usedPercent: 10, state: 'stale' });
    expect(JSON.stringify(degraded)).not.toContain('upstream detail');
  });

  it('sends the row identity headers ({{platform}} expanded) on the Cline quota probe', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      data: { limits: [{ type: 'five_hour', percentUsed: 30, resetsAt: '2026-09-06T02:00:00.000Z' }] },
    }));
    const service = new ProviderKeyQuotaService(box, fetchImpl);
    const row = zaiRow({
      id: 'cline-pass',
      baseUrl: 'https://api.cline.bot/api/v1',
      apiModes: undefined,
      selectedApiModeId: undefined,
      extraHeaders: {
        'X-CLIENT-TYPE': 'cline-sdk',
        'X-PLATFORM': '{{platform}}',
        // The load guard normally strips these; the service must survive a
        // hand-written row that slipped one through — auth stays key-derived.
        Authorization: 'Bearer smuggled',
      },
    });
    const quota = await service.quotaFor(row, 'cline-pass:default');
    expect(quota).toMatchObject({ adapter: 'cline-pass' });
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk');
    expect(headers['X-PLATFORM']).toBe(process.platform);
    expect(headers.Authorization).toBe('Bearer key-id-1.key-secret-1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.cline.bot/api/v1/users/me/plan/usage-limits');
  });
});
