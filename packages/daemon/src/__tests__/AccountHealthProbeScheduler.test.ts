/**
 * AccountHealthProbeScheduler tests (subscription-account-probe #8, task 5.1).
 *
 * Covers: default-off (no sweep, timer never arms) ⇒ zero regression; enabled
 * probes eligible accounts; `onlyMultiAccount` skips single-account providers
 * (never-strand — a sole account is never probed, so never marked); re-entrancy
 * guard; stagger gap; upstream 401→mark, 2xx→clear, 429/5xx→NOT auth-marked,
 * timeout/thrown→failure-only; dead-token local 401 mark with NO upstream call;
 * 403-ban body → blocked; rolling history cap; the coarse `/health` boolean; and
 * the authed admin history reader.
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import type { Logger } from '@omnicross/core';
import { DEFAULT_ACCOUNT_PROBE } from '@omnicross/core/outbound-api';
import { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AccountHealthProbeScheduler,
  type ProbeCredentialStore,
  type ProbeFetch,
} from '../AccountHealthProbeScheduler';
import type { ProbePlan } from '../probe/ProbeStrategy';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Build an AccountTokensConfig with `count` claude accounts (+ optional codex). */
function tokensConfig(claudeCount: number, codexCount = 0): AccountTokensConfig {
  const mk = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}-${i + 1}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'AT', refreshToken: 'RT' },
    }));
  return {
    updatedAt: '',
    claudeAccounts: claudeCount ? mk('claude', claudeCount) : undefined,
    codexAccounts: codexCount ? mk('codex', codexCount) : undefined,
  } as AccountTokensConfig;
}

/** A fake credential store — token lookup driven by a per-account map. */
function makeStore(
  config: AccountTokensConfig,
  tokens: Record<string, string | null> = {},
): ProbeCredentialStore {
  return {
    getFullConfig: vi.fn(async () => config),
    getAccessTokenForAccount: vi.fn(
      async (_p: SubscriptionProviderId, accountId: string) =>
        accountId in tokens ? tokens[accountId] : 'AT',
    ),
  };
}

/** A probe-plan resolver making claude upstream + everything else local. */
const upstreamClaude = (providerId: string): ProbePlan =>
  providerId === 'claude'
    ? { kind: 'upstream', url: 'https://x/models', buildInit: (t) => ({ method: 'GET', headers: { Authorization: `Bearer ${t}` } }) }
    : { kind: 'local' };

