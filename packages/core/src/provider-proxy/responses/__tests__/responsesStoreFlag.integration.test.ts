import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthApplyHints } from '../../../pipeline/AuthSource';
import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';

/**
 * The ChatGPT Codex backend (2026-09) 400s any /codex/responses call whose
 * body lacks `store: false`. The relay forces it on the codex SUBSCRIPTION
 * path only — a BYO OpenAI-compatible endpoint must keep the caller's body
 * verbatim (its backend may legitimately allow stateful store).
 */

function makeLlmConfig(providerUrl?: string): ProviderConfigSource {
  return {
    getProvider: vi.fn(async (providerId: string) => providerId === 'openai-native'
      ? {
          id: providerId,
          name: 'OpenAI native',
          apiFormat: 'openai-response',
          api_base_url: providerUrl ?? 'http://127.0.0.1:1/v1',
          api_key: 'provider-fallback-key',
          models: ['gpt-native'],
          enabled: true,
        }
      : undefined),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function headers(token: string, sessionId = 'store-flag-session'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'session-id': sessionId,
  };
}

function codexSubscriptionRoute(upstreamUrl: string): RouteContext {
  const authStrategy = {
    providerId: 'codex',
    kind: 'oauth-bearer',
    async applyHeaders(target: Record<string, string>, hints?: AuthApplyHints) {
      target.Authorization = 'Bearer account-a';
      hints?.reportSelection?.('account-a', true);
    },
    async onUnauthorized() { return false; },
    async describeStatus() { return { providerId: 'codex', configured: true }; },
  };
  return {
    sessionId: 'codex-subscription-route',
    apiKeyId: 'client-a',
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'subscription',
    subscriptionProfile: {
      authStrategy: authStrategy as never,
      providerTransformerNames: ['openai-response'],
      resolveUpstreamUrl: () => upstreamUrl,
    },
  };
}

function byoRoute(): RouteContext {
  return {
    sessionId: 'byo-route',
    apiKeyId: 'client-a',
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'openai-native',
  };
}

describe('codex subscription relays force store:false; BYO stays verbatim', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  it('injects store:false when the caller omitted it and overrides store:true', async () => {
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        upstreamCalls.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"type":"response.completed","response":{"id":"resp-store-1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      });
    });
    upstream = server;
    const port = await listen(server);
    const upstreamUrl = `http://127.0.0.1:${port}/v1/responses`;
    const deps: ProviderProxyDeps = { llmConfig: makeLlmConfig(upstreamUrl) };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const route = proxy.addRoute(codexSubscriptionRoute(upstreamUrl));

    const omitted = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(route),
      body: JSON.stringify({ model: 'client', stream: true, input: 'hello' }),
    });
    expect(omitted.status).toBe(200);
    expect(upstreamCalls.at(-1)).toMatchObject({ store: false });

    const hostile = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(route),
      body: JSON.stringify({ model: 'client', stream: true, store: true, input: 'hello' }),
    });
    expect(hostile.status).toBe(200);
    expect(upstreamCalls.at(-1)).toMatchObject({ store: false });
  });

  it('does not add store to a BYO OpenAI-compatible relay', async () => {
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        upstreamCalls.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: {"type":"response.completed","response":{"id":"resp-byo-1","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      });
    });
    upstream = server;
    const port = await listen(server);
    const upstreamUrl = `http://127.0.0.1:${port}/v1/responses`;
    const deps: ProviderProxyDeps = { llmConfig: makeLlmConfig(upstreamUrl) };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const route = proxy.addRoute(byoRoute());

    const byo = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(route),
      body: JSON.stringify({ model: 'gpt-native', stream: true, input: 'hello' }),
    });
    expect(byo.status).toBe(200);
    expect(upstreamCalls.at(-1)).not.toHaveProperty('store');
  });
});
