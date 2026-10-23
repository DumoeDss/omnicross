import { describe, expect, it } from 'vitest';
import { subscriptionModelDefaults, withSubscriptionDefaults } from '../anthropicSubscriptionPlan';

describe('subscription model defaults', () => {
  const config = {
    modelMap: { default: { modelId: 'primary', temperature: 0.2, maxTokens: 90 } },
    fallbacks: { default: [{ modelId: 'fallback', temperature: 0.8, maxTokens: 70 }] },
  };

  it('looks up the actual target without mapping it again or inheriting another target', () => {
    expect(subscriptionModelDefaults(config, 'fallback')).toEqual({ temperature: 0.8, maxTokens: 70 });
    expect(subscriptionModelDefaults(config, 'unknown')).toEqual({});
  });

  it('preserves explicit zero and completion-token limits', () => {
    expect(withSubscriptionDefaults(
      { temperature: 0, max_completion_tokens: 12 }, 'primary',
      subscriptionModelDefaults(config, 'primary'), 'max_tokens',
    )).toEqual({ model: 'primary', temperature: 0, max_completion_tokens: 12 });
  });

  it('maps defaults to Responses fields without mutating the caller', () => {
    const body = { input: 'hello' };
    expect(withSubscriptionDefaults(body, 'primary', config.modelMap.default, 'max_output_tokens'))
      .toEqual({ input: 'hello', model: 'primary', temperature: 0.2, max_output_tokens: 90 });
    expect(body).toEqual({ input: 'hello' });
  });
});
