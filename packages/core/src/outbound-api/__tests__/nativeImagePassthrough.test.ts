/**
 * nativeImagePassthrough — the "image feature OFF" relay must keep an upstream
 * that natively speaks images working (codex subscription / official OpenAI),
 * and must NOT guess at anything else.
 */
import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import {
  resolveNativeImagePassthrough,
  type NativeImagePassthroughPlan,
} from '../nativeImagePassthrough';
import type { EndpointRoutingConfig, GatewayBindingTarget } from '../types';
import { setSubscriptionRegistryForOutbound } from '../subscriptionRegistryPort';

function fakeCodexStrategy(seen: Array<Record<string, unknown>>): AuthStrategy {
  return {
    kind: 'oauth-bearer',
    providerId: 'codex',
    async applyHeaders(headers: Record<string, string>, hints?: Record<string, unknown>) {
      seen.push(hints ?? {});
      headers['Authorization'] = 'Bearer codex-access-token';
    },
    async onUnauthorized() {
      return false;
    },
    async describeStatus() {
      return { providerId: 'codex', ok: true } as never;
    },
  } as unknown as AuthStrategy;
}

function wireCodexProfile(strategy: AuthStrategy): void {
  setSubscriptionRegistryForOutbound({
    getProfile: (providerId) =>
      providerId === 'codex'
        ? {
            providerId: 'codex',
            displayName: 'Codex (ChatGPT OAuth)',
            authStrategy: strategy,
            mode: 'transformer',
            resolveUpstreamUrl: () => 'https://chatgpt.com/backend-api/codex/responses',
            providerTransformerNames: ['openai-response'],
            modelTransformerNames: [],
          }
        : null,
  });
}

const responsesConfig: EndpointRoutingConfig = {
  endpoint: 'responses',
  useSubscription: true,
};

function target(kind: GatewayBindingTarget['kind'], providerId: string): GatewayBindingTarget {
  return kind === 'provider'
    ? { kind, providerId }
    : kind === 'account'
      ? { kind, providerId, accountId: 'acct-1' }
      : kind === 'account-group'
        ? { kind, providerId, group: 'main' }
        : { kind, providerId };
}

function llmConfigFor(provider: LLMProvider | null) {
  return { getProvider: vi.fn(async () => provider) };
}

afterEach(() => {
  setSubscriptionRegistryForOutbound(null);
});

describe('resolveNativeImagePassthrough', () => {
  it('relays a codex-subscription target to the Codex images wire with OAuth + CLI markers', async () => {
    const hints: Array<Record<string, unknown>> = [];
    wireCodexProfile(fakeCodexStrategy(hints));

    const plan = await resolveNativeImagePassthrough({
      target: target('account-pool', 'codex'),
      endpointConfig: { ...responsesConfig, boundAccountId: 'acct-7' },
      llmConfig: llmConfigFor(null),
      action: 'generate',
      model: 'gpt-image-2',
      sessionKey: 'outbound:images:oak_1',
      clientHeaders: { originator: 'codex_cli_rs', 'user-agent': 'codex_cli_rs/0.163.0' },
    });

    expect(plan).not.toBeNull();
    expect(plan!.url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(plan!.providerId).toBe('codex');
    expect(plan!.headers.Authorization).toBe('Bearer codex-access-token');
    // The always-safe Codex marker rides along; the caller's own UA is kept.
    expect(plan!.headers.originator).toBe('codex_cli_rs');
    expect(plan!.headers['user-agent']).toBe('codex_cli_rs/0.163.0');
    // The binding's pinned account rides the auth hints.
    expect(hints[0]).toMatchObject({ preferredAccountId: 'acct-7' });
  });

  it('uses the edits path for an edit', async () => {
    wireCodexProfile(fakeCodexStrategy([]));
    const plan = await resolveNativeImagePassthrough({
      target: target('account-group', 'codex'),
      endpointConfig: responsesConfig,
      llmConfig: llmConfigFor(null),
      action: 'edit',
      model: 'gpt-image-2',
      sessionKey: 's',
    });
    expect(plan!.url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
  });

  it('relays the official OpenAI provider with its own key', async () => {
    const provider = {
      id: 'openai',
      name: 'OpenAI',
      apiFormat: 'openai',
      api_base_url: 'https://api.openai.com/v1/chat/completions',
      api_key: 'sk-official',
      models: ['gpt-6-astra'],
      enabled: true,
    } as unknown as LLMProvider;

    const plan: NativeImagePassthroughPlan | null = await resolveNativeImagePassthrough({
      target: target('provider', 'openai'),
      endpointConfig: { endpoint: 'responses', useSubscription: false },
      llmConfig: llmConfigFor(provider),
      action: 'generate',
      model: 'gpt-image-2',
      sessionKey: 's',
    });

    expect(plan).not.toBeNull();
    expect(plan!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(plan!.headers.Authorization).toBe('Bearer sk-official');
    expect(plan!.providerId).toBe('openai');
  });

  it('does NOT relay a third-party provider or another subscription', async () => {
    wireCodexProfile(fakeCodexStrategy([]));
    const deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      apiFormat: 'openai',
      api_base_url: 'https://api.deepseek.com/v1/chat/completions',
      api_key: 'sk-x',
      models: ['deepseek-v4-flash'],
      enabled: true,
    } as unknown as LLMProvider;

    await expect(resolveNativeImagePassthrough({
      target: target('provider', 'deepseek'),
      endpointConfig: { endpoint: 'responses', useSubscription: false },
      llmConfig: llmConfigFor(deepseek),
      action: 'generate',
      model: 'gpt-image-2',
      sessionKey: 's',
    })).resolves.toBeNull();

    await expect(resolveNativeImagePassthrough({
      target: target('account-pool', 'claude'),
      endpointConfig: responsesConfig,
      llmConfig: llmConfigFor(null),
      action: 'generate',
      model: 'gpt-image-2',
      sessionKey: 's',
    })).resolves.toBeNull();
  });

  it('does not relay when the codex profile is not wired', async () => {
    setSubscriptionRegistryForOutbound(null);
    await expect(resolveNativeImagePassthrough({
      target: target('account-pool', 'codex'),
      endpointConfig: responsesConfig,
      llmConfig: llmConfigFor(null),
      action: 'generate',
      model: 'gpt-image-2',
      sessionKey: 's',
    })).resolves.toBeNull();
  });
});
