/**
 * `@omnicross/daemon/embed` — use the provider / account / route-lease runtime
 * as an in-process library.
 *
 * ```ts
 * import { createEmbeddedHost } from '@omnicross/daemon/embed';
 *
 * const host = createEmbeddedHost({ dataDir: '/path/to/providers' });
 * await host.start();
 * const lease = await host.leases.create(
 *   { runtime: 'endpoint', wire: 'anthropic-messages', upstream: { kind: 'provider', providerId: 'p1' }, model: 'm1' },
 *   'run-42',
 * );
 * // lease.endpoint = { baseUrl, token, wire } — hand it to an SDK.
 * await host.stop();
 * ```
 *
 * The entry starts no gateway or admin listener, writes only under `dataDir`,
 * ignores `OMNICROSS_MASTER_KEY` unless asked, and loads no native image or
 * HTML-parsing modules at import or start. ESM only; one host per process.
 *
 * Stability: this module's exports are public API. During 0.x, breaking
 * changes to them are listed in the CHANGELOG under "Breaking (embed API)".
 *
 * @module @omnicross/daemon/embed
 */

export { createEmbeddedHost, type EmbeddedHost } from './EmbeddedHost';
export {
  type ClaudeLaunchIdentity,
  type CodexLaunchIdentity,
  createRouteLeaseDescriptors,
  type RouteLeaseDescriptorOptions,
} from './descriptors';
export { HostError, type HostErrorCode } from './errors';
export type {
  AccountBatchRequest,
  AccountList,
  AccountMetadataPatch,
  AccountView,
  DiscoveredModels,
  EmbeddedHostOptions,
  HostChangeEvent,
  HostChangeListener,
  HostHealth,
  Lease,
  LeaseCapabilities,
  LeaseRequest,
  LoopbackCodeListener,
  OAuthFlowKind,
  OAuthSession,
  OAuthStatus,
  PoolKeyView,
  ProviderTestResult,
  ProviderView,
  RouteLeaseEndpoint,
  RouteLeaseErrorCode,
  RouteLeaseRuntime,
  RouteLeaseUpstream,
  RouteLeaseWire,
  RuntimeLaunchDescriptor,
  SubscriptionAccountSanitized,
  SubscriptionProviderId,
  UpstreamView,
} from './types';
