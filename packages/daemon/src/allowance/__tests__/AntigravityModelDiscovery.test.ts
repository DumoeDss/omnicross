/**
 * AntigravityModelDiscovery + antigravity doctor tests — group-6 gates
 * (tasks 6.1/6.2):
 *   - denylist filtering (chat_20706 / chat_23310 / gemini-2.5-pro never
 *     surface) + `isInternal` filtering,
 *   - the static-priority merge: a conflicting dynamic id is dropped + logged;
 *     genuinely new ids append with their metadata,
 *   - the admin route answers the static baseline when the token is absent or
 *     the upstream is unreachable (never fails on discovery),
 *   - the doctor checks: credential presence (hard), token freshness (warn in
 *     the lead window), --live refresh + quota probes.
 */

import type { AccountAllowanceSnapshot } from '@omnicross/contracts/account-allowance-types';
import { lookupCanonicalCapabilities } from '@omnicross/contracts/canonical-models';
import { describe, expect, it, vi } from 'vitest';

import {
  buildAntigravityDoctorChecks,
  buildAntigravityLiveChecks,
  hasFreshAntigravityQuota,
  type AntigravityDoctorSnapshot,
} from '../../commands/doctor';
import {
  handleAntigravityModelsRoute,
  mergeAntigravityCatalog,
  parseAntigravityAvailableModels,
} from '../AntigravityModelDiscovery';

describe('parseAntigravityAvailableModels', () => {
  it('filters the denylist and internal-only ids, extracts metadata', () => {
    const models = parseAntigravityAvailableModels({
      models: {
        'chat_20706': { displayName: 'internal chat' },
        'chat_23310': { displayName: 'internal chat 2' },
        'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro' },
        'some-internal': { displayName: 'x', isInternal: true },
        'gemini-3.9-flash': {
          displayName: 'Gemini 3.9 Flash',
          supportsImages: true,
          supportsThinking: true,
          thinkingBudget: 8192,
          maxTokens: 1048576,
        },
      },
    });
    expect(models.map((m) => m.id)).toEqual(['gemini-3.9-flash']);
    expect(models[0]).toEqual({
      id: 'gemini-3.9-flash',
      displayName: 'Gemini 3.9 Flash',
      supportsImages: true,
      supportsThinking: true,
      thinkingBudget: 8192,
      maxTokens: 1048576,
    });
  });
});

describe('mergeAntigravityCatalog (static priority)', () => {
  const STATIC = ['gemini-3.5-flash', 'claude-opus-4-6'];

  it('keeps the static entry on a conflict and LOGS it', () => {
    const log = vi.fn();
    const merged = mergeAntigravityCatalog(
      [
        { id: 'gemini-3.5-flash', displayName: 'dynamic shadow' },
        { id: 'gemini-3.9-flash', displayName: 'Gemini 3.9 Flash' },
      ],
      log,
      STATIC,
    );
    const conflict = merged.find((entry) => entry.id === 'gemini-3.5-flash');
    expect(conflict?.origin).toBe('static');
    expect(conflict?.displayName).toBe('gemini-3.5-flash');
    expect(conflict?.maxTokens).toBe(lookupCanonicalCapabilities('gemini-3.5-flash')?.contextLength);
    expect(conflict?.maxOutputTokens).toBe(lookupCanonicalCapabilities('gemini-3.5-flash')?.maxTokens);
    expect(merged.find((entry) => entry.id === 'gemini-3.9-flash')?.origin).toBe('discovered');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("dynamic model 'gemini-3.5-flash' conflicts");
  });

  it('appends genuinely new ids after the static block', () => {
    const merged = mergeAntigravityCatalog([{ id: 'zzz-new-model' }], () => {}, STATIC);
    expect(merged.map((entry) => entry.id)).toEqual(['gemini-3.5-flash', 'claude-opus-4-6', 'zzz-new-model']);
  });
});

