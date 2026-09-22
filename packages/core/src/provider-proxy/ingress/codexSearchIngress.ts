/** Native Codex SearchClient relay; the upstream owns all search commands and state. */
import type http from 'node:http';

import { OpenAIOperationError } from '../../openai-operation';
import { extractCodexClientHeaders } from '../identity/codexCliHeaders';
import { deriveGatewaySessionKey, type SessionRequestHeaders } from '../matchText';
import { throwIfResponsesAborted } from '../responses/responsesAbort';
import {
  buildResponsesCallPlan,
  executeResponsesUpstream,
  resolveResponsesRouteProfile,
} from '../responses/responsesDriver';
import { deriveCodexSearchUrl } from '../responses/responsesUrl';
import type { ProviderProxyDeps, RouteContext } from '../types';

import { relayResponse } from './providerProxyShared';

export async function handleNativeCodexSearchRequest(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
  headers: SessionRequestHeaders,
  signal: AbortSignal,
): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); }
  catch { throw invalidRequest('Search request body must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRequest('Search request body must be an object');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw invalidRequest('Search request requires a model');
  }
  throwIfResponsesAborted(signal);
  const resolved = await resolveResponsesRouteProfile(route, deps, route.model);
  if (resolved.profile !== 'native') {
    throw new OpenAIOperationError({
      status: 400,
      code: 'unsupported_capability',
      message: 'Native Codex search requires a Codex subscription or a native Responses upstream',
    });
  }
  // SearchRequest.id is Codex's conversation id. Use it for account affinity
  // when the client did not also send the usual session/thread headers.
  const session = deriveGatewaySessionKey(
    typeof body.id === 'string' ? { ...body, session_id: body.id } : body,
    headers,
    { fallbackKey: route.apiKeyId ?? route.sessionId ?? undefined, endpoint: 'responses' },
  );
  const plan = await buildResponsesCallPlan(
    route, deps, resolved, route.model, false, session.key, session.source, headers,
  );
  deriveCodexSearchUrl(plan.upstreamUrl);
  const result = await executeResponsesUpstream(
    body,
    { ...plan, callerClientHeaders: extractCodexClientHeaders(headers) },
    'search',
    signal,
    rawBody,
  );
  // Preserve output, opaque results, encrypted_output and upstream errors.
  // No query extraction, model-output rewrite or managed-search fallback.
  await relayResponse(res, result.response, false, undefined, undefined, undefined, signal);
}

function invalidRequest(message: string): OpenAIOperationError {
  return new OpenAIOperationError({ status: 400, code: 'invalid_request', message });
}
