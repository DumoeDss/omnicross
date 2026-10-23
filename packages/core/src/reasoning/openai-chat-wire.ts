import {
  normalizeThinkLevel,
  resolveTargetModelCapabilities,
  type ReasoningPlan,
  type ReasoningProvider,
} from './reasoning-plan';

/** DeepSeek's discrete-thinking Chat Completions API uses a toggle, not effort:none. */
export function usesDeepSeekThinkingToggle(
  provider: ReasoningProvider | undefined,
  model: string,
): boolean {
  if (!provider || !(
    /deepseek/i.test(provider.name ?? '') ||
    /deepseek/i.test(provider.baseUrl ?? provider.api_base_url ?? '')
  )) return false;
  return !!resolveTargetModelCapabilities(model, provider).thinkingLevels?.length;
}

/** Encode the negotiated Chat policy in place, preserving unrelated native fields. */
export function applyOpenAIChatReasoning(
  body: Record<string, unknown>,
  plan: ReasoningPlan | undefined,
  provider: ReasoningProvider,
  model: string,
): void {
  const effort = plan?.kind === 'level'
    ? plan.effort
    : plan ? undefined : body.reasoning_effort;
  const baseUrl = provider.baseUrl ?? provider.api_base_url ?? '';
  if (/kimi|moonshot/i.test(provider.name ?? '') || /kimi|moonshot/i.test(baseUrl)) {
    const levels = resolveTargetModelCapabilities(model, provider).thinkingLevels;
    if (!levels?.length) {
      delete body.reasoning_effort;
      return;
    }
    if (levels.includes('none')) {
      const nativeEffort = normalizeThinkLevel(effort);
      if (nativeEffort) {
        body.thinking = { type: nativeEffort === 'none' ? 'disabled' : 'enabled' };
      }
      delete body.reasoning_effort;
      return;
    }
    // Always-thinking Kimi models have no supported off control.
    if (effort === 'none') {
      delete body.reasoning_effort;
      return;
    }
  }
  // Native dialects without a verified off encoding must keep their defaults;
  // a semantic `none` capability is not evidence for OpenAI's wire spelling.
  if (effort === 'none' && (
    /mimo|grok|copilot/i.test(provider.name ?? '') ||
    /xiaomimimo|api\.x\.ai|githubcopilot/i.test(baseUrl)
  )) {
    delete body.reasoning_effort;
    return;
  }
  if (effort === 'none' && usesDeepSeekThinkingToggle(provider, model)) {
    body.thinking = { type: 'disabled' };
    delete body.reasoning_effort;
  } else if (plan?.kind === 'level') {
    body.reasoning_effort = plan.effort;
  } else if (plan) {
    delete body.reasoning_effort;
  }
}
