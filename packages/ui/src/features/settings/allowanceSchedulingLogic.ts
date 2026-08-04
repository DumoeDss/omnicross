import type { AllowanceSchedulingConfig, AllowanceSchedulingDecision } from '@/daemon/types-server';

export const DEFAULT_ALLOWANCE_SCHEDULING: AllowanceSchedulingConfig = {
  enabled: false,
  demoteAtPercent: 80,
  pauseAtPercent: 98,
  priorityPenalty: 100,
};

export function validateAllowanceScheduling(config: AllowanceSchedulingConfig): 'demote' | 'pause' | 'order' | 'penalty' | null {
  if (!Number.isFinite(config.demoteAtPercent) || config.demoteAtPercent < 0 || config.demoteAtPercent > 100) return 'demote';
  if (!Number.isFinite(config.pauseAtPercent) || config.pauseAtPercent < 0 || config.pauseAtPercent > 100) return 'pause';
  if (config.pauseAtPercent < config.demoteAtPercent) return 'order';
  if (!Number.isInteger(config.priorityPenalty) || config.priorityPenalty < 1 || config.priorityPenalty > 1_000) return 'penalty';
  return null;
}

export function recentAppliedDecisions(history: AllowanceSchedulingDecision[], limit = 12): AllowanceSchedulingDecision[] {
  return history
    .filter((decision) => decision.action === 'demote' || decision.action === 'pause')
    .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt))
    .slice(0, limit);
}
