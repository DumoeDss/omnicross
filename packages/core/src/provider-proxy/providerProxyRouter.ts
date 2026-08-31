/**
 * providerProxyRouter — method+path dispatch + route-token auth for the resident
 * `ProviderProxy` (tasks 2.4 + 2.5).
 *
 * For every inbound request this:
 *   1. extracts the per-run route token from the `Authorization: Bearer <token>`
 *      header (the forwarded sentinel the CLI/SDK carries — `ANTHROPIC_AUTH_TOKEN`
 *      / `OPENAI_API_KEY`) OR, for the gemini-CLI, the `x-goog-api-key` header
 *      (Gemini's default auth header). It looks the token up in the route map and
 *      REJECTS (401) on a miss / expired entry with NO fallback. The forwarded
 *      sentinel value is discarded — the proxy re-auths upstream via the route's
 *      AuthSource.
 *   2. dispatches by method+path to the matching ingress parser
 *      (Anthropic Messages: `POST .../v1/messages`; OpenAI Responses: `POST`
 *      path ending `/responses`; OpenAI Chat Completions: `POST` path ending
 *      `/chat/completions`; Gemini `generateContent`: `POST` path whose final
 *      segment is `:generateContent` / `:streamGenerateContent`), or 404 when
 *      none matches.
 *
 * @module provider-proxy/providerProxyRouter
 */

import type http from 'node:http';

import {
  classifyOpenAIOperation,
  OpenAIOperationError,
  unsupportedOpenAIOperation,
  writeOpenAIOperationError,
} from '../openai-operation';
import {
  handleAnthropicMessagesRequest,
  isAnthropicMessagesRequest,
} from './ingress/anthropicMessagesIngress';
import { classifyAnthropicMessagesPath } from './ingress/anthropicPathMatch';
import {
  markAnthropicProtocolResponse,
} from './ingress/anthropicErrorEnvelope';
import {
  handleGeminiGenerateContentRequest,
  isGeminiGenerateContentRequest,
} from './ingress/geminiGenerateContentIngress';
import {
  handleOpenAIChatRequest,
} from './ingress/openaiChatIngress';
import {
  handleOpenAIResponsesRequest,
} from './ingress/openaiResponsesIngress';
import { readBody, writeError } from './ingress/providerProxyShared';
import {
  createResponsesAbortScope,
  ResponsesRequestTimeoutError,
} from './responses/responsesAbort';
import type { ProviderProxyRouteMap } from './providerProxyRouteMap';
import type { ProviderProxyDeps } from './types';

/**
 * Extract the route token from an `Authorization` header. Accepts
 * `Bearer <token>` (the SDK/CLI sentinel shape) and a bare token. Returns
 * `undefined` when no usable token is present.
 */
export function extractRouteToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const trimmed = authHeader.trim();
  if (!trimmed) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  return (m ? m[1] : trimmed).trim() || undefined;
}

/**
 * Resolve the per-run route token from a request's headers. Tries the
 * `Authorization` header first (the claude / codex / qwen / copilot / opencode
 * sentinel shape), then falls back to `x-goog-api-key` (Gemini's default auth
 * header — the gemini-CLI carries the token there, NOT in `Authorization`). The
 * `x-goog-api-key` value is a bare token (no `Bearer` prefix).
 */
export function resolveRouteToken(req: http.IncomingMessage): string | undefined {
  const fromAuth = extractRouteToken(req.headers['authorization'] as string | undefined);
  if (fromAuth) return fromAuth;
  const googKey = req.headers['x-goog-api-key'];
  const value = Array.isArray(googKey) ? googKey[0] : googKey;
  return value?.trim() || undefined;
}

/**
 * Route one request: auth by token, then dispatch by method+path. The HTTP
 * server's request listener delegates here.
 */
export async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: ProviderProxyRouteMap,
  deps: ProviderProxyDeps,
): Promise<void> {
  // ANTHROPIC-PROTOCOL MARK (claude-api-routing-errors, design D4). Classify
  // the path FIRST — before token auth — so every LOCAL error on a
  // `/v1/messages*` request (incl. the 401 below) carries the Anthropic error
  // envelope an Anthropic SDK can type-parse. Relay paths never consult the
  // mark — upstream errors stay verbatim.
  if (classifyAnthropicMessagesPath(req.url) !== null) {
    markAnthropicProtocolResponse(res);
  }

  // 1. Token auth (code-enforced isolation — no fallback on miss/expired).
  //    `Authorization: Bearer <token>` OR `x-goog-api-key: <token>` (gemini-CLI).
  const token = resolveRouteToken(req);
  const route = routes.lookup(token);
  if (!route) {
    writeError(res, 401, 'Invalid or expired route token');
    return;
  }

  // 2. Read body once, then dispatch by method+path to the matching parser.
  const method = req.method;
  const url = req.url;
  const openAIOperation = classifyOpenAIOperation(method, url);

  if (openAIOperation?.owner === 'extension') {
    const registry = deps.openAIOperationRegistry;
    if (!registry) {
      writeOpenAIOperationError(res, unsupportedOpenAIOperation(openAIOperation));
      return;
    }
    const handled = await registry.dispatch({
      operation: openAIOperation,
      request: req,
      response: res,
      route,
      deps,
    });
    if (!handled) {
      writeOpenAIOperationError(res, unsupportedOpenAIOperation(openAIOperation));
    }
    return;
  }

  if (isAnthropicMessagesRequest(method, url)) {
    // Delegation path: the host's per-request handler reads the body
    // itself, so pass `req` straight through (do NOT pre-read it here).
    await handleAnthropicMessagesRequest(req, res, route, deps);
    return;
  }

  if (openAIOperation?.id === 'responses.create') {
    const abortScope = createResponsesAbortScope({ request: req, response: res });
    try {
      const rawBody = await readBody(req, abortScope.signal);
      // Preserve Codex's session-id compatibility headers for account-pool
      // affinity. The ingress treats this as metadata only and never forwards
      // the headers as credentials.
      await handleOpenAIResponsesRequest(
        res,
        rawBody,
        route,
        deps,
        req.headers,
        abortScope.signal,
        (isStream) => {
          if (isStream) abortScope.disableTimeout();
        },
      );
    } catch (error) {
      if (abortScope.signal.reason instanceof ResponsesRequestTimeoutError) {
        writeOpenAIOperationError(res, new OpenAIOperationError({
          status: 504,
          code: 'request_timeout',
          message: 'Responses request timed out',
          retryable: true,
        }));
      } else if (!abortScope.signal.aborted) {
        throw error;
      }
    } finally {
      abortScope.dispose();
    }
    return;
  }

  if (openAIOperation?.id === 'chat.completions.create') {
    const rawBody = await readBody(req);
    await handleOpenAIChatRequest(res, rawBody, route, deps);
    return;
  }

  if (isGeminiGenerateContentRequest(method, url)) {
    const rawBody = await readBody(req);
    await handleGeminiGenerateContentRequest(res, rawBody, url, route, deps);
    return;
  }

  writeError(res, 404, `Unsupported: ${method} ${url}`);
}