describe('handleAntigravityModelsRoute', () => {
  it('answers the static baseline when no token is available (discovered: false)', async () => {
    const result = await handleAntigravityModelsRoute({
      resolveAntigravityAccessToken: async () => null,
    });
    expect(result.status).toBe(200);
    const body = result.body as { models: Array<{ id: string }>; discovered: boolean };
    expect(body.discovered).toBe(false);
    expect(body.models.length).toBe(18); // the static census
    expect(body.models[0]?.id).toBe('tab_flash_lite_preview');
  });

  it('keeps the offline baseline on credential or malformed-payload failures', async () => {
    const unavailable = await handleAntigravityModelsRoute({
      resolveAntigravityAccessToken: async () => { throw new Error('credential unavailable'); },
    });
    expect(unavailable.body).toMatchObject({ discovered: false });
    for (const body of ['not json', '{}', '{"models":null}']) {
      const malformed = await handleAntigravityModelsRoute({
        resolveAntigravityAccessToken: async () => 'token',
        fetchImpl: async () => new Response(body),
      });
      expect(malformed.body).toMatchObject({ discovered: false });
    }
  });

  it('fetchAntigravityAvailableModels parses a live payload via the injected fetch', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ models: { 'gemini-3.9-flash': { displayName: 'Gemini 3.9 Flash' } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const { fetchAntigravityAvailableModels } = await import('../AntigravityModelDiscovery');
    const discovered = await fetchAntigravityAvailableModels('token', fetchImpl);
    expect(discovered).toEqual([{ id: 'gemini-3.9-flash', displayName: 'Gemini 3.9 Flash' }]);
    // A non-2xx upstream degrades to null (the caller keeps the static baseline).
    const failing = await fetchAntigravityAvailableModels('token', async () => new Response('', { status: 503 }));
    expect(failing).toBeNull();
  });
});

describe('antigravity doctor checks', () => {
  it('flags a missing credential (hard) and summarizes accounts', () => {
    const checks = buildAntigravityDoctorChecks({
      accountCount: 0,
      hasAccessToken: false,
      expired: false,
    });
    expect(checks[0]).toMatchObject({ name: 'antigravity credential', ok: false });
    expect(checks[0]?.detail).toContain('omnicross login antigravity');
    expect(checks[1]).toMatchObject({ name: 'token freshness', ok: true });
  });

  it('warns inside the refresh lead window and fails an expired account', () => {
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    const warn = buildAntigravityDoctorChecks({
      accountCount: 1,
      activeEmail: 'dev@example.com',
      hasAccessToken: true,
      expired: false,
      expiresAt: soon,
    });
    expect(warn[0]?.ok).toBe(true);
    expect(warn[1]?.warn).toBe(true);

    const expired = buildAntigravityDoctorChecks({
      accountCount: 1,
      hasAccessToken: true,
      expired: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(expired[1]?.ok).toBe(false);
  });

  it('rejects expired tokens even before the stored status updates', () => {
    const checks = buildAntigravityDoctorChecks({
      accountCount: 1, hasAccessToken: true, expired: false,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(checks[1]?.ok).toBe(false);
  });

  it('requires fresh successful quota observations, including disabled windows', () => {
    const now = Date.now();
    const snapshot: AccountAllowanceSnapshot = {
      providerId: 'antigravity', accountId: 'a', source: 'oauth-usage-api',
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      windows: [{ id: 'five-hour', label: '5h', scope: 'all', usedPercent: 10, state: 'fresh' }],
    };
    expect(hasFreshAntigravityQuota(snapshot, now)).toBe(true);
    expect(hasFreshAntigravityQuota({ ...snapshot, lastErrorCode: 'http_error' }, now)).toBe(false);
    expect(hasFreshAntigravityQuota(snapshot, now + 60_001)).toBe(false);
    expect(hasFreshAntigravityQuota({ ...snapshot, windows: [{ ...snapshot.windows[0]!, state: 'stale' }] }, now)).toBe(false);
    expect(hasFreshAntigravityQuota({ ...snapshot, windows: [{ ...snapshot.windows[0]!, disabled: true, usedPercent: null }] }, now)).toBe(true);
  });

  it('projects the --live probe outcomes', () => {
    const snapshot: AntigravityDoctorSnapshot = {
      accountCount: 1,
      hasAccessToken: true,
      expired: false,
    };
    void snapshot;
    const ok = buildAntigravityLiveChecks({ refreshOk: true, quotaOk: true, detail: '' });
    expect(ok.every((check) => check.ok)).toBe(true);
    const failed = buildAntigravityLiveChecks({
      refreshOk: false,
      quotaOk: false,
      detail: 'antigravity_usage_http_error',
    });
    expect(failed.every((check) => !check.ok)).toBe(true);
    expect(failed[1]?.detail).toContain('antigravity_usage_http_error');
  });
});
