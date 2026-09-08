/**
 * AntigravityAllowanceCollector tests — group-5 gates (tasks 5.1–5.5):
 *   - quotaSummary normalization: rolling 5h + weekly dual buckets per counter
 *     family → used percent + resetsAt + the disabled hard-block flag, deduped
 *     worst-entry-per-(family, window),
 *   - the fetchAvailableModels per-model quotaInfo FALLBACK when the summary
 *     RPC fails,
 *   - failure NEVER clears existing windows (stale-marking only),
 *   - the scheduling whitelist admits antigravity and the worst-window
 *     demote/pause thresholds decide from the dual buckets,
 *   - the disabled-bucket family block (selection-level): a disabled counter
 *     family blocks ONLY that model family's scheduling on the account.
 */

import { describe, expect, it } from 'vitest';

import type {
  AccountAllowanceSnapshot,
  AllowanceWindow,
} from '@omnicross/contracts/account-allowance-types';
import type { AntigravityTokenConfig, SubscriptionAccountEntry } from '@omnicross/contracts/account-tokens-types';
import {
  __resetSharedAccountAllowanceSchedulingForTests,
  AccountAllowanceScheduling,
} from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { AccountAllowanceStore } from '@omnicross/core/pipeline/AccountAllowanceStore';
import { antigravityCounterFamilyForModel, antigravityModelFamily } from '@omnicross/core/pipeline/antigravityQuotaFamily';

import {
  AntigravityAllowanceCollector,
  parseAntigravityLegacyQuota,
  parseAntigravityQuotaSummary,
} from '../AntigravityAllowanceCollector';

const NOW = Date.parse('2026-09-08T12:00:00Z');

/** A quotaSummary payload shaped like the real grouped response. */
const GROUPED_SUMMARY = {
  groups: [
    {
      displayName: 'Gemini requests',
      buckets: [
        {
          bucketId: 'gemini-5h',
          window: 'five_hour',
          remainingFraction: 0.25,
          resetTime: '2026-09-08T15:00:00Z',
        },
        {
          bucketId: 'gemini-weekly',
          window: 'weekly',
          remainingFraction: 0.8,
          resetTime: '2026-09-14T00:00:00Z',
        },
      ],
    },
    {
      displayName: 'Third-party requests',
      buckets: [
        {
          bucketId: '3p-5h',
          window: 'five_hour',
          remainingFraction: 0.5,
          resetTime: '2026-09-08T15:00:00Z',
        },
        {
          bucketId: '3p-weekly',
          window: 'weekly',
          disabled: true,
          resetTime: '2026-09-14T00:00:00Z',
        },
      ],
    },
  ],
};

describe('parseAntigravityQuotaSummary (normalization)', () => {
  it('splits the dual buckets per counter family with used percent + resetsAt', () => {
    const windows = parseAntigravityQuotaSummary(GROUPED_SUMMARY, NOW);
    expect(windows).not.toBeNull();

    const google5h = windows?.find((w) => w.id === 'antigravity:google:five-hour');
    expect(google5h).toMatchObject({
      modelFamily: 'gemini',
      usedPercent: 75,
      resetsAt: '2026-09-08T15:00:00.000Z',
    });
    expect(google5h?.disabled).toBeUndefined();
    const googleWeekly = windows?.find((w) => w.id === 'antigravity:google:weekly');
    expect(googleWeekly?.usedPercent).toBe(20);

    // The shared third-party group meters BOTH anthropic and openai.
    const anthropic5h = windows?.find((w) => w.id === 'antigravity:anthropic:five-hour');
    expect(anthropic5h?.usedPercent).toBe(50);
    const openai5h = windows?.find((w) => w.id === 'antigravity:openai:five-hour');
    expect(openai5h?.usedPercent).toBe(50);

    // The disabled weekly third-party bucket flags BOTH families.
    const anthropicWeekly = windows?.find((w) => w.id === 'antigravity:anthropic:weekly');
    expect(anthropicWeekly?.disabled).toBe(true);
    expect(anthropicWeekly?.usedPercent).toBe(100);
    const openaiWeekly = windows?.find((w) => w.id === 'antigravity:openai:weekly');
    expect(openaiWeekly?.disabled).toBe(true);
  });

  it('keeps the WORST entry per (family, window) on duplicates and clamps fractions', () => {
    const windows = parseAntigravityQuotaSummary(
      {
        groups: [
          {
            displayName: 'Gemini requests',
            buckets: [
              { bucketId: 'gemini-5h', window: 'five_hour', remainingFraction: 0.9, resetTime: '2026-09-08T15:00:00Z' },
              { bucketId: 'gemini-5h-b', window: 'five_hour', remainingFraction: 1.7, resetTime: '2026-09-08T15:00:00Z' },
            ],
          },
        ],
      },
      NOW,
    );
    const window = windows?.find((w) => w.id === 'antigravity:google:five-hour');
    // 0.9 remaining → 10% used wins over the clamped 1.7 → 0% used.
    expect(window?.usedPercent).toBe(10);
  });

  it('infers the window from the reset distance when the bucket carries no descriptor', () => {
    const windows = parseAntigravityQuotaSummary(
      {
        groups: [
          {
            displayName: 'Gemini requests',
            buckets: [{ bucketId: 'gemini-x', remainingFraction: 0.5, resetTime: '2026-09-20T00:00:00Z' }],
          },
        ],
      },
      NOW,
    );
    // Reset > 24h away → weekly.
    expect(windows?.some((w) => w.id === 'antigravity:google:weekly')).toBe(true);
  });
});