function cfg(overrides: Partial<typeof DEFAULT_ACCOUNT_PROBE> = {}) {
  return { ...DEFAULT_ACCOUNT_PROBE, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AccountHealthProbeScheduler', () => {
  it('default-off: sweep is a no-op and start() never arms the timer', async () => {
    vi.useFakeTimers();
    const store = makeStore(tokensConfig(2));
    const fetchImpl = vi.fn() as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg(), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    const sweepSpy = vi.spyOn(s, 'sweep');

    s.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await s.sweep(); // direct call — still a no-op when disabled

    expect(sweepSpy).toHaveBeenCalled();
    expect(store.getFullConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    s.dispose();
  });

  it('enabled: probes each eligible account and records history', async () => {
    const store = makeStore(tokensConfig(2));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });

    await s.sweep();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const history = s.getAllHistory();
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.records.length === 1 && h.records[0].ok && h.records[0].tier === 'upstream')).toBe(true);
  });

  it('onlyMultiAccount skips single-account providers (never-strand: sole account never probed)', async () => {
    const store = makeStore(tokensConfig(1), { 'claude-1': null }); // dead token
    const health = new SubscriptionAccountHealth();
    const fetchImpl = vi.fn() as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, onlyMultiAccount: true }), {
      fetchImpl,
      planFor: upstreamClaude,
    });

    await s.sweep();

    // A sole account is never probed → never marked → stays schedulable.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.getAccessTokenForAccount).not.toHaveBeenCalled();
    expect(health.isSchedulable('claude', 'claude-1')).toBe(true);
    expect(s.getAllHistory()).toHaveLength(0);
  });

  it('dead local token → synthesized 401 mark with NO upstream call', async () => {
    const store = makeStore(tokensConfig(2), { 'claude-1': null, 'claude-2': 'AT' });
    const health = new SubscriptionAccountHealth();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });

    await s.sweep();

    // claude-1 (dead) marked via local tier, no upstream; claude-2 probed upstream.
    expect(health.isSchedulable('claude', 'claude-1')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only claude-2
    const rec1 = s.getAllHistory().find((h) => h.accountId === 'claude-1')!;
    expect(rec1.records[0]).toMatchObject({ ok: false, status: 401, tier: 'local' });
  });

  it('upstream 401 marks, 2xx clears transient, 429/5xx do NOT mark', async () => {
    const store = makeStore(tokensConfig(2));
    const health = new SubscriptionAccountHealth();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return new Response('', { status: call === 1 ? 401 : 200 });
    }) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });

    await s.sweep();
    expect(health.isSchedulable('claude', 'claude-1')).toBe(false); // 401 marked
    expect(health.isSchedulable('claude', 'claude-2')).toBe(true); // 200 healthy

    // A 5xx must NOT mark a healthy account.
    const fetch5xx = vi.fn(async () => new Response('', { status: 503 })) as unknown as ProbeFetch;
    const s5 = new AccountHealthProbeScheduler(makeStore(tokensConfig(2)), health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl: fetch5xx,
      planFor: upstreamClaude,
    });
    await s5.sweep();
    expect(health.isSchedulable('claude', 'claude-2')).toBe(true); // still healthy after 5xx

    // A 429 (no reset header) must NOT mark either.
    const fetch429 = vi.fn(async () => new Response('', { status: 429 })) as unknown as ProbeFetch;
    const s429 = new AccountHealthProbeScheduler(makeStore(tokensConfig(2)), health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl: fetch429,
      planFor: upstreamClaude,
    });
    await s429.sweep();
    expect(health.isSchedulable('claude', 'claude-2')).toBe(true); // still healthy after 429
  });

  it('2xx probe clears a prior transient mark', async () => {
    const store = makeStore(tokensConfig(2));
    const health = new SubscriptionAccountHealth();
    // Seed a transient mark from "traffic".
    health.recordUpstreamOutcome('claude', 'claude-1', { status: 401 });
    expect(health.isSchedulable('claude', 'claude-1')).toBe(false);

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    await s.sweep();
    expect(health.isSchedulable('claude', 'claude-1')).toBe(true); // cleared by 2xx probe
  });

  it('probe 2xx heals ONLY the auth-transient mark, not a genuine rate-limit cooldown (M1)', async () => {
    const store = makeStore(tokensConfig(2));
    const health = new SubscriptionAccountHealth({ now: () => 1_000_000 });
    // Real-traffic marks on claude-1: a 429-with-reset (rate-limit until 2_000_000)
    // AND a final-401 (auth transient).
    health.recordUpstreamOutcome('claude', 'claude-1', { status: 429, resetHeaderSeconds: 2000, now: 1_000_000 });
    health.recordUpstreamOutcome('claude', 'claude-1', { status: 401, now: 1_000_000 });
    expect(health.isSchedulable('claude', 'claude-1', 1_000_000)).toBe(false);

    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
      now: () => 1_000_000,
    });
    await s.sweep();

    // The rate-limit cooldown survives (a /v1/models 200 can't attest /v1/messages
    // recovered); only the auth-transient mark was healed.
    expect(health.isSchedulable('claude', 'claude-1', 1_000_000)).toBe(false);
    expect(health.getStatus('claude', 'claude-1', 1_000_000).state).toBe('rate_limited');
  });

  it('a THROWN credential-store read is history-only, NO 401 mark (M2)', async () => {
    const config = tokensConfig(2);
    const health = new SubscriptionAccountHealth();
    const store: ProbeCredentialStore = {
      getFullConfig: vi.fn(async () => config),
      getAccessTokenForAccount: vi.fn(async (_p: SubscriptionProviderId, id: string) => {
        if (id === 'claude-1') throw new Error('decrypt hiccup');
        return 'AT';
      }),
    };
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    await s.sweep();

    // claude-1's read threw → inconclusive → NOT marked (stays schedulable).
    expect(health.isSchedulable('claude', 'claude-1')).toBe(true);
    const rec = s.getAllHistory().find((h) => h.accountId === 'claude-1')!;
    expect(rec.records[0]).toMatchObject({ ok: false, status: null, tier: 'local' });
    // A thrown read short-circuits before upstream; only claude-2 hit the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403-ban body → permanently blocked', async () => {
    const store = makeStore(tokensConfig(2));
    const health = new SubscriptionAccountHealth();
    const fetchImpl = vi.fn(async () => new Response('This organization has been disabled.', { status: 403 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    await s.sweep();
    expect(health.getStatus('claude', 'claude-1').state).toBe('blocked');
  });

  it('timeout / thrown → failure recorded, no auth mark', async () => {
    const store = makeStore(tokensConfig(2));
    const health = new SubscriptionAccountHealth();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    await s.sweep();
    // A network/timeout failure is NOT the account's fault → not marked.
    expect(health.isSchedulable('claude', 'claude-1')).toBe(true);
    const rec = s.getAllHistory().find((h) => h.accountId === 'claude-1')!;
    expect(rec.records[0]).toMatchObject({ ok: false, status: null, tier: 'upstream' });
  });

  it('staggers consecutive probes by staggerMs', async () => {
    const store = makeStore(tokensConfig(2));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const sleep = vi.fn(async () => {});
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg({ enabled: true, staggerMs: 500 }), {
      fetchImpl,
      planFor: upstreamClaude,
      sleep,
    });
    await s.sweep();
    // 2 accounts ⇒ one gap between them.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('holds the single-sweep re-entrancy guard', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const getFullConfig = vi.fn(async () => {
      await gate;
      return tokensConfig(2);
    });
    const store = { getFullConfig, getAccessTokenForAccount: vi.fn(async () => 'AT') } as unknown as ProbeCredentialStore;
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });

    const first = s.sweep(); // in-flight, awaiting the gate
    await s.sweep(); // guarded → returns immediately
    expect(getFullConfig).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(getFullConfig).toHaveBeenCalledTimes(1);
  });

  it('caps the rolling history at historySize', async () => {
    const store = makeStore(tokensConfig(2));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg({ enabled: true, staggerMs: 0, historySize: 3 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    for (let i = 0; i < 5; i += 1) await s.sweep();
    const rec = s.getAllHistory().find((h) => h.accountId === 'claude-1')!;
    expect(rec.records).toHaveLength(3); // capped, oldest dropped
  });

  it('probedAccountsHealthy reflects the tracker state of probed accounts', async () => {
    const store = makeStore(tokensConfig(2), { 'claude-1': null, 'claude-2': 'AT' });
    const health = new SubscriptionAccountHealth();
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, health, noopLogger, cfg({ enabled: true, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    expect(s.probedAccountsHealthy()).toBe(true); // nothing probed yet
    await s.sweep();
    // claude-1 dead-marked ⇒ not all probed accounts are healthy.
    expect(s.probedAccountsHealthy()).toBe(false);
  });

  it('arms on the interval when enabled', async () => {
    vi.useFakeTimers();
    const store = makeStore(tokensConfig(2));
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 })) as unknown as ProbeFetch;
    const s = new AccountHealthProbeScheduler(store, new SubscriptionAccountHealth(), noopLogger, cfg({ enabled: true, intervalMs: 60_000, staggerMs: 0 }), {
      fetchImpl,
      planFor: upstreamClaude,
    });
    const sweepSpy = vi.spyOn(s, 'sweep');
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepSpy).toHaveBeenCalled();
    s.dispose();
  });
});
