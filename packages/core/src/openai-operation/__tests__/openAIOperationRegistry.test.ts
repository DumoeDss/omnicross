import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { ProviderProxyDeps, RouteContext } from '../../provider-proxy/types';
import { getOpenAIOperation, type ExtensionOpenAIOperationId } from '../openAIOperation';
import {
  OpenAIOperationError,
  OpenAIOperationRegistrationError,
  OpenAIOperationRegistry,
} from '../openAIOperationRegistry';

class MockRequest extends EventEmitter {
  aborted = false;
  complete = false;
}

class MockResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }

  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.writableEnded = true;
  }
}

const route = {
  sessionId: 'session-1',
  targetProviderFormat: 'openai-responses',
  model: 'gpt-5.6',
  ingressFormat: 'openai-responses',
  authMode: 'byo',
  providerId: 'openai',
} as RouteContext;

const deps = {
  llmConfig: {},
} as unknown as ProviderProxyDeps;

function context(
  operationId: 'responses.compact' | 'images.generate' | 'images.edit' = 'responses.compact',
) {
  const request = new MockRequest();
  const response = new MockResponse();
  return {
    request,
    response,
    dispatch: {
      operation: getOpenAIOperation(operationId),
      request: request as unknown as http.IncomingMessage,
      response: response as unknown as http.ServerResponse,
      route,
      deps,
    },
  };
}

describe('OpenAIOperationRegistry', () => {
  it('dispatches exactly one registered handler and removes lifecycle listeners', async () => {
    const registry = new OpenAIOperationRegistry();
    const handler = vi.fn(async () => {});
    registry.register('responses.compact', handler);
    const { request, response, dispatch } = context();

    await expect(registry.dispatch(dispatch)).resolves.toBe(true);

    expect(handler).toHaveBeenCalledOnce();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('rejects duplicate and built-in registrations with stable codes', () => {
    const registry = new OpenAIOperationRegistry();
    registry.register('responses.compact', async () => {});

    expect(() => registry.register('responses.compact', async () => {})).toThrowError(
      expect.objectContaining<Partial<OpenAIOperationRegistrationError>>({
        code: 'duplicate_operation_handler',
      }),
    );
    expect(() => registry.register(
      'responses.create' as ExtensionOpenAIOperationId,
      async () => {},
    )).toThrowError(expect.objectContaining<Partial<OpenAIOperationRegistrationError>>({
      code: 'builtin_operation',
    }));
  });

  it('supports idempotent disposal and reports a missing handler', async () => {
    const registry = new OpenAIOperationRegistry();
    const dispose = registry.register('images.generate', async () => {});
    expect(registry.has('images.generate')).toBe(true);

    dispose();
    dispose();

    expect(registry.has('images.generate')).toBe(false);
    await expect(registry.dispatch(context('images.generate').dispatch)).resolves.toBe(false);
  });

  it('aborts the handler signal when the request is aborted', async () => {
    const registry = new OpenAIOperationRegistry();
    let observedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    registry.register('responses.compact', async ({ signal }) => {
      observedSignal = signal;
      markStarted?.();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const { request, dispatch } = context();

    const pending = registry.dispatch(dispatch);
    await started;
    request.aborted = true;
    request.emit('aborted');

    await expect(pending).resolves.toBe(true);
    expect(observedSignal?.aborted).toBe(true);
  });

  it('writes typed local failures and filters unsafe response headers', async () => {
    const registry = new OpenAIOperationRegistry();
    registry.register('responses.compact', async () => {
      throw new OpenAIOperationError({
        status: 429,
        code: 'subscription_usage_limit_reached',
        message: 'Try later',
        retryable: true,
        headers: {
          'Retry-After': '12',
          'Set-Cookie': 'secret=not-allowed',
        },
      });
    });
    const { response, dispatch } = context();

    await expect(registry.dispatch(dispatch)).resolves.toBe(true);

    expect(response.statusCode).toBe(429);
    expect(response.headers['Retry-After']).toBe('12');
    expect(response.headers['Set-Cookie']).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({
      error: {
        type: 'openai_operation_error',
        code: 'subscription_usage_limit_reached',
        message: 'Try later',
        retryable: true,
      },
    });
  });

  it('redacts undeclared handler failures behind a generic local error', async () => {
    const registry = new OpenAIOperationRegistry();
    registry.register('responses.compact', async () => {
      throw new Error('private upstream detail');
    });
    const { response, dispatch } = context();

    await expect(registry.dispatch(dispatch)).resolves.toBe(true);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private upstream detail');
    expect(JSON.parse(response.body).error.code).toBe('operation_handler_failed');
  });
});
