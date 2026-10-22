/**
 * SubscriptionDispatcher baseUrl test (D1, gate 5.5) — the daemon `/v1/responses`
 * dispatch path passes the already-fetched per-account `ocConfig` into the
 * profile's `resolveUpstreamUrl`, so a user `baseUrl` override is honored. With
 * `baseUrl` UNSET the resolver returns the byte-identical constant.
 */

import type http from 'node:http';

import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import { TransformerChainExecutor } from '@omnicross/core/transformer/TransformerChainExecutor';
import { TransformerService } from '@omnicross/core/transformer/TransformerService';
import { AnthropicTransformer } from '@omnicross/core/transformer/transformers/AnthropicTransformer';
import { describe, expect, it, vi } from 'vitest';

import { buildOpenCodeGoUrl } from '../opencodego/endpoints';
import { resolveOpenCodeGoShape } from '../opencodego/model-shape';
import {
  type DispatcherHooks,
  type DispatchRequest,
  SubscriptionDispatcher,
} from '../SubscriptionDispatcher';
import type { SubscriptionDispatchProfile } from '../SubscriptionProviderRegistry';

/** A real-ish opencodego profile whose `resolveUpstreamUrl` records the config
 *  it was called with and resolves via `buildOpenCodeGoUrl` (the production
 *  shape). The MiniMax model → Anthropic-shape verbatim bypass path. */
function makeProfile(seen: { config?: OpenCodeGoTokenConfig }): SubscriptionDispatchProfile {
  return {
    providerId: 'opencodego',
    displayName: 'OpenCodeGo',
    authStrategy: {
      kind: 'static-bearer',
      providerId: 'opencodego',
      applyHeaders: vi.fn(async (headers: Record<string, string>) => {
        headers['Authorization'] = 'Bearer fake';
      }),
      onUnauthorized: vi.fn(async () => false),
      describeStatus: vi.fn(async () => ({ providerId: 'opencodego', ok: true })),
    } as unknown as SubscriptionDispatchProfile['authStrategy'],
    mode: 'transformer',
    resolveUpstreamUrl: (model, config) => {
      seen.config = config;
      return buildOpenCodeGoUrl(
        'go',
        resolveOpenCodeGoShape({ modelId: model }),
        config?.baseUrl,
      );
    },
    providerTransformerNames: ['anthropic'],
    modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
    nextFallback: () => null,
  };
}

function makeHooks(captured: { url?: string; body?: unknown }): DispatcherHooks {
  const transformerService = new TransformerService();
  transformerService.registerTransformer('anthropic', new AnthropicTransformer());
  return {
    endpointTransformer: new AnthropicTransformer(),
    executor: new TransformerChainExecutor(),
    transformerService,
    fetchWithRetry: vi.fn(async (url: string, _headers: Record<string, string>, body: unknown) => {
      captured.url = url;
      captured.body = body;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
    writeProxyResponse: vi.fn(async () => undefined),
  };
}

function makeReq(): DispatchRequest {
  const anthropicBody = { model: 'cli', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  return {
    reqId: 1,
    res: {} as http.ServerResponse,
    rawBody: JSON.stringify(anthropicBody),
    anthropicBody,
    isStream: false,
    sdkModel: 'cli',
    fallbackModel: 'minimax-m2.5',
  };
}

describe('SubscriptionDispatcher baseUrl (D1)', () => {
  it('passes the per-account ocConfig into resolveUpstreamUrl → honors baseUrl', async () => {
    const seen: { config?: OpenCodeGoTokenConfig } = {};
    const captured: { url?: string; body?: unknown } = {};
    const config: OpenCodeGoTokenConfig = {
      authMethod: 'manual',
      status: 'configured',
      baseUrl: 'https://my-host.example.com',
    };
    const dispatcher = new SubscriptionDispatcher(
      makeProfile(seen),
      makeHooks(captured),
      async () => config,
    );
    await dispatcher.dispatch(makeReq());

    // The dispatcher fetched the config and passed it into resolveUpstreamUrl.
    expect(seen.config).toBe(config);
    // The Anthropic-shape (MiniMax) bypass hit the OVERRIDE host.
    expect(captured.url).toBe('https://my-host.example.com/v1/messages');
    expect(captured.body).toMatchObject({
      model: 'minimax-m2.5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('byte-identical constant when baseUrl is unset', async () => {
    const seen: { config?: OpenCodeGoTokenConfig } = {};
    const captured: { url?: string } = {};
    const config: OpenCodeGoTokenConfig = { authMethod: 'manual', status: 'configured' };
    const dispatcher = new SubscriptionDispatcher(
      makeProfile(seen),
      makeHooks(captured),
      async () => config,
    );
    await dispatcher.dispatch(makeReq());

    expect(captured.url).toBe('https://opencode.ai/zen/go/v1/messages');
  });
});
