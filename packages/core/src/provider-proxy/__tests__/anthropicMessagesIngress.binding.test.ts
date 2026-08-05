import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { handleAnthropicMessagesRequest } from '../ingress/anthropicMessagesIngress';
import type {
  AnthropicRouteHandlerParams,
  ProviderProxyDeps,
  RouteContext,
} from '../types';

class MockRequest extends EventEmitter {
  method = 'POST';
  url = '/v1/messages';
  headers: Record<string, string> = {};
}

class MockResponse {
  statusCode = 0;
  headersSent = false;
  body = '';

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

function route(fallback: 'strict' | 'pool' = 'strict'): RouteContext {
  return {
    sessionId: 'outbound:client-a:route-a',
    targetProviderFormat: 'transform',
    model: 'gpt-5.6-sol',
    ingressFormat: 'anthropic-messages',
    authMode: 'byo',
    providerId: 'openai',
    preferredKeyId: 'provider-key-a',
    boundKeyFallbackPolicy: fallback,
    anthropicSdkHints: {
      apiKey: 'row-key',
      isOfficialProvider: false,
      passThrough: false,
    },
  };
}

function deps(options: {
  getKeyById: () => Promise<string | null>;
  getKeyForSession?: () => Promise<string | null>;
  capture: (params: AnthropicRouteHandlerParams) => void;
}): ProviderProxyDeps {
  return {
    llmConfig: {
      getProvider: async () => ({
        id: 'openai',
        name: 'OpenAI',
        api_key: 'row-key',
        api_base_url: 'https://example.invalid/v1',
        models: ['gpt-5.6-sol'],
        enabled: true,
      }),
    },
    apiKeyPool: {
      getKeyById: options.getKeyById,
      getKeyForSession: options.getKeyForSession ?? (async () => null),
    },
    anthropicIngressHandlerFactory: (params) => {
      options.capture(params);
      return {
        handle: async (_req, res) => {
          res.writeHead(204);
          res.end();
        },
      };
    },
  } as unknown as ProviderProxyDeps;
}

async function run(
  context: RouteContext,
  proxyDeps: ProviderProxyDeps,
): Promise<MockResponse> {
  const req = new MockRequest();
  const res = new MockResponse();
  await handleAnthropicMessagesRequest(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    context,
    proxyDeps,
  );
  return res;
}

describe('Anthropic delegated ingress — provider-key binding', () => {
  it('resolves the selected provider key before invoking a host factory', async () => {
    let captured: AnthropicRouteHandlerParams | undefined;
    const res = await run(route(), deps({
      getKeyById: async () => 'selected-key',
      capture: (params) => { captured = params; },
    }));

    expect(res.statusCode).toBe(204);
    expect(captured?.apiKey).toBe('selected-key');
    expect(captured?.preferredKeyId).toBe('provider-key-a');
    expect(captured?.boundKeyFallbackPolicy).toBe('strict');
  });

  it('fails before delegation when a strict selected key is unavailable', async () => {
    const capture = vi.fn();
    const res = await run(route(), deps({ getKeyById: async () => null, capture }));

    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('API key not configured');
    expect(capture).not.toHaveBeenCalled();
  });

  it('uses the normal pool only when the binding explicitly allows fallback', async () => {
    let captured: AnthropicRouteHandlerParams | undefined;
    const res = await run(route('pool'), deps({
      getKeyById: async () => null,
      getKeyForSession: async () => 'pool-key',
      capture: (params) => { captured = params; },
    }));

    expect(res.statusCode).toBe(204);
    expect(captured?.apiKey).toBe('pool-key');
  });
});
