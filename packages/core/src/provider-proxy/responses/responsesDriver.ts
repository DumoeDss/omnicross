import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { buildProviderApiUrl, resolveApiFormat } from '../../completion';
import type { AuthSource } from '../../pipeline/AuthSource';
import { executeProviderCall } from '../../pipeline/executeProviderCall';
import { LlmConfigProviderAuth } from '../../pipeline/LlmConfigProviderAuth';
import { resolveProviderChain } from '../../pipeline/resolveProviderChain';
import { resolveSubscriptionChain } from '../../pipeline/resolveSubscriptionChain';
import { SubscriptionAuthSource } from '../../pipeline/SubscriptionAuthSource';
import { fetchUpstream } from '../../pipeline/upstreamFetch';
import { getGeminiCodeAssistResolver } from '../../ports/gemini-code-assist-resolver';
import type {
  LLMProvider as TransformerLLMProvider,
  RequestConfig,
  ResolvedTransformerChain,
} from '../../transformer';
import { OpenAIOperationError } from '../../openai-operation';
import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  extractCodexClientHeaders,
} from '../identity/codexCliHeaders';
import { fillMissingHeaders } from '../identity/headerMerge';
import type { SessionKeySource, SessionRequestHeaders } from '../matchText';
import type { ProviderProxyDeps, RouteContext } from '../types';
import {
  getResponsesEndpointTransformer,
  getSharedExecutor,
  resolvePoolBoundKey,
} from '../ingress/providerProxyShared';
import { markCodexUsageLimitExhaustion } from '../ingress/codexUsageLimitDetection';

import type { ResponsesAffinityEntry, ResponsesCredentialIdentity } from './responsesAffinity';
import { previousResponseNotFound } from './responsesAffinity';
import { throwIfResponsesAborted } from './responsesAbort';
import {
  classifyResponsesProfile,
  type ReducedResponsesCapabilities,
  resolveReducedResponsesCapabilities,
  type ResponsesProfile,
} from './responsesProfile';
import { deriveResponsesCompactUrl } from './responsesUrl';

export type ResponsesOperationKind = 'create' | 'compact';

export interface ResolvedResponsesRouteProfile {
  readonly profile: ResponsesProfile;
  readonly capabilities: ReducedResponsesCapabilities;
  readonly provider?: LLMProvider;
  readonly upstreamUrl?: string;
  readonly providerIdentity: string;
}

export interface ResponsesCallPlan {
  readonly profile: ResponsesProfile;
  readonly auth: AuthSource;
  readonly sessionKey?: string;
  readonly sessionSource?: SessionKeySource;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  readonly boundAccountFallbackPolicy?: RouteContext['boundAccountFallbackPolicy'];
  readonly chain: ResolvedTransformerChain;
  readonly transformerProvider: TransformerLLMProvider;
  readonly resolvedModel: string;
  readonly isStream: boolean;
  readonly resolveUrl: (config: RequestConfig) => string;
  readonly upstreamUrl: string;
  readonly proxyProviderId: string;
  readonly providerIdentity: string;
  readonly callerClientHeaders?: Record<string, string>;
  readonly statefulContinuation: boolean;
  readonly credential: ResponsesCredentialIdentity;
  readonly resolveCredential?: () => ResponsesCredentialIdentity;
}

export interface ResponsesPipelineResult {
  readonly response: Response;
  readonly rawStatus: number | null;
  readonly accountId: string | undefined;
  readonly actualModel?: string;
  readonly activityRecordId: string | undefined;
  readonly credential: ResponsesCredentialIdentity;
}

