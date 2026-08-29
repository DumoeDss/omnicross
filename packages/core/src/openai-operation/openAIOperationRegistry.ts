/**
 * Trusted in-process handler seam for extension-owned OpenAI operations.
 *
 * The registry owns uniqueness, request-lifetime cancellation, and the narrow
 * local error envelope. Authentication and route selection remain outside this
 * module and must complete before dispatch.
 *
 * @module openai-operation/openAIOperationRegistry
 */

import type http from 'node:http';

import type { ProviderProxyDeps, RouteContext } from '../provider-proxy/types';

import {
  getOpenAIOperation,
  type ExtensionOpenAIOperationId,
  type OpenAIOperation,
  type OpenAIOperationId,
} from './openAIOperation';

export interface OpenAIOperationHandlerContext {
  readonly operation: OpenAIOperation;
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly route: RouteContext;
  readonly deps: ProviderProxyDeps;
  readonly signal: AbortSignal;
}

export type OpenAIOperationHandler = (
  context: OpenAIOperationHandlerContext,
) => Promise<void>;

export type OpenAIOperationRegistrationErrorCode =
  | 'builtin_operation'
  | 'duplicate_operation_handler';

export class OpenAIOperationRegistrationError extends Error {
  readonly name = 'OpenAIOperationRegistrationError';

  constructor(
    readonly code: OpenAIOperationRegistrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenAIOperationErrorInit {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export class OpenAIOperationError extends Error {
  readonly name = 'OpenAIOperationError';
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly headers: Readonly<Record<string, string>>;

  constructor(init: OpenAIOperationErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.headers = init.headers ?? {};
  }
}

const SAFE_LOCAL_ERROR_HEADERS = new Set(['retry-after', 'x-request-id']);

function safeErrorHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SAFE_LOCAL_ERROR_HEADERS.has(name.toLowerCase())) safe[name] = value;
  }
  return safe;
}

/** Write a typed, locally-generated OpenAI-compatible error before streaming starts. */
export function writeOpenAIOperationError(
  res: http.ServerResponse,
  error: OpenAIOperationError,
): boolean {
  if (res.headersSent || res.writableEnded) return false;
  res.writeHead(error.status, {
    'Content-Type': 'application/json',
    ...safeErrorHeaders(error.headers),
  });
  res.end(JSON.stringify({
    error: {
      type: 'openai_operation_error',
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  }));
  return true;
}

export function unsupportedOpenAIOperation(operation: OpenAIOperation): OpenAIOperationError {
  return new OpenAIOperationError({
    status: 501,
    code: 'unsupported_capability',
    message: `Operation '${operation.id}' is not available`,
  });
}

export interface OpenAIOperationDispatchContext {
  readonly operation: OpenAIOperation;
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly route: RouteContext;
  readonly deps: ProviderProxyDeps;
}

export class OpenAIOperationRegistry {
  private readonly handlers = new Map<ExtensionOpenAIOperationId, OpenAIOperationHandler>();

  register(
    operationId: ExtensionOpenAIOperationId,
    handler: OpenAIOperationHandler,
  ): () => void {
    const operation = getOpenAIOperation(operationId as OpenAIOperationId);
    if (operation.owner !== 'extension') {
      throw new OpenAIOperationRegistrationError(
        'builtin_operation',
        `Operation '${operationId}' is owned by a built-in ingress`,
      );
    }
    if (this.handlers.has(operationId)) {
      throw new OpenAIOperationRegistrationError(
        'duplicate_operation_handler',
        `Operation '${operationId}' already has a handler`,
      );
    }
    this.handlers.set(operationId, handler);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.handlers.get(operationId) === handler) this.handlers.delete(operationId);
    };
  }

  has(operationId: OpenAIOperationId): boolean {
    return this.handlers.has(operationId as ExtensionOpenAIOperationId);
  }

  async dispatch(context: OpenAIOperationDispatchContext): Promise<boolean> {
    const handler = this.handlers.get(context.operation.id as ExtensionOpenAIOperationId);
    if (!handler) return false;

    const controller = new AbortController();
    const abort = (): void => {
      if (!controller.signal.aborted) controller.abort();
    };
    const onRequestClose = (): void => {
      if (context.request.aborted || !context.request.complete) abort();
    };
    const onResponseClose = (): void => {
      if (!context.response.writableEnded) abort();
    };

    context.request.once('aborted', abort);
    context.request.once('close', onRequestClose);
    context.response.once('close', onResponseClose);
    if (context.request.aborted || context.response.destroyed) abort();

    try {
      await handler({ ...context, signal: controller.signal });
      return true;
    } catch (error) {
      const publicError = error instanceof OpenAIOperationError
        ? error
        : new OpenAIOperationError({
            status: 500,
            code: 'operation_handler_failed',
            message: `Operation '${context.operation.id}' handler failed`,
          });
      if (!writeOpenAIOperationError(context.response, publicError)) {
        throw new Error(publicError.message);
      }
      return true;
    } finally {
      context.request.removeListener('aborted', abort);
      context.request.removeListener('close', onRequestClose);
      context.response.removeListener('close', onResponseClose);
    }
  }
}
