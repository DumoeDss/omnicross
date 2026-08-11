import type { ProviderConfigSource } from '../ports/provider-config-source';
import { gatewayBindingToEndpointConfig } from '../outbound-api/gatewayBindingResolver';
import { resolveRoute } from '../outbound-api/routeResolver';
import { getSubscriptionRegistryForOutbound } from '../outbound-api/subscriptionRegistryPort';
import type { GatewayBinding } from '../outbound-api/types';
import { resolveProviderChain } from '../pipeline/resolveProviderChain';
import {
  RouteLeaseError,
  routeLeaseRuntime,
  type NormalizedRouteLeaseRequest,
  type RouteLeaseTargetResolverPort,
  type RouteLeaseUpstream,
} from './routeLeaseSchema';
import type { RouteContext } from './types';

export interface RouteLeaseProviderKeyPreflight {
  hasUsableKey(providerId: string, keyId: string): Promise<boolean>;
  hasUsableKeys(providerId: string): Promise<boolean>;
  getKeyAvailability?(
    providerId: string,
    keyId: string,
  ): Promise<'usable' | 'unavailable' | 'not-found'>;
  getPoolAvailability?(
    providerId: string,
  ): Promise<
    | { readonly outcome: 'usable' }
    | { readonly outcome: 'empty' | 'unavailable' }
    | { readonly outcome: 'exhausted'; readonly retryAfterSeconds: number }
  >;
}

export interface RouteLeaseSubscriptionPreflight {
  assertAvailable(upstream: Exclude<RouteLeaseUpstream, { kind: 'provider' }>, model: string): Promise<void>;
}

export interface RouteLeaseTargetResolverOptions {
  readonly providerKeys?: RouteLeaseProviderKeyPreflight;
  readonly subscriptions?: RouteLeaseSubscriptionPreflight;
}

function resolveEnvKey(raw: string | undefined): string {
  if (!raw) return '';
  return raw.startsWith('$') ? (process.env[raw.slice(1)] ?? '') : raw;
}

function providerSupportsModel(provider: { models?: string[]; modelConfigs?: Array<{ id: string; enabled?: boolean }> }, model: string): boolean {
  const flat = provider.models ?? [];
  const configured = provider.modelConfigs ?? [];
  if (flat.length === 0 && configured.length === 0) return false;
  return flat.includes(model) || configured.some((entry) => entry.id === model && entry.enabled !== false);
}

function syntheticBinding(request: NormalizedRouteLeaseRequest): GatewayBinding {
  const runtime = routeLeaseRuntime(request.runtime);
  return {
    id: 'route-lease-ephemeral',
    name: 'Route Lease ephemeral target',
    enabled: true,
    endpoint: runtime.endpoint,
    target: request.upstream,
    fallback: 'fail',
    modelMode: 'passthrough',
  };
}

function transformerRegistered(llmConfig: ProviderConfigSource, name: string): boolean {
  return Boolean(llmConfig.getTransformerService()?.getTransformer(name));
}

/**
 * Reuses the outbound GatewayBinding projection and route resolver with a
 * non-persistent, strict binding. Host-only credential/account checks arrive
 * through narrow secret-free preflight ports.
 */
export class RouteLeaseTargetResolver implements RouteLeaseTargetResolverPort {
  constructor(
    private readonly llmConfig: ProviderConfigSource,
    private readonly options: RouteLeaseTargetResolverOptions = {},
  ) {}

  async resolve(request: NormalizedRouteLeaseRequest): Promise<RouteContext> {
    const runtime = routeLeaseRuntime(request.runtime);
    await this.preflightTarget(request);
    const binding = syntheticBinding(request);
    const config = gatewayBindingToEndpointConfig(binding, request.model);
    const result = await resolveRoute({
      config,
      ingressFormat: runtime.ingressFormat,
      llmConfig: this.llmConfig,
      requestedModel: request.model,
      sessionId: request.execution?.sessionIdHash ?? null,
    });
    if (!result.ok) {
      throw new RouteLeaseError(
        result.error.status === 404 ? 'upstream_not_found' : 'upstream_unavailable',
        'the selected upstream could not be resolved',
      );
    }
    // A lease freezes the actual upstream model; the client body cannot retain
    // authority through the outbound response-passthrough hint.
    return { ...result.route, requestedModel: undefined };
  }

