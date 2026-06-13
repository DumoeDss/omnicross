/**
 * Outbound API server module — barrel + singleton accessor.
 *
 * The outbound server is constructed ONCE at app bootstrap (sharing the
 * resident `ProviderProxy`'s route map + deps) and started only when the
 * persisted `enabled` setting is true. `getOutboundApiServer(deps)` mirrors
 * `getProviderProxy()`: the first call constructs the instance from the supplied
 * deps; later calls return it.
 *
 * @module outbound-api/index
 */

import { OutboundApiServer } from './OutboundApiServer';
import type { OutboundApiDeps } from './types';

let instance: OutboundApiServer | null = null;

/**
 * Get (or lazily construct) the outbound API server singleton.
 *
 * @param deps Required on the FIRST call (app bootstrap). Ignored afterward.
 * @param onPortChange Optional persistence hook for the EADDRINUSE fallback.
 */
export function getOutboundApiServer(
  deps?: OutboundApiDeps,
  onPortChange?: (port: number) => void,
): OutboundApiServer {
  if (!instance) {
    if (!deps) {
      throw new Error('getOutboundApiServer: deps are required on first construction');
    }
    instance = new OutboundApiServer(deps, onPortChange);
  }
  return instance;
}

/** Reset the singleton (tests / teardown only). */
export function __resetOutboundApiServerForTests(): void {
  instance = null;
}

export {
  type ApiServerSettingsStore,
  defaultServerConfig,
  loadServerConfig,
  mergeServerConfig,
  normalizeServerConfig,
  OUTBOUND_API_SERVER_CONFIG_KEY,
  saveServerConfig,
} from './apiServerConfig';
export { createNamedKey, hashKey, verifyPresentedKey } from './outboundApiKeyAuth';
export type {
  ApplyConfigInput,
} from './OutboundApiServer';
export { DEFAULT_OUTBOUND_PORT, formatUrls,OutboundApiServer } from './OutboundApiServer';
export { OutboundRateLimiter } from './outboundRateLimiter';
export { detectRequestRole, endpointToIngressFormat } from './roleDetection';
export { isSubscriptionProviderId, resolveRoute } from './routeResolver';
export {
  endpointSupportsSubscription,
  SUBSCRIPTION_PROVIDER_IDS,
} from './subscriptionSupport';
export type {
  EndpointRoutingConfig,
  OutboundApiDeps,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundEndpoint,
  OutboundFormatUrls,
  OutboundKeyDb,
  OutboundKeyDbRow,
  RequestRole,
} from './types';
