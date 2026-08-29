import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiKeyPoolService } from '../../../completion/ApiKeyPoolService';
import { BoundAccountSelectionError } from '../../../pipeline/BoundAccountSelectionError';
import type { AuthApplyHints } from '../../../pipeline/AuthSource';
import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';

const FULL_WINDOW = [
  { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
  { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-window' },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
  { type: 'custom_tool_call_output', call_id: 'custom_1', output: 'result' },
] as const;

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

function headers(token: string, sessionId = 'affinity-session'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'session-id': sessionId,
  };
}

function subscriptionRoute(authStrategy: unknown, upstreamUrl: string, apiKeyId = 'client-a'): RouteContext {
  return {
    sessionId: 'subscription-route',
    apiKeyId,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'subscription',
    subscriptionProfile: {
      authStrategy: authStrategy as never,
      providerTransformerNames: ['metrics-side-tap', 'openai-response'],
      resolveUpstreamUrl: () => upstreamUrl,
    },
  };
}

function byoRoute(apiKeyId = 'client-a'): RouteContext {
  return {
    sessionId: 'byo-route',
    apiKeyId,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'openai-native',
  };
}

describe('native Responses affinity and stateless failover', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  it('binds subscription JSON/SSE response IDs to the selected account and isolates every scope', async () => {
    const upstreamCalls: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    let jsonId = 1;
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        upstreamCalls.push({ authorization: request.headers.authorization, body });
        if (body.stream === true) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end('data: {"type":"response.completed","response":{"id":"resp-account-a","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: `resp-continuation-${jsonId++}`,
          object: 'response',
          status: 'completed',
          output: [],
        }));
      });
    });
    upstream = server;
    const port = await listen(server);
    const upstreamUrl = `http://127.0.0.1:${port}/v1/responses`;
    let activeAccount = 'account-a';
    const unavailable = new Set<string>();
    const selections: Array<{
      preferred?: string;
      fallback?: string;
      selected: string;
    }> = [];
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(target: Record<string, string>, hints?: AuthApplyHints) {
        const preferred = hints?.preferredAccountId;
        if (preferred && unavailable.has(preferred)) {
          throw new BoundAccountSelectionError('codex', 'unavailable');
        }
        const selected = preferred ?? activeAccount;
        selections.push({
          preferred,
          fallback: hints?.boundAccountFallbackPolicy,
          selected,
        });
        target.Authorization = `Bearer ${selected}`;
        hints?.reportSelection?.(selected, selected === activeAccount);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const deps: ProviderProxyDeps = { llmConfig: makeLlmConfig(upstreamUrl) };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const routeA = proxy.addRoute(subscriptionRoute(authStrategy, upstreamUrl));

    const created = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(routeA),
      body: JSON.stringify({ model: 'client', stream: true, input: 'hello' }),
    });
    expect(created.status).toBe(200);
    expect(await created.text()).toContain('resp-account-a');

    activeAccount = 'account-b';
    const continued = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(routeA),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-account-a', input: 'next' }),
    });
    expect(continued.status).toBe(200);
    await expect(continued.json()).resolves.toMatchObject({ id: 'resp-continuation-1' });
    expect(selections.at(-1)).toEqual({ preferred: 'account-a', fallback: 'strict', selected: 'account-a' });

    const inherited = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: headers(routeA),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-continuation-1', input: 'again' }),
    });
    expect(inherited.status).toBe(200);
    expect(upstreamCalls.at(-1)?.authorization).toBe('Bearer account-a');

    const callsBeforeIsolation = upstreamCalls.length;
    const routeOtherKey = proxy.addRoute(subscriptionRoute(authStrategy, upstreamUrl, 'client-b'));
    const crossKey = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(routeOtherKey),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-account-a', input: 'forbidden' }),
    });
    expect(crossKey.status).toBe(404);
    expect(await crossKey.text()).not.toContain('account-a');

    const crossSession = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(routeA, 'different-session'),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-account-a', input: 'forbidden' }),
    });
    expect(crossSession.status).toBe(404);

    const routeOtherProvider = proxy.addRoute(byoRoute('client-a'));
    const crossProvider = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(routeOtherProvider),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-account-a', input: 'forbidden' }),
    });
    expect(crossProvider.status).toBe(404);
    expect(upstreamCalls).toHaveLength(callsBeforeIsolation);

    unavailable.add('account-a');
    const unavailableContinuation = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(routeA),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-account-a', input: 'retry' }),
    });
    expect(unavailableContinuation.status).toBe(404);
    const unavailableBody = await unavailableContinuation.text();
    expect(unavailableBody).toContain('previous_response_not_found');
    expect(unavailableBody).not.toContain('account-a');
    expect(upstreamCalls).toHaveLength(callsBeforeIsolation);
  });

  it('binds a BYO continuation to its original pool key and never rotates it on 429', async () => {
    const authorizations: Array<string | undefined> = [];
    let upstreamStatus = 200;
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        authorizations.push(request.headers.authorization);
        response.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
        response.end(upstreamStatus === 200
          ? JSON.stringify({ id: 'resp-key-a', object: 'response', status: 'completed', output: [] })
          : JSON.stringify({ error: { code: 'rate_limit_exceeded' } }));
      });
    });
    upstream = server;
    const port = await listen(server);
    let currentKeyId: string | null = null;
    const unavailable = new Set<string>();
    const reportError = vi.fn(async () => {
      currentKeyId = 'key-b';
      return 'pool-secret-b';
    });
    const pool = {
      async getKeyForSession() {
        currentKeyId ??= 'key-a';
        return currentKeyId === 'key-a' ? 'pool-secret-a' : 'pool-secret-b';
      },
      getKeyIdForSession() { return currentKeyId; },
      async getKeyById(_providerId: string, keyId: string) {
        if (unavailable.has(keyId)) return '';
        currentKeyId = keyId;
        return keyId === 'key-a' ? 'pool-secret-a' : 'pool-secret-b';
      },
      reportError,
      reportSuccess: vi.fn(),
    } as unknown as ApiKeyPoolService;
    const deps: ProviderProxyDeps = {
      llmConfig: makeLlmConfig(`http://127.0.0.1:${port}/v1`),
      apiKeyPool: pool,
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(byoRoute());

    const created = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ model: 'client', input: 'first' }),
    });
    expect(created.status).toBe(200);
    expect(authorizations).toEqual(['Bearer pool-secret-a']);

    upstreamStatus = 429;
    const continued = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-key-a', input: 'next' }),
    });
    expect(continued.status).toBe(429);
    expect(authorizations).toEqual(['Bearer pool-secret-a', 'Bearer pool-secret-a']);
    expect(reportError).not.toHaveBeenCalled();
    expect(currentKeyId).toBe('key-a');

    unavailable.add('key-a');
    const callsBeforeUnavailable = authorizations.length;
    const missing = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ model: 'client', previous_response_id: 'resp-key-a', input: 'retry' }),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect(missingBody).toContain('previous_response_not_found');
    expect(missingBody).not.toContain('key-a');
    expect(authorizations).toHaveLength(callsBeforeUnavailable);
  });

  it('keeps an absent state reference eligible for BYO key failover with the full window intact', async () => {
    const attempts: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        attempts.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
        const status = attempts.length === 1 ? 429 : 200;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(status === 200
          ? JSON.stringify({ id: 'resp-key-b', object: 'response', status: 'completed', output: [] })
          : JSON.stringify({ error: { code: 'rate_limit_exceeded' } }));
      });
    });
    upstream = server;
    const port = await listen(server);
    let keyId = 'key-a';
    const pool = {
      async getKeyForSession() { return keyId === 'key-a' ? 'pool-secret-a' : 'pool-secret-b'; },
      getKeyIdForSession() { return keyId; },
      async getKeyById(_providerId: string, requested: string) {
        keyId = requested;
        return requested === 'key-a' ? 'pool-secret-a' : 'pool-secret-b';
      },
      async reportError() {
        keyId = 'key-b';
        return 'pool-secret-b';
      },
      reportSuccess: vi.fn(),
    } as unknown as ApiKeyPoolService;
    proxy = new ProviderProxy({
      llmConfig: makeLlmConfig(`http://127.0.0.1:${port}/v1`),
      apiKeyPool: pool,
    });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(byoRoute());
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ model: 'client', store: false, input: FULL_WINDOW }),
    });
    expect(response.status).toBe(200);
    expect(attempts.map((attempt) => attempt.authorization)).toEqual([
      'Bearer pool-secret-a',
      'Bearer pool-secret-b',
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body.input).toEqual(FULL_WINDOW);
    expect(attempts[1].body.input).toEqual(FULL_WINDOW);
    expect(attempts.every((attempt) => !Object.hasOwn(attempt.body, 'previous_response_id'))).toBe(true);
  });

  it('treats a null state reference as stateless during subscription account failover', async () => {
    const attempts: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        attempts.push({ authorization: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
        const status = attempts.length === 1 ? 429 : 200;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(status === 200
          ? JSON.stringify({ id: 'resp-account-b', object: 'response', status: 'completed', output: [] })
          : JSON.stringify({ error: { code: 'usage_limit_reached' } }));
      });
    });
    upstream = server;
    const port = await listen(server);
    const selectedAccounts = ['account-stateless-a', 'account-stateless-b'];
    let selection = 0;
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(target: Record<string, string>, hints?: AuthApplyHints) {
        const accountId = selectedAccounts[Math.min(selection++, selectedAccounts.length - 1)];
        target.Authorization = `Bearer ${accountId}`;
        hints?.reportSelection?.(accountId, selection === 1);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const upstreamUrl = `http://127.0.0.1:${port}/v1/responses`;
    proxy = new ProviderProxy({ llmConfig: makeLlmConfig(upstreamUrl) });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(subscriptionRoute(authStrategy, upstreamUrl));
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({
        model: 'client',
        store: false,
        previous_response_id: null,
        input: FULL_WINDOW,
      }),
    });
    expect(response.status).toBe(200);
    expect(attempts.map((attempt) => attempt.authorization)).toEqual([
      'Bearer account-stateless-a',
      'Bearer account-stateless-b',
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body.input).toEqual(FULL_WINDOW);
    expect(attempts[1].body.input).toEqual(FULL_WINDOW);
    expect(attempts.every((attempt) => attempt.body.previous_response_id === null)).toBe(true);
  });
});
