/**
 * openaiResponsesIngress — the ProviderProxy OpenAI-Responses ingress parser.
 *
 * Matches `POST <base>/responses` (any path ending in `/responses`, per the
 * codex `base_url=.../openai` + `wire_api="responses"` contract) and routes the
 * decoded Responses-API request through the shared Responses driver. Native
 * routes preserve the Responses wire contract; reduced routes are validated
 * before the existing transformer pipeline runs.
 *
 * @module provider-proxy/ingress/openaiResponsesIngress
 */

import type http from 'node:http';

import type { UsageCacheKeySource } from '@omnicross/contracts/usage-stats-types';

import { isAccountAllowanceExhaustedError } from '../../pipeline/AccountAllowanceScheduling';
import { isBoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import {
  OpenAIOperationError,
  writeOpenAIOperationError,
} from '../../openai-operation';

import { serializeError } from '@omnicross/core/serializeError';

import {
  deriveGatewaySessionKey,
  type DerivedSessionKey,
  type SessionKeySource,
  type SessionRequestHeaders,
} from '../matchText';
import type { ProviderProxyDeps, RouteContext } from '../types';
import { recordResponsesNonStreamUsage, recordResponsesStreamUsage } from '../usage/recordResponsesUsage';

import {
  relayResponse,
  writeBoundAccountError,
  writeError,
} from './providerProxyShared';
import { getSharedAccountRouteActivity } from '../../pipeline/AccountRouteActivity';
import { getSharedOverloadCounter } from '../../pipeline/ServerOverloadCounter';
import {
  getResponsesAffinityStore,
  previousResponseNotFound,
  type ResponsesAffinityStore,
} from '../responses/responsesAffinity';
import { ResponsesRequestTimeoutError } from '../responses/responsesAbort';
import {
  buildResponsesCallPlan as buildSharedResponsesCallPlan,
  executeResponsesUpstream,
  resolveResponsesRouteProfile,
  type ResponsesPipelineResult,
  type ResponsesOperationKind,
} from '../responses/responsesDriver';
import {
  hasResponsesHostedImageWork,
  type ResponsesHostedImageRequestLease,
} from '../responses/responsesHostedImageIngress';
export {
  retryAroundCodexUsageLimit,
  type ResponsesCallPlan,
} from '../responses/responsesDriver';
import {
  unsupportedResponsesCapability,
  validateReducedResponsesRequest,
} from '../responses/responsesProfile';

/**
 * SSE `response.failed` `error.code` values that mean the Codex/OpenAI backend
 * itself is overloaded (account-independent capacity) — NOT a quota/usage wall.
 * Mirrors Codex CLI's own classifier (`codex-api/src/sse/responses.rs:669`).
 * Delivered INSIDE a `200` stream, which is why the route-activity HTTP-status
 * layer never sees them and the existing 429-quota retry does not fire.
 */
const SERVER_OVERLOADED_CODES = new Set(['server_is_overloaded', 'slow_down']);

/**
 * True when a parsed Responses-API SSE event is the server-overload failure.
 * Detection only — the caller RECORDS/annotates but never retries (overload is
 * account-independent; retrying on another account won't help and may worsen it).
 * Exported for unit testing.
 */
export function isCodexServerOverloadEvent(event: Record<string, unknown>): boolean {
  if (event['type'] !== 'response.failed') return false;
  const error = (event['response'] as Record<string, unknown> | undefined)?.['error'] as
    | Record<string, unknown>
    | undefined;
  const code = error?.['code'];
  return typeof code === 'string' && SERVER_OVERLOADED_CODES.has(code);
}
/**
 * Match the codex `/responses` route: `POST` + any path ENDING IN `/responses`
 * (NOT hardcoded `/v1/responses`). Identical to the host's codex
 * request matcher.
 */
export function isOpenAIResponsesRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method !== 'POST' || !url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path.endsWith('/responses');
}

interface PromptCacheKeyAttribution {
  readonly cacheKeySource: UsageCacheKeySource;
  readonly cacheKeyInjected: boolean;
}

