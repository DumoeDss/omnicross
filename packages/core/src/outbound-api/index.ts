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
  DEFAULT_ACCOUNT_PROBE,
  DEFAULT_CONCURRENCY_QUEUE,
  DEFAULT_USER_MESSAGE_QUEUE,
  defaultServerConfig,
  loadServerConfig,
  mergeServerConfig,
  normalizeAccountProbe,
  normalizeAudit,
  normalizeBilling,
  normalizePrefixTargets,
  normalizeProxyConfig,
  normalizeProxySegment,
  normalizeQueueSegments,
  normalizeServerConfig,
  normalizeWebhookDestination,
  normalizeWebhookSegment,
  OUTBOUND_API_SERVER_CONFIG_KEY,
  saveServerConfig,
} from './apiServerConfig';
export {
  AUDIT_REDACTED,
  redactAuditText,
} from './auditRedact';
export {
  type AuditCaptureContext,
  beginAuditCapture,
} from './auditCapture';
export {
  type BillingCaptureContext,
  beginBillingCapture,
} from './billingCapture';
export {
  classifyModelPrefix,
  type ModelPrefixKind,
  resolvePrefixTarget,
} from './modelPrefixDispatch';
export {
  ConcurrencyQueueFullError,
  ConcurrencyWaitCancelledError,
  ConcurrencyWaitTimeoutError,
  type GateAcquireOptions,
  type GateAcquisition,
  type GateSlot,
  type GateStatusEntry,
  isConcurrencyRejection,
  OutboundConcurrencyGate,
} from './outboundConcurrencyGate';
export {
  isUserMessageRequest,
} from './userMessageDetection';
export {
  isSerialQueueTimeout,
  type SerialAcquireOptions,
  type SerialQueueStatusEntry,
  SerialQueueTimeoutError,
  type SerialSlot,
  UserMessageSerialQueue,
} from './userMessageSerialQueue';
export {
  detectModelKind,
  type EndpointModelConfigError,
  isKindMappedEndpoint,
  modelKindsForEndpoint,
  validateEndpointModelConfig,
  validateServerModelConfig,
} from './kindDetection';
export {
  createNamedKey,
  hashKey,
  type KeyVerification,
  verifyKey,
  verifyPresentedKey,
  type VerifiedKey,
} from './outboundApiKeyAuth';
export {
  checkKeyQuota,
  computeKeyExpiry,
  type KeyCostLimits,
  type KeyExpiryInput,
  type KeyExpiryResult,
  type KeySpend,
  type QuotaDecision,
} from './keyPolicy';
export {
  KeySpendTracker,
  type KeySpendReader,
  type KeySpendSeeder,
  startOfLocalDay,
  startOfLocalWeek,
} from './keySpendTracker';
export type {
  ApplyConfigInput,
} from './OutboundApiServer';
export {
  DEFAULT_OUTBOUND_PORT,
  formatUrls,
  OutboundApiConfigError,
  OutboundApiServer,
} from './OutboundApiServer';
export { OutboundRateLimiter } from './outboundRateLimiter';
export { detectRequestRole, endpointToIngressFormat } from './roleDetection';
export { isSubscriptionProviderId, parseModelRef, pickModelRefFromList, resolveRoute } from './routeResolver';
export {
  endpointSupportsSubscription,
  SUBSCRIPTION_PROVIDER_IDS,
} from './subscriptionSupport';
export { ENDPOINT_MODEL_KINDS } from './types';
export type {
  AccountProbeConfig,
  ChatDispatchMode,
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  KindMappedEndpoint,
  MessagesModelKind,
  ModelKind,
  ModelPrefixTargets,
  OutboundApiDeps,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundEndpoint,
  OutboundFormatUrls,
  OutboundKeyActivationMode,
  OutboundKeyDb,
  OutboundKeyDbRow,
  OutboundKeyPolicy,
  OutboundProxyConfig,
  RequestRole,
  ResponsesModelKind,
  UserMessageQueueConfig,
} from './types';
