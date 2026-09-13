import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthApplyHints } from '../../../pipeline/AuthSource';
import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';

/**
 * The codex Responses contract on the `/v1/responses` ingress for a
 * NON-streaming client: the backend rejects `stream:false` outright, so the
 * plan forces `stream:true` on the wire while the caller keeps its JSON
 * contract — the forced SSE answer is collapsed back into the single terminal
 * `response` object. The mock upstream omits Content-Type (the codex backend
 * does too), exercising the sniff at both the plan and the collapse.
 */
describe('codex /v1/responses non-stream callers (forced stream + SSE collapse)', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  it('forces stream:true + store:false upstream and answers JSON from the collapsed SSE', async () => {
    const upstreamCalls: Array<{ body: Record<string, unknown>; path: string }> = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        upstreamCalls.push({ body: JSON.parse(raw) as Record<string, unknown>, path: request.url ?? '' });
        // NO Content-Type on purpose — the codex backend omits it on SSE.
        response.writeHead(200);
        response.end(
          'data: {"type":"response.created","response":{"id":"resp_ns_1","model":"gpt-5.6-luna"}}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"pong"}\n\n' +
            'data: {"type":"response.completed","response":{"id":"resp_ns_1","object":"response","status":"completed","model":"gpt-5.6-luna","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n' +
            'data: [DONE]\n\n',
        );
      });
    });
    upstream = server;
    const port = await listen(server);
    const upstreamUrl = `http://127.0.0.1:${port}/backend-api/codex/responses`;

    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(target: Record<string, string>, _hints?: AuthApplyHints) {
        target.Authorization = 'Bearer codex-account-a';
        _hints?.reportSelection?.('account-a', true);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const route: RouteContext = {
      sessionId: 'codex-ns-route',
      apiKeyId: 'client-a',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-5.6-luna',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: authStrategy as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => upstreamUrl,
      },
    };
    const deps: ProviderProxyDeps = {
      llmConfig: {
        getProvider: vi.fn(async () => undefined),
        resolveTransformerChain: vi.fn(),
        getMainTransformer: vi.fn(),
        getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
      } as unknown as ProviderConfigSource,
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(route);

    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'session-id': 'codex-ns-session',
      },
      // stream deliberately ABSENT — a non-streaming Responses client.
      body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'ping' }),
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);
    expect(upstreamCalls[0]?.path).toBe('/backend-api/codex/responses');
    // The wire contract the codex backend enforces.
    expect(upstreamCalls[0]?.body).toMatchObject({ store: false, stream: true });
    // The caller's JSON contract survived: the terminal `response` object back.
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as {
      id?: string;
      object?: string;
      status?: string;
      usage?: { input_tokens?: number };
    };
    expect(json.id).toBe('resp_ns_1');
    expect(json.object).toBe('response');
    expect(json.status).toBe('completed');
    expect(json.usage?.input_tokens).toBe(4);
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
