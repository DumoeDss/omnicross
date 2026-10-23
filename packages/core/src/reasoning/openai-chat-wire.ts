import {
  normalizeThinkLevel,
  resolveReasoningPlan,
  resolveTargetModelCapabilities,
} from './reasoning-plan';
import type { ReasoningPlan, ReasoningProvider } from './reasoning-plan';

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
  nativeThinking?: unknown,
): void {
  const resolvedPlan = plan ?? (normalizeThinkLevel(body.reasoning_effort) === 'none'
    ? resolveReasoningPlan({
        intent: { effort: 'none', enabled: false },
        model,
        provider,
        target: 'openai-chat',
        preserveNativeEffort: true,
      })
    : undefined);
  const effort = resolvedPlan?.kind === 'level'
    ? resolvedPlan.effort
    : resolvedPlan ? undefined : body.reasoning_effort;
  const baseUrl = provider.baseUrl ?? provider.api_base_url ?? '';
  let host = '';
  if (effort !== undefined) {
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      // Unknown endpoints must not select host-specific native controls.
    }
  }
  const glm = (host === 'api.z.ai' || host === 'open.bigmodel.cn')
    && /^(glm-5(?:\.[12]|\.3(?:-flash)?)?|glm-4\.7)$/.test(model);
  const qwen = (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com'
    || host === 'dashscope-us.aliyuncs.com' || host.endsWith('.maas.aliyuncs.com'))
    && /^(qwen3\.8-(?:max|flash|27b)|qwen3\.7-(?:max(?:-2026-(?:05-20|06-08))?|plus(?:-2026-05-26)?|flash(?:-2026-07-15)?)|qwen3\.6-(?:plus(?:-2026-04-02)?|flash(?:-2026-04-16)?)|qwen3\.5-(?:plus(?:-2026-02-15)?|flash(?:-2026-02-23)?)|qwen-(?:plus|flash)(?:-latest|-\d{4}-\d{2}-\d{2})?)$/.test(model);
  if (effort !== undefined && (glm || qwen)) {
    const enabled = effort !== 'none';
    delete body.reasoning_effort;
    if (glm) {
      const thinking = nativeThinking ?? body.thinking;
      body.thinking = {
        ...(thinking && typeof thinking === 'object' && !Array.isArray(thinking)
          ? thinking as Record<string, unknown> : {}),
        type: enabled ? 'enabled' : 'disabled',
      };
    } else {
      body.enable_thinking = enabled;
    }
    return;
  }
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
    // Always-thinking Kimi models have no legacy toggle.
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
  if (effort !== undefined && (
    (host === 'api.deepseek.com' && /^deepseek-(?:flash|v4-(?:flash|pro))$/.test(model))
    || (effort === 'none' && usesDeepSeekThinkingToggle(provider, model))
  )) {
    const enabled = effort !== 'none';
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) body.reasoning_effort = effort;
    else delete body.reasoning_effort;
  } else if (resolvedPlan?.kind === 'level') {
    body.reasoning_effort = resolvedPlan.effort;
  } else if (resolvedPlan) {
    delete body.reasoning_effort;
  }
}
