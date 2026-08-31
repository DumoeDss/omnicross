import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';
import type { ResponsesHostedImageIngress } from '../responsesHostedImageIngress';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function llmConfig(upstreamUrl: string): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => ({
      id: 'native',
      name: 'Native',
      apiFormat: 'openai-response',
      api_base_url: upstreamUrl,
      api_key: 'upstream-key',
      models: ['gpt-native'],
      enabled: true,
    })),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function route(allowed: boolean): RouteContext {
  return {
    sessionId: 'hosted-image-session',
    apiKeyId: 'client-key',
    hostedImageGenerationAllowed: allowed,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'native',
  };
}

function request(proxyPort: number, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Native Responses hosted image ingress composition', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  async function setup(mediator?: ResponsesHostedImageIngress): Promise<{
    proxyPort: number;
    token: string;
    upstreamBodies: Array<Record<string, unknown>>;
  }> {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        upstreamBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_hosted_image',
          object: 'response',
          status: 'completed',
          output: [{
            id: 'fc_shadow',
            type: 'function_call',
            call_id: 'call_shadow',
            name: '__shadow_image',
            arguments: '{"prompt":"model selected prompt"}',
          }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const deps: ProviderProxyDeps = {
      llmConfig: llmConfig(`http://127.0.0.1:${upstreamPort}/v1`),
      ...(mediator ? { responsesHostedImageIngress: mediator } : {}),
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    return { proxyPort, token: proxy.addRoute(route(true)), upstreamBodies };
  }

  it('runs prepare/wrap/dispose and returns the mediated image result', async () => {
    const dispose = vi.fn(async () => undefined);
    const mediator: ResponsesHostedImageIngress = {
      prepare: vi.fn(async (input) => ({
        upstreamBody: { ...input.body, tools: [{ type: 'function', name: '__shadow_image' }] },
        async wrapUpstreamResponse(wrap) {
          const upstreamJson = await wrap.response.json() as Record<string, unknown>;
          await wrap.onTerminalSuccess('resp_hosted_image', {
            hasImageContext: true,
            pendingReceipts: [{ upstreamCallId: 'call_shadow', publicImageCallId: 'ig_1234567890abcdef' }],
          });
          return new Response(JSON.stringify({
            ...upstreamJson,
            output: [{
              id: 'ig_1234567890abcdef',
              type: 'image_generation_call',
              status: 'completed',
              result: 'AQID',
            }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
        dispose,
      })),
    };
    const { proxyPort, token, upstreamBodies } = await setup(mediator);
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw something',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_hosted_image',
      output: [{ type: 'image_generation_call', result: 'AQID' }],
    });
    expect(upstreamBodies[0]?.tools).toEqual([{ type: 'function', name: '__shadow_image' }]);
    expect(mediator.prepare).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps ordinary Responses on the existing path without preparing hosted images', async () => {
    const mediator: ResponsesHostedImageIngress = { prepare: vi.fn() };
    const { proxyPort, token, upstreamBodies } = await setup(mediator);
    const response = await request(proxyPort, token, { model: 'client-model', input: 'hello' });

    expect(response.status).toBe(200);
    expect(mediator.prepare).not.toHaveBeenCalled();
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]?.input).toBe('hello');
  });

  it('fails closed before upstream when the mediator is missing', async () => {
    const { proxyPort, token, upstreamBodies } = await setup();
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw',
      tools: [{ type: 'image_generation' }],
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('unsupported_capability');
    expect(upstreamBodies).toHaveLength(0);
  });

  it('requires the route images permission before mediator or upstream work', async () => {
    const mediator: ResponsesHostedImageIngress = { prepare: vi.fn() };
    const { proxyPort, upstreamBodies } = await setup(mediator);
    const token = proxy!.addRoute(route(false));
    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw',
      tools: [{ type: 'image_generation' }],
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('insufficient_permissions');
    expect(mediator.prepare).not.toHaveBeenCalled();
    expect(upstreamBodies).toHaveLength(0);
  });
});
