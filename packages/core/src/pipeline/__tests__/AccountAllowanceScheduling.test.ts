import { beforeEach, describe, expect, it } from 'vitest';

import { AccountAllowanceStore } from '../AccountAllowanceStore';
import { AccountAllowanceScheduling } from '../AccountAllowanceScheduling';

const NOW = Date.parse('2026-08-03T00:00:00.000Z');

function snapshot(store: AccountAllowanceStore, usedPercent: number, state: 'fresh' | 'stale' = 'fresh') {
  store.set({
    providerId: 'codex',
    accountId: 'a',
    source: 'response-headers',
    observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    windows: [{
      id: 'primary',
      label: '5 hours',
      scope: 'all',
      usedPercent,
      resetsAt: new Date(NOW + 60 * 60_000).toISOString(),
      state,
    }],
  });
}

describe('AccountAllowanceScheduling', () => {
  let store: AccountAllowanceStore;
  let scheduling: AccountAllowanceScheduling;

  beforeEach(() => {
    store = new AccountAllowanceStore(() => NOW);
    scheduling = new AccountAllowanceScheduling(store, () => NOW);
  });

  it('is display-only by default', () => {
    snapshot(store, 99);
    expect(scheduling.evaluate('codex', 'a', 50)).toMatchObject({
      action: 'ignore', reason: 'policy-disabled', schedulable: true, effectivePriority: 50,
    });
  });

  it('demotes a fresh account above the warning threshold', () => {
    snapshot(store, 85);
    scheduling.configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 25 });
    expect(scheduling.evaluate('codex', 'a', 50)).toMatchObject({
      action: 'demote', schedulable: true, effectivePriority: 75, usedPercent: 85,
    });
  });

  it('pauses a fresh account until a known deadline and records one deduplicated event', () => {
    snapshot(store, 99);
    scheduling.configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 25 });
    const first = scheduling.evaluate('codex', 'a', 50);
    const second = scheduling.evaluate('codex', 'a', 50);
    expect(first).toMatchObject({ action: 'pause', schedulable: false, usedPercent: 99 });
    expect(first.resumeAt).toBeTruthy();
    expect(second.action).toBe('pause');
    expect(scheduling.getHistory()).toHaveLength(1);
  });

  it('previews an allowance decision without writing decision history', () => {
    snapshot(store, 99);
    scheduling.configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 25 });

    expect(scheduling.preview('codex', 'a', 50)).toMatchObject({
      action: 'pause', schedulable: false, effectivePriority: 50, usedPercent: 99,
    });
    expect(scheduling.getHistory()).toEqual([]);
  });

  it('never gates stale, missing, unsupported, or deadline-less snapshots', () => {
    snapshot(store, 100, 'stale');
    scheduling.configure({ enabled: true, demoteAtPercent: 80, pauseAtPercent: 98, priorityPenalty: 25 });
    expect(scheduling.evaluate('codex', 'a', 50).action).toBe('ignore');
    expect(scheduling.evaluate('claude', 'missing', 50).reason).toBe('snapshot-missing');
    expect(scheduling.evaluate('gemini', 'a', 50).reason).toBe('provider-unsupported');

    store.set({
      providerId: 'codex', accountId: 'a', source: 'response-headers',
      observedAt: new Date(NOW).toISOString(),
      windows: [{ id: 'primary', label: 'Primary', scope: 'all', usedPercent: 99, state: 'fresh' }],
    });
    expect(scheduling.evaluate('codex', 'a', 50).action).toBe('demote');
  });
});
