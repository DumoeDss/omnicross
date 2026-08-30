/**
 * @omnicross/daemon — the standalone daemon that boots `@omnicross/core`'s
 * ProviderProxy + outbound API server with file-backed default port impls.
 *
 * Public barrel: bootstrap + the four port implementations + config loader +
 * the CCR importer. Internal package (`private:true`); the standalone-binary
 * build + public release are deferred.
 *
 * @module @omnicross/daemon
 */

// ── Bootstrap ─────────────────────────────────────────────────────────────────
export {
  buildDaemon,
  type Daemon,
  type DaemonPaths,
  resetDaemonSingletonsForTests,
} from './bootstrap';

// ── Config ────────────────────────────────────────────────────────────────────
export {
  type DaemonAdminConfig,
  type DaemonApiFormat,
  type DaemonConfig,
  type DaemonProviderConfig,
  DEFAULT_ADMIN_PORT,
  loadConfig,
  resolveAdminConfig,
  type ResolvedAdminConfig,
  saveConfig,
  validateConfig,
} from './config';

// ── Admin dashboard (RT3) ───────────────────────────────────────────────────────
export { type AdminApiDeps, handleAdminApi } from './admin/adminApi';
export { AdminServer, type AdminServerDeps, type AdminServerStatus } from './admin/AdminServer';

// ── Default port implementations ───────────────────────────────────────────────
export { buildHealthReport, type HealthReportDeps } from './admin/health';
export { ConfigFileProviderConfigSource } from './ports/ConfigFileProviderConfigSource';
export { ConfigurableLogger } from './ports/ConfigurableLogger';
export { ConsoleLogger } from './ports/ConsoleLogger';
export { JsonApiServerSettingsStore } from './ports/JsonApiServerSettingsStore';
export { JsonOutboundKeyDb } from './ports/JsonOutboundKeyDb';
export { JsonSubscriptionCredentialStore } from './ports/JsonSubscriptionCredentialStore';

// ── Production Images runtime ─────────────────────────────────────────────────
export {
  createTrustedImageApiRuntimeResolver,
  type TrustedImageApiRuntimeResolver,
  type TrustedImageApiRuntimeResolverOptions,
} from './image-generation/ImageApiRuntimeResolver';
export {
  createImageRuntimeGeneration,
  type ImageRuntimeGenerationFactoryOptions,
  type ImageRuntimeGenerationSharedStorage,
  type ImageRuntimeMetadataObservability,
  type ProductionImageRuntimeComponents,
  type ProductionImageRuntimeGeneration,
} from './image-generation/ImageRuntimeGenerationFactory';
export {
  ImageObservability,
  type ImageApiMetricDimensions,
  type ImageApiMetricSnapshot,
  type ImageExecutionMetricDimensions,
  type ImageExecutionMetricSnapshot,
  type ImageHistogramSnapshot,
  type ImageObservabilityOptions,
  type ImageObservabilitySnapshot,
} from './image-generation/ImageObservability';
export {
  createHostedImageContributionFactory,
  type HostedImageContributionFactory,
  ImageRuntimeManager,
  type HostedImageRuntimeGenerationLease,
  type ImageRuntimeCapabilityInspection,
  type ImageRuntimeManagerStatus,
  type ImageRuntimeResourceStatus,
  type ImageRuntimeSafeUnavailableReason,
  type PreparedImageRuntimeChange,
  type PreparedImageRuntimeGeneration,
} from './image-generation/ImageRuntimeManager';

// ── CCR importer ────────────────────────────────────────────────────────────────
export {
  type CcrConfig,
  type CcrProvider,
  type CcrRouter,
  inferApiFormat,
  mapCcrToOmnicross,
  parseCcrConfig,
} from './ccr-import';
