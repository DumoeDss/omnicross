/**
 * Hosted `image_generation` with the local image runtime DISABLED.
 *
 * The feature switch being off must not fail a request whose upstream executes
 * the tool natively (codex subscription / official OpenAI): the body has to
 * reach that upstream untouched. A route that would need the local runtime
 * (reduced / third-party) keeps the structured "unavailable" answer.
 */
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
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * Subscription ids resolve through the subscription path (no BYO row), while a
 * third-party BYO row exists so the reduced route can resolve.
 */
function llmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(async (id: string) =>
      id === 'deepseek'
        ? {
            id: 'deepseek',
            name: 'DeepSeek',
            apiFormat: 'openai',
            api_base_url: 'https://api.deepseek.com/v1/chat/completions',
            api_key: 'sk-third-party',
            models: ['deepseek-v4-flash'],
            enabled: true,
          }
        : null),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => null),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

const CODEX_TRANSFORMERS = ['openai-response'];

function codexSubscriptionRoute(upstreamUrl: string): RouteContext {
  return {
    sessionId: 'hosted-image-passthrough',
    apiKeyId: 'client-key',
    hostedImageGenerationAllowed: true,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-5.6-luna',
    ingressFormat: 'openai-responses',
    authMode: 'subscription',
    providerId: 'codex',
    subscriptionProfile: {
      providerId: 'codex',
      displayName: 'Codex (ChatGPT OAuth)',
      mode: 'transformer',
      authStrategy: {
        kind: 'oauth-bearer',
        providerId: 'codex',
        async applyHeaders(headers: Record<string, string>) {
          headers['Authorization'] = 'Bearer subscription-token';
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'codex', ok: true };
        },
      },
      resolveUpstreamUrl: () => upstreamUrl,
      providerTransformerNames: CODEX_TRANSFORMERS,
      modelTransformerNames: [],
    } as never,
  };
}

function byoThirdPartyRoute(): RouteContext {
  return {
    sessionId: 'hosted-image-third-party',
    apiKeyId: 'client-key',
    hostedImageGenerationAllowed: true,
    targetProviderFormat: 'openai-responses',
    model: 'deepseek-v4-flash',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'deepseek',
  };
}

describe('Hosted image passthrough when the image runtime is off', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  async function setup(mediator: ResponsesHostedImageIngress, route: (port: number) => RouteContext = codexSubscriptionRoute): Promise<{
    proxyPort: number;
    token: string;
    upstreamBodies: Array<Record<string, unknown>>;
    upstreamHeaders: Array<Record<string, string | string[] | undefined>>;
  }> {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        upstreamBodies.push(JSON.parse(raw) as Record<string, unknown>);
        upstreamHeaders.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'resp_upstream',
          object: 'response',
          status: 'completed',
          output: [{ id: 'ig_upstream', type: 'image_generation_call', status: 'completed', result: 'AAAA' }],
          usage: { input_tokens: 2, output_tokens: 3 },
        }));
      });
    });
    const upstreamPort = await listen(upstream);
    const deps: ProviderProxyDeps = {
      llmConfig: llmConfig(),
      responsesHostedImageIngress: mediator,
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    return {
      proxyPort,
      token: proxy.addRoute(route(upstreamPort)),
      upstreamBodies,
      upstreamHeaders,
    };
  }

  function request(proxyPort: number, token: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('leaves a codex-subscription request untouched when the runtime is disabled', async () => {
    const mediator: ResponsesHostedImageIngress = {
      isAvailable: () => false,
      prepare: vi.fn(),
    };
    const { proxyPort, token, upstreamBodies, upstreamHeaders } = await setup(
      mediator,
      (port) => codexSubscriptionRoute(`http://127.0.0.1:${port}/v1/responses`),
    );

    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw a red cube',
      tools: [{ type: 'image_generation', model: 'gpt-image-2' }],
      tool_choice: { type: 'image_generation' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'resp_upstream',
      output: [{ type: 'image_generation_call', result: 'AAAA' }],
    });
    // The tool declaration reached the upstream VERBATIM — no mediation.
    expect(mediator.prepare).not.toHaveBeenCalled();
    expect(upstreamBodies[0]?.tools).toEqual([{ type: 'image_generation', model: 'gpt-image-2' }]);
    expect(upstreamHeaders[0]?.authorization).toBe('Bearer subscription-token');
  });

  it('still fails a third-party route closed while the runtime is disabled', async () => {
    const mediator: ResponsesHostedImageIngress = {
      isAvailable: () => false,
      prepare: vi.fn(async () => null),
    };
    const { proxyPort, token, upstreamBodies } = await setup(mediator, () => byoThirdPartyRoute());

    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw',
      tools: [{ type: 'image_generation' }],
    });

    const body = await response.text();
    expect(response.status, body).toBe(422);
    expect(body).toContain('unsupported_capability');
    expect(upstreamBodies).toHaveLength(0);
  });

  it('keeps mediating when the runtime IS available', async () => {
    const mediator: ResponsesHostedImageIngress = {
      isAvailable: () => true,
      prepare: vi.fn(async (input) => ({
        upstreamBody: { ...input.body, tools: [] },
        async wrapUpstreamResponse(wrap) {
          const upstreamJson = (await wrap.response.json()) as Record<string, unknown>;
          return new Response(JSON.stringify(upstreamJson), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
        dispose: vi.fn(async () => undefined),
      })),
    };
    const { proxyPort, token } = await setup(
      mediator,
      (port) => codexSubscriptionRoute(`http://127.0.0.1:${port}/v1/responses`),
    );

    const response = await request(proxyPort, token, {
      model: 'client-model',
      input: 'draw',
      tools: [{ type: 'image_generation' }],
    });

    expect(response.status).toBe(200);
    expect(mediator.prepare).toHaveBeenCalledOnce();
  });
});
