/**
 * routeResolver KIND-routing tests (omnicross-mkm-serving, design D1). The
 * kind-mapped endpoints (`messages`/`responses`) resolve `modelMap[kind]` with a
 * serving-owned fallback (messages: `sonnet → opus → haiku → fable`; responses:
 * `codex`), stamp `route.requestedModel` with the client's ORIGINAL id, and 503
 * (naming the kind) when nothing resolves. The role-based endpoints
 * (`chat`/`gemini`) still pick default/background — vision was removed.
 */
import { describe, expect, it } from 'vitest';

import type { ProviderConfigSource } from '../../ports/provider-config-source';
import { resolveRoute } from '../routeResolver';
import type { EndpointRoutingConfig } from '../types';

// A BYO config source that returns a provider row for every id (so the BYO route
// is built and we can read the resolved providerId + model off the route).
const llmConfig = {
  getProvider: async (id: string) => ({
    id,
    name: id,
    api_key: 'sk-x',
    api_base_url: 'https://upstream.example',
    models: ['m'],
    enabled: true,
  }),
} as unknown as ProviderConfigSource;

function messages(map: Record<string, string>): EndpointRoutingConfig {
  return { endpoint: 'messages', modelMap: map, useSubscription: false };
}
function responses(map: Record<string, string>): EndpointRoutingConfig {
  return { endpoint: 'responses', modelMap: map, useSubscription: false };
}

const MSG_MAP = { fable: 'pf,mf', opus: 'po,mo', sonnet: 'ps,ms', haiku: 'ph,mh' };
const RSP_MAP = { codex: 'pc,mc', mini: 'pm,mm' };

describe('resolveRoute — messages KIND routing', () => {
  it('versioned opus id → modelMap.opus, requestedModel stamped', async () => {
    const result = await resolveRoute({
      config: messages(MSG_MAP),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'claude-opus-4-8-2026xxxx',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('po');
    expect(result.route.model).toBe('mo');
    expect(result.route.requestedModel).toBe('claude-opus-4-8-2026xxxx');
  });

  it('unknown (no-kind) id → sonnet fallback', async () => {
    const result = await resolveRoute({
      config: messages(MSG_MAP),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'deepseek-v3',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('ps');
    expect(result.route.model).toBe('ms');
    expect(result.route.requestedModel).toBe('deepseek-v3');
  });

  it('no-kind id with sonnet blank → next fallback (opus)', async () => {
    const result = await resolveRoute({
      config: messages({ ...MSG_MAP, sonnet: '' }),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'deepseek-v3',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('po');
  });

  it('detected kind blank but another kind configured → falls back (not 503)', async () => {
    // opus is blank; detected kind = opus → fallback sonnet.
    const result = await resolveRoute({
      config: messages({ ...MSG_MAP, opus: '' }),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'claude-opus-4-8',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('ps'); // sonnet fallback
  });

  it('all kinds blank → 503 naming the detected kind', async () => {
    const result = await resolveRoute({
      config: messages({ fable: '', opus: '', sonnet: '', haiku: '' }),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'claude-opus-4-8',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(503);
    expect(result.error.message).toContain("kind 'opus'");
  });

  it('all kinds blank + no-kind id → 503 naming unmapped', async () => {
    const result = await resolveRoute({
      config: messages({ fable: '', opus: '', sonnet: '', haiku: '' }),
      ingressFormat: 'anthropic-messages',
      llmConfig,
      requestedModel: 'deepseek-v3',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("kind 'unmapped'");
  });
});

describe('resolveRoute — responses KIND routing', () => {
  it('gpt/codex id → modelMap.codex', async () => {
    const result = await resolveRoute({
      config: responses(RSP_MAP),
      ingressFormat: 'openai-responses',
      llmConfig,
      requestedModel: 'gpt-5-codex',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('pc');
    expect(result.route.model).toBe('mc');
    expect(result.route.requestedModel).toBe('gpt-5-codex');
  });

  it('*-mini id → modelMap.mini', async () => {
    const result = await resolveRoute({
      config: responses(RSP_MAP),
      ingressFormat: 'openai-responses',
      llmConfig,
      requestedModel: 'gpt-4o-mini',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('pm');
    expect(result.route.model).toBe('mm');
  });

  it('*-mini id with mini blank → codex fallback', async () => {
    const result = await resolveRoute({
      config: responses({ codex: 'pc,mc', mini: '' }),
      ingressFormat: 'openai-responses',
      llmConfig,
      requestedModel: 'gpt-4o-mini',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('pc'); // codex fallback
  });

  it('codex blank → 503 naming the kind', async () => {
    const result = await resolveRoute({
      config: responses({ codex: '', mini: '' }),
      ingressFormat: 'openai-responses',
      llmConfig,
      requestedModel: 'gpt-5-codex',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(503);
    expect(result.error.message).toContain("kind 'codex'");
  });
});

describe('resolveRoute — role-based endpoints (chat/gemini, vision removed)', () => {
  const chat: EndpointRoutingConfig = {
    endpoint: 'chat',
    defaultModel: 'pd,md',
    backgroundModel: 'pb,mb',
    useSubscription: false,
  };

  it('background role → backgroundModel', async () => {
    const result = await resolveRoute({
      config: chat,
      role: 'background',
      ingressFormat: 'openai-chat',
      llmConfig,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.providerId).toBe('pb');
    expect(result.route.model).toBe('mb');
  });

  it('default role (and omitted role) → defaultModel', async () => {
    const withRole = await resolveRoute({
      config: chat,
      role: 'default',
      ingressFormat: 'openai-chat',
      llmConfig,
    });
    const omitted = await resolveRoute({ config: chat, ingressFormat: 'openai-chat', llmConfig });
    expect(withRole.ok && withRole.route.providerId).toBe('pd');
    expect(omitted.ok && omitted.route.providerId).toBe('pd');
  });

  it('role-based route does NOT stamp requestedModel (passthrough gate is kind-only)', async () => {
    const result = await resolveRoute({
      config: chat,
      role: 'default',
      ingressFormat: 'openai-chat',
      llmConfig,
      // Even if a caller passes requestedModel, chat must not stamp it.
      requestedModel: 'gpt-4o',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.requestedModel).toBeUndefined();
  });

  it('missing default model → 503 (no vision branch)', async () => {
    const result = await resolveRoute({
      config: { endpoint: 'chat', defaultModel: '', backgroundModel: '', useSubscription: false },
      role: 'default',
      ingressFormat: 'openai-chat',
      llmConfig,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no default model configured');
  });
});
