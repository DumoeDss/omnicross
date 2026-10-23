import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ProjectResolverModule from '../../auth/GeminiCodeAssistProjectResolver';
const { resolveProject, endpoint } = vi.hoisted(() => ({
  resolveProject: vi.fn(async (bearer: string) => `project-${bearer}`),
  endpoint: { url: '' },
}));
vi.mock('../../auth/GeminiCodeAssistProjectResolver', async (importOriginal) => ({
  ...await importOriginal<typeof ProjectResolverModule>(),
  getAntigravityProjectResolver: () => ({ resolveProject }),
}));

import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import type { AuthApplyHints } from '../../pipeline/SubscriptionAuthStrategy';
import type { ProviderConfigSource } from '../../ports';
import { TransformerService } from '../../transformer/TransformerService';
import { AntigravityTransformer, buildAntigravityUrl } from '../../transformer/transformers/AntigravityTransformer';
import { ProviderProxy } from '../ProviderProxy';
import type { RouteContext, SubscriptionDispatchProfile } from '../types';

const ingresses = [
  { format: 'anthropic-messages', path: '/v1/messages', body: {
    model: 'client-alias', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }],
  } },
  { format: 'openai-chat', path: '/v1/chat/completions', body: {
    model: 'client-alias', messages: [{ role: 'user', content: 'ping' }],
  } },
  { format: 'openai-responses', path: '/v1/responses', body: {
    model: 'client-alias', input: 'ping', store: false,
  } },
] satisfies Array<{ format: RouteContext['ingressFormat']; path: string; body: Record<string, unknown> }>;

interface WireRequest {
  authorization: string | undefined;
  body: { project?: string; model?: string; request?: { contents?: unknown[] } };
}

/** Keep the real wire encoder; redirect only its fixed production host. */
class LocalAntigravityTransformer extends AntigravityTransformer {
  override async transformRequestIn(...args: Parameters<AntigravityTransformer['transformRequestIn']>) {
    const result = await super.transformRequestIn(...args);
    if (!result.config || typeof result.config !== 'object') throw new Error('Expected request config');
    Object.assign(result.config, { url: buildAntigravityUrl(args[0].stream === true, endpoint.url) });
    return result;
  }
}

describe('Antigravity project uses the account authenticated for the HTTP attempt', () => {
  let upstream: Server;
  let proxy: ProviderProxy;
  let baseUrl: string;
  let requests: WireRequest[];
  let failFirstUnauthorized: boolean;

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    vi.stubEnv('ANTIGRAVITY_VERSION', '2.8.0');
    resolveProject.mockReset().mockImplementation(async (bearer: string) => `project-${bearer}`);
    requests = [];
    failFirstUnauthorized = false;
    upstream = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) as WireRequest['body'] });
        if (failFirstUnauthorized && requests.length === 1) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'expired credential' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        } }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    endpoint.url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const transformerService = new TransformerService();
    transformerService.registerTransformer('antigravity', new LocalAntigravityTransformer());
    const llmConfig = {
      getProvider: vi.fn(async () => null),
      resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
      getMainTransformer: vi.fn(async () => null),
      getTransformerService: () => transformerService,
    } as unknown as ProviderConfigSource;
    proxy = new ProviderProxy({ llmConfig });
    baseUrl = `http://127.0.0.1:${await proxy.start()}`;
  });

  afterEach(async () => {
    await proxy?.stop();
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
    setSubscriptionRegistryForOutbound(null);
    vi.unstubAllEnvs();
  });

  function fixture(format: RouteContext['ingressFormat']) {
    let refreshed = false;
    const applyHeaders = vi.fn(async (headers: Record<string, string>, hints?: AuthApplyHints) => {
      const account = refreshed ? 'c' : 'b';
      headers.Authorization = `Bearer account-${account}`;
      hints?.reportSelection?.(account, false, 'gemini-3-pro-low');
    });
    const onUnauthorized = vi.fn(async () => { refreshed = true; return true; });
    const profile: SubscriptionDispatchProfile = {
      providerId: 'antigravity', displayName: 'Antigravity', mode: 'transformer',
      authStrategy: {
        providerId: 'antigravity', kind: 'oauth-bearer', applyHeaders, onUnauthorized,
        describeStatus: async () => ({ providerId: 'antigravity', ok: true }),
      },
      resolveUpstreamUrl: () => `${endpoint.url}/v1internal:generateContent`,
      providerTransformerNames: ['antigravity'], modelTransformerNames: [],
    };
    const token = proxy.addRoute({
      sessionId: 'project-binding-session', targetProviderFormat: 'transform',
      model: 'gemini-3-pro', ingressFormat: format,
      authMode: 'subscription', providerId: 'antigravity', subscriptionProfile: profile,
      preferredAccountGroup: 'paid', boundAccountFallbackPolicy: 'pool',
    });
    return {
      applyHeaders, onUnauthorized,
      post: (path: string, body: Record<string, unknown>) => fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    };
  }

  it.each(ingresses)('$format sends the project resolved from its actual Bearer, selecting once', async ({ format, path, body }) => {
    const { post, applyHeaders } = fixture(format);
    const response = await post(path, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('pong');
    expect(applyHeaders).toHaveBeenCalledTimes(1);
    expect(applyHeaders.mock.calls[0]?.[1]).toMatchObject({
      resolvedModel: 'gemini-3-pro', preferredAccountGroup: 'paid',
    });
    expect(resolveProject).toHaveBeenCalledExactlyOnceWith('account-b');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: 'Bearer account-b',
      body: { project: 'project-account-b', model: 'gemini-3-pro-low' },
    });
    expect(requests[0].body.request?.contents).toHaveLength(1);
  });

  it.each(ingresses)('$format surfaces project resolution failure without calling upstream', async ({ format, path, body }) => {
    const { post, applyHeaders } = fixture(format);
    resolveProject.mockRejectedValueOnce(new Error('project unavailable'));
    const response = await post(path, body);
    expect(response.status).toBe(502);
    await response.text();
    expect(applyHeaders).toHaveBeenCalledTimes(1);
    expect(resolveProject).toHaveBeenCalledExactlyOnceWith('account-b');
    expect(requests).toEqual([]);
  });

  it.each(ingresses)('$format rebinds the project when a 401 refresh changes the Bearer', async ({ format, path, body }) => {
    const { post, applyHeaders, onUnauthorized } = fixture(format);
    failFirstUnauthorized = true;
    const response = await post(path, body);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('pong');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(applyHeaders).toHaveBeenCalledTimes(2);
    expect(resolveProject.mock.calls).toEqual([['account-b'], ['account-c']]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ authorization: 'Bearer account-b', body: { project: 'project-account-b' } });
    expect(requests[1]).toMatchObject({ authorization: 'Bearer account-c', body: { project: 'project-account-c' } });
  });
});