export async function resolveResponsesRouteProfile(
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolvedModel: string,
): Promise<ResolvedResponsesRouteProfile> {
  if (route.authMode === 'byo') {
    const providerId = route.providerId;
    if (!providerId) {
      throw new OpenAIOperationError({ status: 502, code: 'provider_configuration_error', message: 'BYO route is missing a provider' });
    }
    const provider = await deps.llmConfig.getProvider(providerId);
    if (!provider) {
      throw new OpenAIOperationError({ status: 502, code: 'provider_configuration_error', message: 'Configured provider was not found' });
    }
    const declaration = { authMode: 'byo', providerApiFormat: resolveApiFormat(provider) } as const;
    return {
      profile: classifyResponsesProfile(declaration),
      capabilities: resolveReducedResponsesCapabilities(declaration),
      provider,
      providerIdentity: `byo:${providerId}`,
    };
  }

  const subscriptionProfile = route.subscriptionProfile;
  if (!subscriptionProfile) {
    throw new OpenAIOperationError({ status: 502, code: 'provider_configuration_error', message: 'Subscription route is missing its profile' });
  }
  const upstreamUrl = subscriptionProfile.resolveUpstreamUrl?.(resolvedModel);
  if (!upstreamUrl) {
    throw new OpenAIOperationError({ status: 502, code: 'provider_configuration_error', message: 'Subscription profile is missing its Responses URL' });
  }
  const providerId = subscriptionProfile.authStrategy.providerId;
  const declaration = {
    authMode: 'subscription',
    subscriptionProviderId: providerId,
    subscriptionTransformerNames: subscriptionProfile.providerTransformerNames,
    upstreamUrl,
  } as const;
  return {
    profile: classifyResponsesProfile(declaration),
    capabilities: resolveReducedResponsesCapabilities(declaration),
    upstreamUrl,
    providerIdentity: `subscription:${providerId}`,
  };
}

export async function buildResponsesCallPlan(
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolved: ResolvedResponsesRouteProfile,
  resolvedModel: string,
  isStream: boolean,
  sessionKey: string,
  sessionSource: SessionKeySource,
  requestHeaders: SessionRequestHeaders,
  affinity?: ResponsesAffinityEntry,
): Promise<ResponsesCallPlan> {
  if (route.authMode === 'byo') {
    return buildByoPlan(route, deps, resolved, resolvedModel, isStream, affinity);
  }
  return buildSubscriptionPlan(
    route,
    deps,
    resolved,
    resolvedModel,
    isStream,
    sessionKey,
    sessionSource,
    requestHeaders,
    affinity,
  );
}

async function buildByoPlan(
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolved: ResolvedResponsesRouteProfile,
  resolvedModel: string,
  isStream: boolean,
  affinity?: ResponsesAffinityEntry,
): Promise<ResponsesCallPlan> {
  const providerId = route.providerId!;
  const provider = resolved.provider!;
  const affinityKeyId = affinity?.credential.kind === 'byo-key' ? affinity.credential.id : undefined;
  const preferredKeyId = affinityKeyId ?? route.preferredKeyId;
  const apiKey = await resolvePoolBoundKey(
    deps,
    providerId,
    provider,
    route.sessionId,
    preferredKeyId,
    affinity ? 'strict' : route.boundKeyFallbackPolicy,
  );
  if (!apiKey) {
    if (affinity) throw previousResponseNotFound();
    throw new OpenAIOperationError({ status: 502, code: 'provider_configuration_error', message: 'Provider credential is unavailable' });
  }

  const selectedKeyId = preferredKeyId ?? (
    route.sessionId && typeof deps.apiKeyPool?.getKeyIdForSession === 'function'
      ? deps.apiKeyPool.getKeyIdForSession(providerId, route.sessionId) ?? undefined
      : undefined
  );
  const credential: ResponsesCredentialIdentity = selectedKeyId
    ? { kind: 'byo-key', id: selectedKeyId }
    : { kind: 'provider-key', id: providerId };
  const auth = affinityKeyId
    ? new LlmConfigProviderAuth({ provider, apiKey, apiKeyPool: null, providerId, sessionId: route.sessionId })
    : route.auth ?? new LlmConfigProviderAuth({
        provider,
        apiKey,
        apiKeyPool: deps.apiKeyPool ?? null,
        providerId,
        sessionId: route.sessionId,
      });
  const chain = resolved.profile === 'native'
    ? { providerTransformers: [], modelTransformers: [] }
    : (await resolveProviderChain(deps.llmConfig, providerId, resolvedModel)).chain;
  const transformerProvider: TransformerLLMProvider = {
    name: provider.name,
    baseUrl: provider.api_base_url,
    apiKey,
    models: provider.models || [],
    modelConfigs: provider.modelConfigs,
  };
  const upstreamUrl = buildProviderApiUrl(provider, { model: resolvedModel, stream: isStream });
  return {
    profile: resolved.profile,
    auth,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) => (config.url instanceof URL ? config.url.toString() : upstreamUrl),
    upstreamUrl,
    proxyProviderId: 'byo',
    providerIdentity: resolved.providerIdentity,
    statefulContinuation: !!affinity,
    credential,
    resolveCredential: () => {
      const keyId = route.sessionId && typeof deps.apiKeyPool?.getKeyIdForSession === 'function'
        ? deps.apiKeyPool.getKeyIdForSession(providerId, route.sessionId)
        : null;
      return keyId ? { kind: 'byo-key', id: keyId } : credential;
    },
  };
}

