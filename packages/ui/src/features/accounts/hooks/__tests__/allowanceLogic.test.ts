import { describe, expect, it, vi } from 'vitest';

import {
  allowanceKey,
  allowanceState,
  indexAllowances,
  mergeAllowances,
  probeAndReloadCodexAllowance,
} from '../../allowanceLogic';

import type { AccountAllowanceSnapshot } from '@/daemon/types';

function snapshot(
  providerId: 'claude' | 'codex',
  accountId: string,
  usedPercent: number | null,
  state: 'fresh' | 'stale' | 'unavailable' | 'unsupported' = 'fresh',
): AccountAllowanceSnapshot {
  return {
    providerId,
    accountId,
    source: providerId === 'claude' ? 'oauth-usage-api' : 'response-headers',
    observedAt: '2026-08-03T00:00:00.000Z',
    windows: [{ id: 'five-hour', label: '5 hours', scope: 'all', usedPercent, state }],
  };
}

describe('account allowance logic', () => {
  it('keys rows by provider and account so matching account ids cannot collide', () => {
    const indexed = indexAllowances([
      snapshot('claude', 'shared', 10),
      snapshot('codex', 'shared', 20),
    ]);

    expect(indexed[allowanceKey('claude', 'shared')]?.windows[0]?.usedPercent).toBe(10);
    expect(indexed[allowanceKey('codex', 'shared')]?.windows[0]?.usedPercent).toBe(20);
  });

  it('updates one account without dropping another account after an isolated refresh', () => {
    const merged = mergeAllowances(
      [snapshot('claude', 'one', 10), snapshot('claude', 'two', 20)],
      [snapshot('claude', 'one', 35)],
    );

    expect(indexAllowances(merged)[allowanceKey('claude', 'one')]?.windows[0]?.usedPercent).toBe(35);
    expect(indexAllowances(merged)[allowanceKey('claude', 'two')]?.windows[0]?.usedPercent).toBe(20);
  });

  it('summarizes mixed windows by their most useful visible state', () => {
    const mixed = snapshot('codex', 'one', 10, 'stale');
    mixed.windows.push({
      id: 'seven-day',
      label: '7 days',
      scope: 'all',
      usedPercent: 50,
      state: 'fresh',
    });

    expect(allowanceState(mixed)).toBe('fresh');
    expect(allowanceState(snapshot('claude', 'two', null, 'unavailable'))).toBe('unavailable');
  });

  it('runs a real Codex probe before reloading the allowance snapshot', async () => {
    const calls: string[] = [];
    const result = await probeAndReloadCodexAllowance(
      async () => {
        calls.push('probe');
        return { success: true, ok: true, marked: false, tier: 'generation', model: 'gpt-5.6-luna' };
      },
      async () => {
        calls.push('reload');
        return { success: true };
      },
    );

    expect(calls).toEqual(['probe', 'reload']);
    expect(result).toEqual({ success: true });
  });

  it('still reloads after a failed Codex probe and surfaces the probe failure', async () => {
    const reload = vi.fn(async () => ({ success: true }));
    const result = await probeAndReloadCodexAllowance(
      async () => ({ success: true, ok: false, marked: false, tier: 'generation' }),
      reload,
    );

    expect(reload).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: false, message: 'Codex Luna allowance probe failed' });
  });
});
