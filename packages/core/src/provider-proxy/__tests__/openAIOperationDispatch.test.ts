import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { OpenAIOperationRegistry } from '../../openai-operation';
import { routeRequest } from '../providerProxyRouter';
import { ProviderProxyRouteMap } from '../providerProxyRouteMap';
import type { ProviderProxyDeps, RouteContext } from '../types';

class MockRequest extends EventEmitter {
  method = 'POST';
  url: string;
  headers: Record<string, string>;
  aborted = false;
  complete = false;
  private readonly body: string;

  constructor(url: string, token: string, body = '{}') {
    super();
    this.url = url;
    this.headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    this.body = body;
  }

  start(): void {
    process.nextTick(() => {
      if (this.body) this.emit('data', Buffer.from(this.body, 'utf8'));
      this.complete = true;
      this.emit('end');
    });
  }
}

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
}

const route: RouteContext = {
  sessionId: 'route-session',
  targetProviderFormat: 'openai-responses',
  model: 'gpt-5.6',
  ingressFormat: 'openai-responses',
  authMode: 'byo',
  providerId: 'openai',
};

function setup(registry?: OpenAIOperationRegistry) {
  const routes = new ProviderProxyRouteMap();
  const token = routes.addRoute(route);
  const deps = {
    llmConfig: {
      getProvider: async () => undefined,
    },
    openAIOperationRegistry: registry,
  } as unknown as ProviderProxyDeps;
  return { routes, token, deps };
}

describe('providerProxyRouter OpenAI operation dispatch', () => {
  it('dispatches compact to the registered extension after route-token validation', async () => {
    const registry = new OpenAIOperationRegistry();
    const handler = vi.fn(async ({ operation, response }) => {
      expect(operation.id).toBe('responses.compact');
      response.writeHead(204);
      response.end();
    });
    registry.register('responses.compact', handler);
    const { routes, token, deps } = setup(registry);
    const req = new MockRequest('/openai/responses/compact', token);
    const res = new MockResponse();

    await routeRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      routes,
      deps,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(204);
  });

  it('rejects a recognized extension without a handler before reading its body', async () => {
    const { routes, token, deps } = setup();
    const req = new MockRequest('/v1/responses/compact', token, 'never-read');
    const dataSpy = vi.fn();
    req.on('data', dataSpy);
    const res = new MockResponse();

    await routeRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      routes,
      deps,
    );

    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).error.code).toBe('unsupported_capability');
    expect(dataSpy).not.toHaveBeenCalled();
  });

  it('keeps Responses create on the built-in ingress even when a registry exists', async () => {
    const registry = new OpenAIOperationRegistry();
    const compactHandler = vi.fn(async () => {});
    registry.register('responses.compact', compactHandler);
    const { routes, token, deps } = setup(registry);
    const req = new MockRequest('/v1/responses?trace=true', token, 'not-json');
    const res = new MockResponse();
    req.start();

    await routeRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      routes,
      deps,
    );

    expect(compactHandler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe('Invalid JSON in request body');
  });
});