  private async preflightTarget(request: NormalizedRouteLeaseRequest): Promise<void> {
    const target = request.upstream;
    if (target.kind !== 'provider') {
      await this.preflightSubscription(target, request.model);
      return;
    }
    const provider = await this.llmConfig.getProvider(target.providerId);
    if (!provider) throw new RouteLeaseError('upstream_not_found', 'provider was not found');
    if (provider.enabled === false) throw new RouteLeaseError('upstream_unavailable', 'provider is disabled');
    if (!providerSupportsModel(provider, request.model)) {
      throw new RouteLeaseError('model_not_configured', 'model is not configured for the provider');
    }

    if (target.keyId) {
      const availability = await this.options.providerKeys?.getKeyAvailability?.(
        target.providerId,
        target.keyId,
      );
      if (availability === 'not-found') {
        throw new RouteLeaseError('upstream_not_found', 'the selected provider key was not found');
      }
      const usable = availability === 'usable' || (
        availability === undefined &&
        Boolean(this.options.providerKeys) &&
        await this.options.providerKeys!.hasUsableKey(target.providerId, target.keyId)
      );
      if (!usable) {
        throw new RouteLeaseError('upstream_unavailable', 'the selected provider key is unavailable');
      }
    } else {
      const directKey = resolveEnvKey(provider.api_key);
      const poolAvailability = await this.options.providerKeys?.getPoolAvailability?.(target.providerId);
      const poolReady = poolAvailability
        ? poolAvailability.outcome === 'usable'
        : this.options.providerKeys
          ? await this.options.providerKeys.hasUsableKeys(target.providerId)
          : false;
      if (!directKey && poolAvailability?.outcome === 'exhausted') {
        throw new RouteLeaseError('upstream_exhausted', 'provider key pool is temporarily exhausted', {
          retryAfterSeconds: poolAvailability.retryAfterSeconds,
        });
      }
      if (!directKey && !poolReady) {
        throw new RouteLeaseError('upstream_unavailable', 'provider has no usable credential');
      }
    }

    const sameFormat =
      (request.runtime === 'claude' && provider.apiFormat === 'anthropic') ||
      (request.runtime === 'codex' && provider.apiFormat === 'openai-response');
    if (!sameFormat) {
      try {
        const chain = await resolveProviderChain(this.llmConfig, provider.id, request.model);
        if (!chain.hasTransformers) {
          throw new RouteLeaseError('format_unsupported', 'no transformer chain supports this runtime and upstream');
        }
      } catch (error) {
        if (error instanceof RouteLeaseError) throw error;
        throw new RouteLeaseError('format_unsupported', 'the transformer chain could not be resolved', { cause: error });
      }
    }
  }

  private async preflightSubscription(
    target: Exclude<RouteLeaseUpstream, { kind: 'provider' }>,
    model: string,
  ): Promise<void> {
    const registry = getSubscriptionRegistryForOutbound();
    const profile = registry?.getProfile(target.providerId) ?? null;
    if (!profile) throw new RouteLeaseError('upstream_not_found', 'subscription provider was not found');
    await this.options.subscriptions?.assertAvailable(target, model);
    const names = profile.resolveProviderTransformerNames?.(model) ?? profile.providerTransformerNames ?? [];
    if (names.some((name) => !transformerRegistered(this.llmConfig, name))) {
      throw new RouteLeaseError('format_unsupported', 'a required transformer is unavailable');
    }
    if (profile.modelTransformerNames?.some((name) => !transformerRegistered(this.llmConfig, name))) {
      throw new RouteLeaseError('format_unsupported', 'a required model transformer is unavailable');
    }
  }
}
