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
export { ConfigFileProviderConfigSource } from './ports/ConfigFileProviderConfigSource';
export { ConsoleLogger } from './ports/ConsoleLogger';
export { JsonApiServerSettingsStore } from './ports/JsonApiServerSettingsStore';
export { JsonOutboundKeyDb } from './ports/JsonOutboundKeyDb';
export { JsonSubscriptionCredentialStore } from './ports/JsonSubscriptionCredentialStore';

// ── CCR importer ────────────────────────────────────────────────────────────────
export {
  type CcrConfig,
  type CcrProvider,
  type CcrRouter,
  inferApiFormat,
  mapCcrToOmnicross,
  parseCcrConfig,
} from './ccr-import';