async function buildSubscriptionPlan(
  route: RouteContext,
  deps: ProviderProxyDeps,
  resolved: ResolvedResponsesRouteProfile,
  resolvedModel: string,
  isStream: boolean,
  sessionKey: string,
  sessionSource: SessionKeySource,
  requestHeaders: SessionRequestHeaders,
  affinity?: ResponsesAffinityEntry,
): Promise<ResponsesCallPlan> {
  const profile = route.subscriptionProfile!;
  const upstreamUrl = resolved.upstreamUrl!;
  const affinityAccountId = affinity?.credential.kind === 'subscription-account'
    ? affinity.credential.id
    : undefined;
  const auth = route.auth ?? new SubscriptionAuthSource(profile);
  const chain = resolved.profile === 'native'
    ? { providerTransformers: [], modelTransformers: [] }
    : resolveSubscriptionChain(
        profile,
        deps.llmConfig.getTransformerService(),
        getResponsesEndpointTransformer(),
      );
  const transformerProvider: TransformerLLMProvider = {
    name: profile.authStrategy.providerId,
    baseUrl: upstreamUrl,
    apiKey: '',
    models: [resolvedModel],
  };
  if (profile.authStrategy.providerId === 'gemini') {
    transformerProvider.geminiProject = await resolveGeminiProject(profile, {
      sessionKey,
      preferredAccountId: affinityAccountId ?? route.preferredAccountId,
      preferredAccountGroup: affinity ? undefined : route.preferredAccountGroup,
      boundAccountFallbackPolicy: affinity ? 'strict' : route.boundAccountFallbackPolicy,
    });
  }
  return {
    profile: resolved.profile,
    auth,
    sessionKey,
    sessionSource,
    preferredAccountId: affinityAccountId ?? route.preferredAccountId,
    preferredAccountGroup: affinity ? undefined : route.preferredAccountGroup,
    boundAccountFallbackPolicy: affinity ? 'strict' : route.boundAccountFallbackPolicy,
    chain,
    transformerProvider,
    resolvedModel,
    isStream,
    resolveUrl: (config) => config.url instanceof URL
      ? config.url.toString()
      : typeof config.url === 'string'
        ? config.url
        : upstreamUrl,
    upstreamUrl,
    proxyProviderId: profile.authStrategy.providerId,
    providerIdentity: resolved.providerIdentity,
    callerClientHeaders: profile.authStrategy.providerId === 'codex'
      ? extractCodexClientHeaders(requestHeaders)
      : undefined,
    statefulContinuation: !!affinity,
    credential: affinityAccountId
      ? { kind: 'subscription-account', id: affinityAccountId }
      : { kind: 'subscription-account', id: 'pending-selection' },
  };
}

