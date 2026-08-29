import {
  OpenAIOperationError,
  type OpenAIOperationHandler,
  type OpenAIOperationRegistry,
} from '../../openai-operation';
import { readBody } from '../ingress/providerProxyShared';
import { handleResponsesOperation } from '../ingress/openaiResponsesIngress';

import type { ResponsesAffinityStore } from './responsesAffinity';
import { createResponsesAbortScope, ResponsesRequestTimeoutError } from './responsesAbort';

export interface ResponsesCompactRegistrationOptions {
  readonly affinityStore?: ResponsesAffinityStore;
  readonly timeoutMs?: number;
}

export function createResponsesCompactHandler(
  options: ResponsesCompactRegistrationOptions = {},
): OpenAIOperationHandler {
  return async (context) => {
    const scope = createResponsesAbortScope({
      request: context.request,
      response: context.response,
      parentSignal: context.signal,
      timeoutMs: options.timeoutMs,
    });
    try {
      const rawBody = await readBody(context.request, scope.signal);
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed as Record<string, unknown>;
      } catch {
        throw new OpenAIOperationError({
          status: 400,
          code: 'invalid_request_body',
          message: 'Responses compact request body must be a JSON object',
        });
      }
      await handleResponsesOperation(
        context.response,
        body,
        context.route,
        context.deps,
        context.request.headers,
        scope.signal,
        'compact',
        options.affinityStore,
      );
    } catch (error) {
      if (scope.signal.reason instanceof ResponsesRequestTimeoutError) {
        if (!context.response.headersSent) {
          throw new OpenAIOperationError({
            status: 504,
            code: 'request_timeout',
            message: 'Responses compact request timed out',
            retryable: true,
          });
        }
        return;
      }
      if (scope.signal.aborted && !(error instanceof OpenAIOperationError)) return;
      throw error;
    } finally {
      scope.dispose();
    }
  };
}

/** Register the extension-owned compact operation and return its idempotent disposer. */
export function registerResponsesCompactOperation(
  registry: OpenAIOperationRegistry,
  options: ResponsesCompactRegistrationOptions = {},
): () => void {
  return registry.register('responses.compact', createResponsesCompactHandler(options));
}