type InjectedCacheKeySource = Exclude<UsageCacheKeySource, 'client' | 'none'>;

const SAFE_INJECTED_CACHE_KEY_SOURCES = new Set<SessionKeySource>([
  'session-header',
  'thread-header',
  'body-session-id',
  'body-thread-id',
  'content-fingerprint',
]);

function isSafeInjectedCacheKeySource(
  source: SessionKeySource,
): source is InjectedCacheKeySource {
  return SAFE_INJECTED_CACHE_KEY_SOURCES.has(source);
}

/**
 * Preserve a caller-provided cache key, or attach a stable opaque key for a
 * Codex request only when it was derived from conversation-specific metadata.
 * Route/API-key fallbacks are deliberately excluded because they would merge
 * unrelated conversations into one upstream cache namespace.
 */
export function ensureCodexPromptCacheKey(
  body: Record<string, unknown>,
  proxyProviderId: string,
  derivedSession: DerivedSessionKey,
): PromptCacheKeyAttribution {
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.trim()) {
    return { cacheKeySource: 'client', cacheKeyInjected: false };
  }
  if (
    proxyProviderId !== 'codex' ||
    !isSafeInjectedCacheKeySource(derivedSession.source)
  ) {
    return { cacheKeySource: 'none', cacheKeyInjected: false };
  }

  body.prompt_cache_key = `omnicross:${derivedSession.source}:${derivedSession.key}`;
  return {
    cacheKeySource: derivedSession.source,
    cacheKeyInjected: true,
  };
}

/**
 * Handle one OpenAI-Responses request for the resolved `RouteContext`. The
 * route's `authMode` selects the BYO or subscription call plan; the shared core
 * stays auth-origin-agnostic.
 */
export async function handleOpenAIResponsesRequest(
  res: http.ServerResponse,
  rawBody: string,
  route: RouteContext,
  deps: ProviderProxyDeps,
  requestHeaders: SessionRequestHeaders = {},
  signal: AbortSignal = new AbortController().signal,
  onStreamModeResolved?: (isStream: boolean) => void,
): Promise<void> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    writeError(res, 400, 'Invalid JSON in request body');
    return;
  }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    writeOpenAIOperationError(res, new OpenAIOperationError({
      status: 400,
      code: 'invalid_request_body',
      message: 'Responses create request body must be a JSON object',
    }));
    return;
  }
  const responsesBody = parsedBody as Record<string, unknown>;
  onStreamModeResolved?.(responsesBody.stream === true);

  try {
    await handleResponsesOperation(
      res,
      responsesBody,
      route,
      deps,
      requestHeaders,
      signal,
      'create',
    );
  } catch (err) {
    if (isBoundAccountSelectionError(err)) {
      writeBoundAccountError(res, err);
      return;
    }
    if (err instanceof OpenAIOperationError) {
      writeOpenAIOperationError(res, err);
      return;
    }
    if (signal.aborted) {
      if (signal.reason instanceof ResponsesRequestTimeoutError) {
        writeOpenAIOperationError(res, new OpenAIOperationError({
          status: 504,
          code: 'request_timeout',
          message: 'Responses request timed out',
          retryable: true,
        }));
      }
      return;
    }
    const errMsg = serializeError(err);
    console.error('[ProviderProxy:responses] Pipeline error:', errMsg);
    writeError(res, isAccountAllowanceExhaustedError(err) ? 429 : 502, errMsg);
  }
  return;
}