async function resolveGeminiProject(
  profile: RouteContext['subscriptionProfile'] & {},
  hints: {
    sessionKey?: string;
    preferredAccountId?: string;
    preferredAccountGroup?: string;
    boundAccountFallbackPolicy?: RouteContext['boundAccountFallbackPolicy'];
  },
): Promise<string | undefined> {
  const headers: Record<string, string> = {};
  await profile.authStrategy.applyHeaders(headers, hints);
  const accessToken = (headers.Authorization ?? headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return undefined;
  return getGeminiCodeAssistResolver()?.resolveProject(accessToken);
}

export async function executeResponsesUpstream(
  body: Record<string, unknown>,
  plan: ResponsesCallPlan,
  operation: ResponsesOperationKind,
  signal: AbortSignal,
): Promise<ResponsesPipelineResult> {
  const run = (): Promise<ResponsesPipelineResult> =>
    plan.profile === 'native'
      ? runNative(body, plan, operation, signal)
      : runReduced(body, plan, signal);
  let result = await run();
  throwIfResponsesAborted(signal);

  if (!plan.statefulContinuation) {
    if (plan.proxyProviderId === 'byo') {
      const outcome = await plan.auth.onResult?.(result.rawStatus);
      if (outcome?.rebound) {
        await result.response.body?.cancel().catch(() => undefined);
        throwIfResponsesAborted(signal);
        result = await run();
      }
    } else if (result.rawStatus === 401) {
      const refreshed = await plan.auth.onUnauthorized?.(plan.sessionKey);
      if (refreshed) {
        await result.response.body?.cancel().catch(() => undefined);
        throwIfResponsesAborted(signal);
        result = await run();
      }
    }
    result = await retryAroundCodexUsageLimit(body, plan, result, run, signal);
  }
  return result;
}

async function applyPlanAuth(
  body: Record<string, unknown>,
  plan: ResponsesCallPlan,
): Promise<{
  headers: Record<string, string>;
  accountId: string | undefined;
  actualModel: string;
}> {
  let accountId: string | undefined;
  let actualModel = plan.resolvedModel;
  const headers: Record<string, string> = {};
  await plan.auth.applyHeaders(headers, {
    upstreamUrl: plan.upstreamUrl,
    model: plan.resolvedModel,
    sessionKey: plan.sessionKey,
    preferredAccountId: plan.preferredAccountId,
    preferredAccountGroup: plan.preferredAccountGroup,
    boundAccountFallbackPolicy: plan.boundAccountFallbackPolicy,
    reportSelection: (selectedAccountId, _isActive, remappedModel) => {
      accountId = selectedAccountId;
      if (remappedModel) actualModel = remappedModel;
    },
  });
  body.model = actualModel;
  plan.transformerProvider.models = [actualModel];
  return { headers, accountId, actualModel };
}

function decorateCodexHeaders(
  headers: Record<string, string>,
  plan: ResponsesCallPlan,
): void {
  if (plan.proxyProviderId !== 'codex') return;
  fillMissingHeaders(headers, plan.callerClientHeaders ?? {});
  fillMissingHeaders(headers, DEFAULT_CODEX_CLI_HEADERS);
  fillMissingHeaders(headers, { accept: codexAcceptHeader(plan.isStream) });
}

async function runNative(
  body: Record<string, unknown>,
  plan: ResponsesCallPlan,
  operation: ResponsesOperationKind,
  signal: AbortSignal,
): Promise<ResponsesPipelineResult> {
  throwIfResponsesAborted(signal);
  const { headers, accountId, actualModel } = await applyPlanAuth(body, plan);
  fillMissingHeaders(headers, { 'content-type': 'application/json' });
  decorateCodexHeaders(headers, plan);
  const url = operation === 'compact' ? deriveResponsesCompactUrl(plan.upstreamUrl) : plan.upstreamUrl;
  let activityRecordId: string | undefined;
  const response = await fetchUpstream(
    url,
    { method: 'POST', headers, body: JSON.stringify(body), signal },
    {
      providerId: plan.proxyProviderId,
      accountId,
      routeActivity: plan.proxyProviderId === 'byo' ? undefined : {
        endpoint: 'responses',
        sessionKey: plan.sessionKey,
        sessionSource: plan.sessionSource ?? 'none',
        model: actualModel,
        onRecorded: (record) => { activityRecordId = record.id; },
      },
    },
  );
  return {
    response,
    rawStatus: response.status,
    accountId,
    actualModel,
    activityRecordId,
    credential: accountId
      ? { kind: 'subscription-account', id: accountId }
      : plan.resolveCredential?.() ?? plan.credential,
  };
}

async function runReduced(
  body: Record<string, unknown>,
  plan: ResponsesCallPlan,
  signal: AbortSignal,
): Promise<ResponsesPipelineResult> {
  throwIfResponsesAborted(signal);
  const { headers: authHeaders, accountId, actualModel } = await applyPlanAuth(body, plan);
  let rawStatus: number | null = null;
  let activityRecordId: string | undefined;
  const { response } = await executeProviderCall({
    executor: getSharedExecutor(),
    request: body,
    provider: plan.transformerProvider,
    chain: plan.chain,
    endpointTransformer: getResponsesEndpointTransformer(),
    resolveUrl: plan.resolveUrl,
    buildHeaders: (config) => {
      const headers = { ...authHeaders };
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers as Record<string, string | undefined>)) {
          if (value !== undefined && !(key in headers)) headers[key] = value;
        }
      }
      decorateCodexHeaders(headers, plan);
      return headers;
    },
    fetchFn: (url, headers, requestBody) => fetchUpstream(
      url,
      { method: 'POST', headers, body: JSON.stringify(requestBody), signal },
      {
        providerId: plan.proxyProviderId,
        accountId,
        routeActivity: plan.proxyProviderId === 'byo' ? undefined : {
          endpoint: 'responses',
          sessionKey: plan.sessionKey,
          sessionSource: plan.sessionSource ?? 'none',
          model: actualModel,
          onRecorded: (record) => { activityRecordId = record.id; },
        },
      },
    ).then((upstream) => {
      rawStatus = upstream.status;
      return upstream;
    }),
    runResponseChain: true,
    preserveEndpointRequestForResponseChain: true,
  });
  return {
    response,
    rawStatus,
    accountId,
    actualModel,
    activityRecordId,
    credential: accountId
      ? { kind: 'subscription-account', id: accountId }
      : plan.resolveCredential?.() ?? plan.credential,
  };
}

const MAX_QUOTA_RETRIES = 3;

interface ResponsesQuotaRetryResult {
  readonly response: Response;
  readonly rawStatus: number | null;
  readonly accountId: string | undefined;
}

/**
 * Retry a Codex subscription quota wall against another schedulable account.
 * Exported with an injectable attempt runner for the ingress compatibility
 * tests; production supplies the shared driver's current operation attempt.
 */
export async function retryAroundCodexUsageLimit<T extends ResponsesQuotaRetryResult>(
  body: Record<string, unknown>,
  plan: ResponsesCallPlan,
  first: T,
  runAttempt: (body: Record<string, unknown>, plan: ResponsesCallPlan) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (plan.proxyProviderId !== 'codex' || !first.accountId || first.rawStatus !== 429) return first;
  let current = first;
  for (let attempt = 0; attempt < MAX_QUOTA_RETRIES; attempt++) {
    if (signal) throwIfResponsesAborted(signal);
    const errorBody = await current.response.text().catch(() => '');
    markCodexUsageLimitExhaustion(current.accountId!, errorBody);
    const next = await runAttempt(body, plan);
    if (next.rawStatus !== 429 || !next.accountId) return next;
    current = next;
  }
  return current;
}
