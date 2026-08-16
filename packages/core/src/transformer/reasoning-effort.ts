/**
 * Compatibility re-export. The shared reasoning-plan module is the sole owner
 * of normalization, capability resolution, negotiation, and budget policy.
 */
export {
  extractReasoningIntent,
  normalizeThinkLevel,
  resolveReasoningEffort,
  resolveReasoningPlan,
  resolveReasoningTokenLimit,
  resolveRequestReasoning,
  resolveTargetModelCapabilities,
  THINK_LEVELS,
} from '../reasoning/reasoning-plan';

export type {
  ReasoningIntent,
  ReasoningPlan,
  ReasoningProvider,
  ReasoningTarget,
  ResolveReasoningPlanInput,
  ResolveRequestReasoningOptions,
} from '../reasoning/reasoning-plan';