export async function handleResponsesOperation(
  res: http.ServerResponse,
  responsesBody: Record<string, unknown>,
  route: RouteContext,
  deps: ProviderProxyDeps,
  requestHeaders: SessionRequestHeaders,
  signal: AbortSignal,
  operation: ResponsesOperationKind,
  affinityStore: ResponsesAffinityStore = getResponsesAffinityStore(deps),
): Promise<void> {
  const isStream = responsesBody.stream === true;
  const derivedSession = deriveGatewaySessionKey(responsesBody, requestHeaders, {
    endpoint: 'responses',
    fallbackKey: route.apiKeyId ?? route.sessionId ?? undefined,
  });
  const resolvedModel = route.model;
  responsesBody.model = resolvedModel;

  const resolved = await resolveResponsesRouteProfile(route, deps, resolvedModel);
  if (operation === 'compact' && resolved.profile !== 'native') {
    throw unsupportedResponsesCapability('$', 'requires a native Responses provider');
  }
  if (operation === 'create' && resolved.profile === 'reduced') {
    validateReducedResponsesRequest(responsesBody, resolved.capabilities);
  }

  const clientScope = route.apiKeyId
    ? `api-key:${route.apiKeyId}`
    : `route-session:${route.sessionId ?? derivedSession.key}`;
  const affinityScope = {
    providerId: resolved.providerIdentity,
    clientScope,
    sessionKey: derivedSession.key,
  };
  const previousResponseId = typeof responsesBody.previous_response_id === 'string'
    ? responsesBody.previous_response_id.trim()
    : '';
  const affinity = previousResponseId
    ? affinityStore.lookup(previousResponseId, affinityScope)
    : undefined;

  let plan;
  try {
    plan = await buildSharedResponsesCallPlan(
      route,
      deps,
      resolved,
      resolvedModel,
      isStream,
      derivedSession.key,
      derivedSession.source,
      requestHeaders,
      affinity,
    );
  } catch (error) {
    if (affinity && isBoundAccountSelectionError(error)) {
      throw previousResponseNotFound();
    }
    throw error;
  }

  const cacheKeyAttribution = operation === 'create'
    ? ensureCodexPromptCacheKey(responsesBody, plan.proxyProviderId, derivedSession)
    : { cacheKeySource: 'none' as const, cacheKeyInjected: false };
  const previousHostedImageState = affinity?.hostedImage;
  const hasHostedImageWork = operation === 'create' && hasResponsesHostedImageWork(
    responsesBody,
    previousHostedImageState,
  );
  if (hasHostedImageWork && route.hostedImageGenerationAllowed !== true) {
    throw new OpenAIOperationError({
      status: 403,
      code: 'insufficient_permissions',
      message: 'The API key is not allowed to execute image generation',
    });
  }
  if (hasHostedImageWork && resolved.profile !== 'native') {
    throw unsupportedResponsesCapability('$.tools', 'requires a native Responses provider');
  }
  const hostedImageIngress = deps.responsesHostedImageIngress;
  if (hasHostedImageWork && !hostedImageIngress) {
    throw new OpenAIOperationError({
      status: 422,
      code: 'unsupported_capability',
      message: 'Hosted image generation is unavailable',
    });
  }
  if (hasHostedImageWork && !route.apiKeyId) {
    throw new OpenAIOperationError({
      status: 403,
      code: 'insufficient_permissions',
      message: 'Hosted image generation requires an authenticated outbound key',
    });
  }
  let hostedImageRequest: ResponsesHostedImageRequestLease | null = null;
  if (hasHostedImageWork) {
    hostedImageRequest = await hostedImageIngress!.prepare({
      body: responsesBody,
      profile: resolved.profile,
      operation,
      hostedImageGenerationAllowed: true,
      tenantId: route.apiKeyId,
      sessionKey: derivedSession.key,
      ...(previousResponseId ? { authorizedPreviousResponseId: previousResponseId } : {}),
      ...(previousHostedImageState ? { previousHostedImageState } : {}),
      mainProviderId: plan.proxyProviderId,
      signal,
    });
    if (!hostedImageRequest) {
      throw new OpenAIOperationError({
        status: 422,
        code: 'unsupported_capability',
        message: 'Hosted image generation is unavailable',
      });
    }
  }
  let providerResponse: ResponsesPipelineResult;
  try {
    if (hostedImageRequest) {
      // The outbound audit hook may already hold the parsed Responses request.
      // Admission is the irreversible privacy boundary: discard that body and
      // prevent JSON/SSE response capture before any upstream or image bytes can
      // be relayed. Metadata and usage correlation remain attached to `res`.
      route.suppressAuditBodies?.();
    }
    providerResponse = await executeResponsesUpstream(
      hostedImageRequest?.upstreamBody ?? responsesBody,
      plan,
      operation,
      signal,
    );
  } catch (error) {
    await hostedImageRequest?.dispose();
    if (affinity && isBoundAccountSelectionError(error)) {
      throw previousResponseNotFound();
    }
    throw error;
  }
  const usageAttribution = {
    sessionId: route.sessionId,
    providerId: route.providerId ?? plan.proxyProviderId,
    model: providerResponse.actualModel ?? resolvedModel,
    apiKeyId: route.apiKeyId ?? null,
    routeLease: route.routeLease,
    cacheKeySource: cacheKeyAttribution.cacheKeySource,
    cacheKeyInjected: cacheKeyAttribution.cacheKeyInjected,
    auditResponse: res,
  };
  const usageRecorder = deps.usageRecorder;
  const usageTap = usageRecorder
    ? {
        extractUsage(event: Record<string, unknown>): Record<string, unknown> | null | undefined {
          if (event.type !== 'response.completed') return null;
          const response = event.response as Record<string, unknown> | undefined;
          return response?.usage as Record<string, unknown> | undefined;
        },
        onUsage(rawUsage: Record<string, unknown>): void {
          recordResponsesStreamUsage(usageRecorder, rawUsage, usageAttribution);
        },
      }
    : undefined;

  const successful = providerResponse.rawStatus !== null &&
    providerResponse.rawStatus >= 200 && providerResponse.rawStatus < 300;
  let terminalHostedImageState:
    import('../responses/responsesAffinity').ResponsesAffinityHostedImageState | undefined;
  const recordAffinity = (responseId: unknown): void => {
    if (!successful || typeof responseId !== 'string' || !responseId.trim()) return;
    affinityStore.record({
      ...affinityScope,
      responseId,
      credential: providerResponse.credential,
      ...(terminalHostedImageState ? { hostedImage: terminalHostedImageState } : {}),
    });
  };
  if (hostedImageRequest) {
    try {
      const response = await hostedImageRequest.wrapUpstreamResponse({
        response: providerResponse.response,
        rawStatus: providerResponse.rawStatus,
        ...(providerResponse.accountId
          ? { selectedMainAccountId: providerResponse.accountId }
          : {}),
        onTerminalSuccess: async (responseId, state) => {
          terminalHostedImageState = state;
          recordAffinity(responseId);
        },
      });
      providerResponse = { ...providerResponse, response };
    } catch (error) {
      await hostedImageRequest.dispose();
      throw error;
    }
  }
  let overloadRecorded = false;
  const observeSse = (event: Record<string, unknown>): void => {
    if (event.type === 'response.completed') {
      recordAffinity((event.response as Record<string, unknown> | undefined)?.id);
    }
    if (overloadRecorded || !isCodexServerOverloadEvent(event)) return;
    overloadRecorded = true;
    if (providerResponse.activityRecordId) {
      getSharedAccountRouteActivity().amend(providerResponse.activityRecordId, { streamError: 'server_overloaded' });
    }
    if (providerResponse.accountId) {
      getSharedOverloadCounter().recordOverload({
        providerId: plan.proxyProviderId,
        accountId: providerResponse.accountId,
        endpoint: 'responses',
      });
    }
  };
  let bodyText: string | null;
  try {
    bodyText = await relayResponse(
      res,
      providerResponse.response,
      isStream,
      route.requestedModel,
      usageTap,
      observeSse,
      signal,
    );
  } finally {
    await hostedImageRequest?.dispose();
  }
  if (!bodyText) return;
  if (usageRecorder) recordResponsesNonStreamUsage(usageRecorder, bodyText, usageAttribution);
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    if (body.status !== 'failed' && body.status !== 'incomplete') recordAffinity(body.id);
  } catch {
    // The body remains byte-for-byte relayed; observers are best effort only.
  }
}