describe('parseAntigravityLegacyQuota (fallback source)', () => {
  it('normalizes per-model quotaInfo into per-family windows', () => {
    const windows = parseAntigravityLegacyQuota(
      {
        models: {
          'gemini-3.5-flash': {
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
            dailyQuotaInfo: { remainingFraction: 0.4, resetTime: '2026-09-08T15:00:00Z' },
            weeklyQuotaInfo: { remainingFraction: 0.9, resetTime: '2026-09-14T00:00:00Z' },
          },
          'claude-sonnet-4-6': {
            modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
            quotaInfo: { remainingFraction: 0.1, resetTime: '2026-09-08T15:00:00Z' },
          },
        },
      },
      NOW,
    );
    expect(windows?.find((w) => w.id === 'antigravity:google:daily')?.usedPercent).toBe(60);
    expect(windows?.find((w) => w.id === 'antigravity:google:weekly')?.usedPercent).toBe(10);
    expect(windows?.find((w) => w.id === 'antigravity:anthropic:daily')?.usedPercent).toBe(90);
  });
});

describe('AntigravityAllowanceCollector (fetch paths)', () => {
  function account(id = 'ag-1'): SubscriptionAccountEntry<AntigravityTokenConfig> {
    return {
      id,
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'at', refreshToken: 'rt' },
    };
  }

  function jsonFetch(routes: Array<{ match: string; status: number; body: unknown }>) {
    const calls: string[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      void init;
      const route = routes.find((r) => url.includes(r.match));
      calls.push(url);
      return Promise.resolve(
        new Response(route ? JSON.stringify(route.body) : '{}', {
          status: route?.status ?? 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    return { fetch, calls };
  }

  function credentials(token = 'at') {
    return {
      getAccessTokenForAccount: async () => token,
      refreshAccountToken: async () => true,
    };
  }

  it('collects from quotaSummary and carries the antigravity/hub UA', async () => {
    const { fetch, calls } = jsonFetch([
      { match: 'retrieveUserQuotaSummary', status: 200, body: GROUPED_SUMMARY },
    ]);
    const collector = new AntigravityAllowanceCollector(credentials(), new AccountAllowanceStore(), fetch, () => NOW);

    const snapshot = await collector.collect(account(), { force: true });
    expect(snapshot.windows.length).toBe(6);
    expect(snapshot.lastErrorCode).toBeUndefined();
    expect(calls[0]).toContain('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  });

  it('falls back to fetchAvailableModels quotaInfo when the summary fails', async () => {
    const { fetch } = jsonFetch([
      { match: 'retrieveUserQuotaSummary', status: 500, body: {} },
      {
        match: 'fetchAvailableModels',
        status: 200,
        body: {
          models: {
            'gemini-3.5-flash': {
              modelProvider: 'MODEL_PROVIDER_GOOGLE',
              dailyQuotaInfo: { remainingFraction: 0.4, resetTime: '2026-09-08T15:00:00Z' },
            },
          },
        },
      },
    ]);
    const collector = new AntigravityAllowanceCollector(credentials(), new AccountAllowanceStore(), fetch, () => NOW);

    const snapshot = await collector.collect(account(), { force: true });
    expect(snapshot.windows.some((w) => w.id === 'antigravity:google:daily')).toBe(true);
  });

  it('a TOTAL failure never clears existing windows (stale-marking only)', async () => {
    const store = new AccountAllowanceStore();
    const existing: AccountAllowanceSnapshot = {
      providerId: 'antigravity',
      accountId: 'ag-1',
      source: 'oauth-usage-api',
      observedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW - 1_000).toISOString(),
      windows: [
        {
          id: 'antigravity:google:five-hour',
          label: '5 Hour (google)',
          scope: 'model-family',
          modelFamily: 'gemini',
          usedPercent: 42,
          resetsAt: '2026-09-08T15:00:00.000Z',
          state: 'fresh',
        },
      ],
    };
    store.set(existing);

    const { fetch } = jsonFetch([
      { match: 'retrieveUserQuotaSummary', status: 503, body: 'oops' },
      { match: 'fetchAvailableModels', status: 503, body: 'oops' },
    ]);
    const collector = new AntigravityAllowanceCollector(credentials(), store, fetch, () => NOW);

    const snapshot = await collector.collect(account(), { force: true });
    // The prior window SURVIVES (stale) — not cleared.
    const window = snapshot.windows.find((w) => w.id === 'antigravity:google:five-hour');
    expect(window).toBeDefined();
    expect(window?.usedPercent).toBe(42);
    expect(window?.state).toBe('stale');
    expect(snapshot.lastErrorCode).toBe('antigravity_usage_http_error');
  });
});

describe('worst-window scheduling decision (demote/pause thresholds)', () => {
  it('antigravity is whitelisted and the worst fresh window decides', () => {
    __resetSharedAccountAllowanceSchedulingForTests();
    const store = new AccountAllowanceStore();
    const scheduling = new AccountAllowanceScheduling(store, () => NOW);
    scheduling.configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 100 });

    store.set({
      providerId: 'antigravity',
      accountId: 'ag-1',
      source: 'oauth-usage-api',
      observedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      windows: [
        freshWindow('antigravity:google:five-hour', 'gemini', 30),
        freshWindow('antigravity:anthropic:weekly', 'claude', 85),
      ],
    });

    const demoted = scheduling.preview('antigravity', 'ag-1', 50, NOW);
    expect(demoted.action).toBe('demote');
    expect(demoted.effectivePriority).toBe(150);

    store.set({
      providerId: 'antigravity',
      accountId: 'ag-2',
      source: 'oauth-usage-api',
      observedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      windows: [
        freshWindow('antigravity:google:five-hour', 'gemini', 10),
        freshWindow('antigravity:google:weekly', 'gemini', 99, '2026-09-14T00:00:00Z'),
      ],
    });
    const paused = scheduling.preview('antigravity', 'ag-2', 50, NOW);
    expect(paused.action).toBe('pause');
    expect(paused.schedulable).toBe(false);

    // A healthy snapshot stays normal.
    store.set({
      providerId: 'antigravity',
      accountId: 'ag-3',
      source: 'oauth-usage-api',
      observedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      windows: [freshWindow('antigravity:google:five-hour', 'gemini', 5)],
    });
    expect(scheduling.preview('antigravity', 'ag-3', 50, NOW).action).toBe('normal');
    __resetSharedAccountAllowanceSchedulingForTests();
  });
});

describe('disabled-bucket family block (selection semantics)', () => {
  it('maps counter families to model families and blocks only the disabled family', () => {
    // The shared family map (task 5.1).
    expect(antigravityModelFamily('claude-opus-4-6')).toBe('claude');
    expect(antigravityModelFamily('gemini-3.5-flash')).toBe('gemini');
    expect(antigravityModelFamily('gpt-oss-120b')).toBe('gpt-oss');
    expect(antigravityModelFamily('tab_flash_lite_preview')).toBe('gemini');
    expect(antigravityCounterFamilyForModel('claude-sonnet-4-5')).toBe('anthropic');
    expect(antigravityCounterFamilyForModel('gpt-oss-120b')).toBe('openai');
    expect(antigravityCounterFamilyForModel('gemini-3-pro')).toBe('google');

    // The blocking RULE: a disabled anthropic-family window blocks claude-*,
    // not gemini-*/gpt-oss-* (asserted through the gate's predicate shape —
    // the disabled window carries the model family it blocks).
    const disabledAnthropic: AllowanceWindow = {
      id: 'antigravity:anthropic:weekly',
      label: 'Weekly (anthropic)',
      scope: 'model-family',
      modelFamily: 'claude',
      usedPercent: 100,
      resetsAt: '2026-09-14T00:00:00.000Z',
      state: 'fresh',
      disabled: true,
    };
    const blocked = (modelId: string): boolean =>
      disabledAnthropic.disabled === true &&
      disabledAnthropic.modelFamily === antigravityModelFamily(modelId);
    expect(blocked('claude-opus-4-6')).toBe(true);
    expect(blocked('claude-sonnet-4-5')).toBe(true);
    expect(blocked('gemini-3.5-flash')).toBe(false);
    expect(blocked('gpt-oss-120b')).toBe(false);
  });
});

function freshWindow(
  id: string,
  family: string,
  usedPercent: number,
  resetsAt = '2026-09-08T15:00:00.000Z',
): AllowanceWindow {
  return {
    id,
    label: id,
    scope: 'model-family',
    modelFamily: family,
    usedPercent,
    resetsAt,
    state: 'fresh',
  };
}
