import { describe, expect, it } from 'vitest';

import { DEFAULT_ALLOWANCE_SCHEDULING, recentAppliedDecisions, validateAllowanceScheduling } from '../allowanceSchedulingLogic';

describe('allowance scheduling settings logic', () => {
  it('defaults off and validates safe ordered thresholds', () => {
    expect(DEFAULT_ALLOWANCE_SCHEDULING.enabled).toBe(false);
    expect(validateAllowanceScheduling(DEFAULT_ALLOWANCE_SCHEDULING)).toBeNull();
    expect(validateAllowanceScheduling({ ...DEFAULT_ALLOWANCE_SCHEDULING, pauseAtPercent: 70 })).toBe('order');
    expect(validateAllowanceScheduling({ ...DEFAULT_ALLOWANCE_SCHEDULING, priorityPenalty: 0 })).toBe('penalty');
  });

  it('shows only recent applied decisions newest first', () => {
    const common = { providerId: 'claude' as const, accountId: 'a', reason: 'below-threshold' as const, basePriority: 50, effectivePriority: 50, schedulable: true };
    const result = recentAppliedDecisions([
      { ...common, action: 'normal', decidedAt: '2026-01-01T00:00:00Z' },
      { ...common, action: 'demote', reason: 'demote-threshold', decidedAt: '2026-01-02T00:00:00Z' },
      { ...common, action: 'pause', reason: 'pause-threshold', decidedAt: '2026-01-03T00:00:00Z' },
    ]);
    expect(result.map((decision) => decision.action)).toEqual(['pause', 'demote']);
  });
});
