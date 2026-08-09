/**
 * End-to-end session-affinity coverage for the subscription Responses ingress.
 *
 * The executor is reduced to its ingress-facing seams, but the request still
 * travels through a real loopback ProviderProxy route and a real upstream HTTP
 * server. This proves the same derived key reaches both account selection
 * (`applyHeaders`) and the 401 refresh path (`onUnauthorized`).
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { BoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import type { ProviderCallContext } from '../../pipeline/executeProviderCall';

const executeProviderCallMock = vi.fn(async (ctx: ProviderCallContext) => {
  const headers = ctx.buildHeaders({} as never);
  const response = await ctx.fetchFn(ctx.resolveUrl({} as never), headers, ctx.request);
  return { response };
});

vi.mock('../../pipeline/executeProviderCall', () => ({
  executeProviderCall: (ctx: ProviderCallContext) => executeProviderCallMock(ctx),
}));

import type { ProviderConfigSource } from '../../ports';
import { ensureCodexPromptCacheKey } from '../ingress/openaiResponsesIngress';
import { deriveGatewaySessionKey } from '../matchText';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../types';

function makeLlmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

function startUnauthorizedUpstream(): Promise<{
  server: Server;
  url: string;
  receivedHeaders: IncomingHttpHeaders[];
}> {
  const receivedHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    receivedHeaders.push(req.headers);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'expired' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/responses`, receivedHeaders });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

describe('Codex prompt-cache-key injection', () => {
  it('preserves a client key and records it as client-owned', () => {
    const body = { prompt_cache_key: 'client-cache-key', session_id: 'session-a' };
    const result = ensureCodexPromptCacheKey(
      body,
      'codex',
      deriveGatewaySessionKey(body),
    );
    expect(body.prompt_cache_key).toBe('client-cache-key');
    expect(result).toEqual({ cacheKeySource: 'client', cacheKeyInjected: false });
  });

  it('injects an opaque stable key from explicit metadata or a content fingerprint', () => {
    const sessionBody: Record<string, unknown> = { input: 'later text' };
    const sessionDerived = deriveGatewaySessionKey(sessionBody, {
      'session-id': 'private-session-id',
    });
    const sessionResult = ensureCodexPromptCacheKey(sessionBody, 'codex', sessionDerived);
    expect(sessionResult).toEqual({ cacheKeySource: 'session-header', cacheKeyInjected: true });
    expect(sessionBody.prompt_cache_key).toBe(
      `omnicross:session-header:${sessionDerived.key}`,
    );
    expect(String(sessionBody.prompt_cache_key)).not.toContain('private-session-id');

    const contentBody: Record<string, unknown> = {
      input: [{ role: 'user', content: 'stable first request' }],
    };
    const contentDerived = deriveGatewaySessionKey(contentBody);
    const contentResult = ensureCodexPromptCacheKey(contentBody, 'codex', contentDerived);
    expect(contentResult).toEqual({
      cacheKeySource: 'content-fingerprint',
      cacheKeyInjected: true,
    });
    expect(contentBody.prompt_cache_key).toBe(
      `omnicross:content-fingerprint:${contentDerived.key}`,
    );
  });

  it('never injects a route/API-key fallback or a key for another provider', () => {
    const fallbackBody: Record<string, unknown> = {};
    const fallbackDerived = deriveGatewaySessionKey(fallbackBody, {}, {
      fallbackKey: 'sensitive-api-key',
    });
    expect(ensureCodexPromptCacheKey(fallbackBody, 'codex', fallbackDerived)).toEqual({
      cacheKeySource: 'none',
      cacheKeyInjected: false,
    });
    expect(fallbackBody.prompt_cache_key).toBeUndefined();

    const otherBody: Record<string, unknown> = { session_id: 'session-b' };
    expect(
      ensureCodexPromptCacheKey(otherBody, 'gemini', deriveGatewaySessionKey(otherBody)),
    ).toEqual({ cacheKeySource: 'none', cacheKeyInjected: false });
    expect(otherBody.prompt_cache_key).toBeUndefined();
  });
});

describe('ProviderProxy subscription Responses session affinity', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await closeServer(upstream);
    proxy = undefined;
    upstream = undefined;
    executeProviderCallMock.mockClear();
  });

  it('sends the same derived key to applyHeaders and 401 refresh, while distinct conversations differ', async () => {
    const appliedKeys: Array<string | undefined> = [];
    const unauthorizedKeys: Array<string | undefined> = [];
    const { server, url, receivedHeaders } = await startUnauthorizedUpstream();
    upstream = server;

    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(headers: Record<string, string>, hints?: { sessionKey?: string }) {
        appliedKeys.push(hints?.sessionKey);
        headers.Authorization = 'Bearer test-token';
      },
      async onUnauthorized(sessionKey?: string) {
        unauthorizedKeys.push(sessionKey);
        return false;
      },
      async describeStatus() {
        return { providerId: 'codex', configured: true };
      },
    };

    const route: RouteContext = {
      sessionId: 'resident-route-session',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-5-codex',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        resolveUpstreamUrl: () => url,
      },
    };

    const deps: ProviderProxyDeps = { llmConfig: makeLlmConfig() };
    proxy = new ProviderProxy(deps);
    const port = await proxy.start();
    const token = proxy.addRoute(route);
    const proxyUrl = `http://127.0.0.1:${port}/openai/responses`;

    const sessionBody = {
      model: 'gpt-5-codex',
      prompt_cache_key: 'must-not-win-over-session-id',
      input: [{ role: 'user', content: 'first conversation' }],
    };
    const cacheBody = {
      model: 'gpt-5-codex',
      prompt_cache_key: 'second-conversation-cache-key',
      input: [{ role: 'user', content: 'second conversation' }],
    };

    const first = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'session-id': 'codex-session-one',
      },
      body: JSON.stringify(sessionBody),
    });
    const second = await fetch(proxyUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cacheBody),
    });

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(appliedKeys).toHaveLength(2);
    expect(unauthorizedKeys).toHaveLength(2);

    const expectedSessionKey = deriveGatewaySessionKey(sessionBody, {
      'session-id': 'codex-session-one',
    }).key;
    const expectedCacheKey = deriveGatewaySessionKey(cacheBody).key;
    expect(appliedKeys).toEqual([expectedSessionKey, expectedCacheKey]);
    expect(unauthorizedKeys).toEqual([expectedSessionKey, expectedCacheKey]);
    expect(expectedSessionKey).not.toBe(expectedCacheKey);
    expect(appliedKeys).not.toContain('codex-session-one');
    expect(unauthorizedKeys).not.toContain('second-conversation-cache-key');
    const forwardedBodies = executeProviderCallMock.mock.calls.map(
      ([context]) => context.request as Record<string, unknown>,
    );
    expect(forwardedBodies.map((body) => body.prompt_cache_key)).toEqual([
      'must-not-win-over-session-id',
      'second-conversation-cache-key',
    ]);
    // Session metadata is ingress-only. The upstream receives the auth strategy
    // headers, never Codex's raw session header.
    expect(receivedHeaders).toHaveLength(2);
    expect(receivedHeaders.every((headers) => headers['session-id'] === undefined)).toBe(true);
    expect(receivedHeaders.every((headers) => headers['x-session-id'] === undefined)).toBe(true);
  });

  it('surfaces an all-accounts allowance pause as 429 without calling upstream', async () => {
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders() {
        throw new AccountAllowanceExhaustedError('codex', '2030-01-01T01:00:00.000Z');
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'allowance-paused',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-5-codex',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        resolveUpstreamUrl: () => 'http://127.0.0.1:1/responses',
      },
    };

    proxy = new ProviderProxy({ llmConfig: makeLlmConfig() });
    const port = await proxy.start();
    const token = proxy.addRoute(route);
    const response = await fetch(`http://127.0.0.1:${port}/openai/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: 'hello' }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('paused by the allowance policy') },
    });
    expect(executeProviderCallMock).not.toHaveBeenCalled();
  });

  it('maps a strict bound-account failure to a secret-free structured 503', async () => {
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders() {
        throw new BoundAccountSelectionError('codex', 'not-found');
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'bound-account-failure',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-5-codex',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      preferredAccountId: 'acct-secret-name',
      boundAccountFallbackPolicy: 'strict',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        resolveUpstreamUrl: () => 'http://127.0.0.1:1/responses',
      },
    };

    proxy = new ProviderProxy({ llmConfig: makeLlmConfig() });
    const port = await proxy.start();
    const token = proxy.addRoute(route);
    const response = await fetch(`http://127.0.0.1:${port}/openai/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: 'hello' }),
    });

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: {
        type: 'provider_proxy_error',
        code: 'bound_account_unavailable',
        reason: 'not-found',
        message: 'Bound subscription account was not found',
      },
    });
    expect(body).not.toContain('acct-secret-name');
    expect(executeProviderCallMock).not.toHaveBeenCalled();
  });
});
