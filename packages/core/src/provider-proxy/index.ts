/**
 * ProviderProxy module — singleton accessor + re-exports.
 *
 * The resident `ProviderProxy` is started ONCE for the app session (task 2.1).
 * This module provides the module-singleton accessor mirroring
 * `getProcessSupervisor()`: the first call constructs the instance from the
 * supplied deps; subsequent calls return it. Because the deps (llmConfig /
 * apiKeyPool / usageRecorder) are only known at app bootstrap, the accessor
 * takes them on first construction and ignores them afterward.
 *
 * @module provider-proxy/index
 */

import { ProviderProxy } from './ProviderProxy';
import type { ProviderProxyDeps } from './types';

let instance: ProviderProxy | null = null;

/**
 * Get (or lazily construct) the resident `ProviderProxy` singleton.
 *
 * @param deps Required on the FIRST call (app bootstrap) to construct the
 *   instance. Ignored on later calls. Throws if omitted before construction.
 */
export function getProviderProxy(deps?: ProviderProxyDeps): ProviderProxy {
  if (!instance) {
    if (!deps) {
      throw new Error('getProviderProxy: deps are required on first construction');
    }
    instance = new ProviderProxy(deps);
  }
  return instance;
}

/** Reset the singleton (tests / teardown only). */
export function __resetProviderProxyForTests(): void {
  instance = null;
}

export { ProviderProxy } from './ProviderProxy';
export {
  DEFAULT_ROUTE_IDLE_MS,
  ProviderProxyRouteMap,
} from './providerProxyRouteMap';
export { extractRouteToken } from './providerProxyRouter';
export type {
  AnthropicIngressHandler,
  AnthropicIngressHandlerFactory,
  AnthropicRouteHandlerParams,
  AnthropicSdkHints,
  ExtendedContextHint,
  IngressFormat,
  ProviderProxyDeps,
  ProxyAttribution,
  RetryCallback,
  RouteAuthMode,
  RouteContext,
  StreamEventCallback,
  SubscriptionDispatchProfile,
  SubscriptionRequestSummary,
  TargetProviderFormat,
} from './types';
