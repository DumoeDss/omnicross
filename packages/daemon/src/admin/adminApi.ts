/**
 * adminApi — the daemon admin dashboard's management API router (`/admin/api/*`,
 * JSON) (RT3, design D3/D4/D5).
 *
 * A small method+path router over the LIVE daemon handles + exported core fns.
 * Resources: providers (CRUD + hot-reload), keys (CRUD + one-time plaintext),
 * server config (live apply), accounts (read-only status), status, playground
 * (same-origin proxy to `/v1/*`).
 *
 * SECRET SPINE (design D4 — the load-bearing invariant): secrets flow IN
 * (POST/PUT) and NEVER OUT (GET). The provider mask (`maskProviderApiKey`) and
 * the key DTO map (`toKeyInfo`) are the single places the masking is applied so
 * the invariant lives in one spot.
 *
 * @module @omnicross/daemon/admin/adminApi
 */

import http from 'node:http';
import { resolve } from 'node:path';
import { KeyViewingError, KeyViewingPassword } from '../secrets/KeyViewingPassword';
import { clearConfigCredentials } from '../secrets/clearConfigCredentials';

import {
  createNamedKey,
  DEFAULT_IMAGES_SERVER_CONFIG,
  DEFAULT_SEARCH_SERVER_CONFIG,
  effectivePermissionsForRow,
  gatewayBindingToEndpointConfig,
  isKindMappedEndpoint,
  loadServerConfig,
  mergeServerConfig,
  normalizeProxyConfig,
  type GatewayBindingTarget,
  type KeyUpstreamBinding,
  type OutboundApiKeyInfo,
  type OutboundApiServer,
  type OutboundApiServerConfig,
  type ImagesServerConfig,
  type KeySpendReader,
  type OutboundKeyDb,
  type OutboundKeyDbRow,
  saveServerConfig,
  validateSearchServerConfig,
  type VoucherDb,
} from '@omnicross/core/outbound-api';
import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import {
  IMAGE_CAPABILITY_UNAVAILABLE_REASONS,
  type ImageCapabilities,
} from '@omnicross/contracts/image-generation-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { getSharedAccountAllowanceScheduling } from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';
import { getOpenCodeGoUserAgent } from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';
import { mergeExtraHeaders } from '@omnicross/core';
import type { PricingEngine, UsageRecorder } from '@omnicross/core/usage';
import type { RouteLeaseManager } from '@omnicross/core/provider-proxy';
import type { FetchLike } from '@omnicross/subscriptions';
import type { AccountProbeHistoryReader } from '../AccountHealthProbeScheduler';
import { applyAdminProbeIdentity } from './testEgressIdentity';
import type { ClaudeAllowanceRefreshScheduler } from '../allowance/ClaudeAllowanceRefreshScheduler';
import type { ProviderKeyQuota } from '../allowance/ProviderKeyQuotaService';
import type { ImageDoctorLiveResult } from '../image-generation/ImageDoctorService';
import { validateImagesAdminConfig } from '../image-generation/imagesConfigValidation';
import type {
  ImageRuntimeCapabilityInspection,
  ImageRuntimeManagerStatus,
  ImageRuntimeResourceStatus,
} from '../image-generation/ImageRuntimeManager';
import type {
  ImageConfigurationAuditField,
  ImageConfigurationAuditRecord,
} from '../image-generation/ImageObservability';
import {
  applyServerConfigTransaction,
  type PreparedServerConfigChange,
  ServerConfigTransactionError,
} from './serverConfigTransaction';
import {
  CHATGPT_WEB_BRIDGE_MODELS,
  CHATGPT_WEB_PROVIDER_ID,
  handleChatGptWeb,
} from './chatgptWebApi';

import {
  type DaemonApiKeyEntry,
  type DaemonApiMode,
  type DaemonCodingPlanConfig,
  type DaemonConfig,
  type DaemonModelConfig,
  type DaemonProviderConfig,
  type DaemonTransformerConfig,
  type DaemonTransformerEntry,
  loadConfig,
  migrateFormatAxis,
  saveConfig,
  saveConfigAtomically,
  validateExtraHeaders,
  validateFormatVariants,
  validateThinkingLevels,
  validateThinkingTokenLimit,
  validateTransformerEntry,
} from '../config';
import type { AutoDisableStore } from '../pool/autoDisableStore';
import { resolveEnvKey } from '../pool/resolveEnvKey';
import type { ConfigFileProviderConfigSource } from '../ports/ConfigFileProviderConfigSource';
import type { JsonApiServerSettingsStore } from '../ports/JsonApiServerSettingsStore';
import type { JsonPricingStore } from '../ports/JsonPricingStore';
import {
  IntegrationConflictError,
  ONBOARDING_ACCESS_KEY_NAME,
  type CodexAuthHelperConfig,
  type IntegrationManager,
  type IntegrationClientId,
} from '../integrations';
import { listMappablePresets } from '../preset-map';
import { parseLogJevSettings } from '@omnicross/contracts/logjev';
import { preserveOutboundProxySecrets, redactOutboundProxy } from '../proxy/sanitizeProxy';
import {
  assembledGatewayBindings,
  defaultProviderMappingTarget,
  listUpstreamCatalog,
  migrateLegacyUpstreamRouting,
  rollbackLegacyUpstreamRouting,
  resolveUpstreamModelMappings,
  sanitizeUpstreamMappingRows,
  upstreamMappingKeyOf,
  validateUpstreamMappingTable,
} from './upstreamRoutingAdmin';
import { setServerProxyConfig } from '../proxy/upstreamProxyResolver';
import {
  addProviderKey,
  createProvider,
  deleteProvider,
  deleteProviderKey,
  discoverProviderModels,
  expandRowExtraHeaders,
  listPresets,
  listProviderKeys,
  listProviders,
  persistProviders as persistProviderCatalog,
  type PoolHealthReader,
  type PoolKeyHealth,
  type ProviderAdminDeps,
  type ProviderKeyQuotaReader,
  provisionNewProvider as provisionProviderOnCreate,
  refreshProviderKeyQuota,
  reorderProviders,
  revealProviderKey,
  setProviderKeyEnabled,
  testProviderModel,
  updateProvider,
  updateProviderKey,
} from '../service/providerAdmin';
import type { ServiceResult } from '../service/result';
import {
  type AccountAdminDeps,
  accountDiagnostics,
  accountEvents,
  addManualAccount,
  batchAccounts,
  clearProviderAccounts,
  importExternalAccount,
  listAccounts,
  patchAccount,
  refreshAccount,
  removeAccount,
  renameAccount,
  setAccountPriority,
  setAccountProxy,
  setAccountSupportedModels,
  setActiveAccount,
  testAccount,
  writeProviderTokens,
} from '../service/accountAdmin';
import {
  cancelOAuth,
  completeOAuth,
  isPolledOAuthProvider,
  oauthStatus,
  startOAuth,
} from '../service/oauthAdmin';

// The provider parsing / masking / discovery helpers moved to the service layer
// (`service/providerAdmin`); re-exported so existing importers keep working.
export {
  anthropicModelDiscoveryUrls,
  chatCompletionsUrlForRow,
  maskProviderApiKey,
  mergeProviderModels,
  openAiWireModelDiscoveryUrls,
  parseProviderInput,
  scopeDiscoveredIdsToJev,
} from '../service/providerAdmin';
import { chatCompletionsUrlForRow, parseProviderInput } from '../service/providerAdmin';

import {
  type CodexLoopbackFn,
  CodexOAuthSessionStore,
  handleCodexOAuthCancel,
  handleCodexOAuthStart,
  handleCodexOAuthStatus,
} from './accountsCodexOAuth';
import {
  handleKimiOAuthCancel,
  handleKimiOAuthStart,
  handleKimiOAuthStatus,
  KimiOAuthSessionStore,
} from './accountsKimiOAuth';
import {
  handleGrokOAuthCancel,
  handleGrokOAuthStart,
  handleGrokOAuthStatus,
  GrokOAuthSessionStore,
} from './accountsGrokOAuth';
import {
  AntigravityLoopbackFn,
  AntigravityOAuthSessionStore,
  handleAntigravityOAuthCancel,
  handleAntigravityOAuthStart,
  handleAntigravityOAuthStatus,
} from './accountsAntigravityOAuth';
import { handleAntigravityModelsRoute } from '../allowance/AntigravityModelDiscovery';
import {
  handleOpenCodeGoModelsRoute,
  type OpenCodeGoModelsAccount,
} from '../allowance/OpenCodeGoModelDiscovery';
import { openCodeGoChatBase } from '../jevSystemone';
import {
  handleCopilotOAuthCancel,
  handleCopilotOAuthStart,
  handleCopilotOAuthStatus,
  CopilotOAuthSessionStore,
} from './accountsCopilotOAuth';
import {
  handleOAuthComplete,
  handleOAuthStart,
  type SubscriptionAccountAppender,
} from './accountsOAuth';
import {
  asSubscriptionProviderId,
  statusEntryFor,
  type SubscriptionTokenWriter,
  validateAccountBatchBody,
  validateAccountMetadataPatch,
  validateSupportedModelsBody,
  validateTokenBody,
} from './accountsWrite';
import {
  type CommandRunner,
  handleCliInstall,
  handleCliLaunch,
  handleCliList,
  handleCliSessions,
  handleCliStop,
  handleCliUpgrade,
  handleCliVersions,
  isLaunchCliId,
  isTrackedCliId,
  type PathProbe,
  type TerminalOpener,
  type VersionRunner,
} from './cliLaunch';
import { buildLogExportBundle } from './logsExport';
import { validateAuditSegment } from './auditConfigBody';
import {
  preserveBillingSecret,
  redactBillingConfig,
  validateBillingSegment,
} from './billingConfigBody';
import { handleDashboard } from './dashboard';
import { handleSearchAdmin, type SearchAdminRuntimeStatus } from './searchAdminApi';
import { preserveSearchSecrets, redactSearchServerConfig } from './searchAdminView';
import { parseKeyPolicyBody } from './keyPolicyBody';
import { validateGatewayBindingsSegment } from './gatewayBindingBody';
import { handleVoucher } from './voucherAdmin';
import {
  preserveWebhookSecrets,
  redactWebhookConfig,
  validateWebhookSegment,
} from './webhookConfigBody';
import { applyAuditConfig } from '../audit/auditRuntime';
import { applyBillingConfig } from '../billing/billingRuntime';
import { applyWebhookConfig } from '../webhook/webhookRuntime';
import { handleExport, handleImport, type MigrationDeps } from './adminMigration';
import type { MigrationCredentialStore } from '../migration/migration';
import type { OAuthSessionStore } from './oauthSessions';
import {
  handlePricingDelete,
  handlePricingFetchLatest,
  handlePricingList,
  handlePricingResolveConflicts,
  handlePricingUpsert,
  handleUsageGet,
  type UsagePricingResult,
} from './usagePricing';
import {
  type AccountAllowanceAdminReader,
  handleAccountAllowanceApi,
} from './accountAllowanceApi';
import {
  ACCOUNT_ROUTE_ACTIVITY_LIMIT,
  getSharedAccountRouteActivity,
} from '@omnicross/core/pipeline/AccountRouteActivity';
import { getSharedOverloadCounter } from '@omnicross/core/pipeline/ServerOverloadCounter';

/** Token-free subscription account list entry (passthrough from core's service). */
export interface AdminAccountsLister {
  listAll(): Promise<unknown[]>;
}

// Pool-health / quota reader shapes live in the provider service layer; they
// stay re-exported here for existing importers.
export type { PoolHealthReader, PoolKeyHealth, ProviderKeyQuotaReader };

export interface AdminImagesStatusReader {
  inspectCapability(apiKeyId: string): Promise<ImageRuntimeCapabilityInspection>;
  status(): ImageRuntimeManagerStatus;
  resourceStatus(): ImageRuntimeResourceStatus | undefined;
}

/** The live daemon handles the management API operates over. */
export interface AdminApiDeps {
  /** Destructive recovery: clear subscription credentials and revoke/erase stored client keys. */
  readonly clearStoredCredentials?: () => Promise<void>;
  /** Path to the daemon's `config.json` (provider catalog + `server` field). */
  readonly configPath: string;
  /**
   * The daemon's RESOLVED log file path (the `ConfigurableLogger` file sink —
   * `<configDir>/logs/daemon.log` by default). Powers
   * `GET /admin/api/logs/export` (the bug-report log bundle); absent on light
   * embedders ⇒ the endpoint answers 501.
   */
  readonly logFile?: string;
  /** Request-audit store dir — powers the log-export bundle's audit summary (P1). */
  readonly auditDir?: string;
  /** Live provider catalog (hot-reload target). */
  readonly llmConfig: ConfigFileProviderConfigSource;
  /** Named outbound-key store. */
  readonly keyDb: OutboundKeyDb;
  /**
   * OPTIONAL voucher (redemption-card) store (voucher-redemption #9). When wired,
   * the `/admin/api/voucher` surface can generate/list/revoke cards. Absent ⇒ the
   * surface returns 501 (feature not available in this build).
   */
  readonly voucherDb?: VoucherDb;
  /**
   * OPTIONAL per-key spend reader (outbound-key-policy). When wired, the key list
   * surfaces each key's OWN accumulated spend (daily/weekly/total) so the admin
   * can see spend-vs-limit. Leak-safe: only the key's own numbers are exposed.
   */
  readonly keySpendReader?: KeySpendReader;
  /** Outbound server settings store (server config persistence). */
  readonly settingsStore: JsonApiServerSettingsStore;
  /** The running outbound server (status + live applyConfig). */
  readonly outboundApiServer: OutboundApiServer;
  /** True only when production composed the hardened per-hop remote resolver. */
  readonly imageRemoteResolverAvailable?: boolean;
  /** Optional production Images runtime generation participant. */
  readonly imageRuntimeConfig?: {
    prepareConfig(config: ImagesServerConfig): Promise<PreparedServerConfigChange>;
  };
  /** Narrow metadata-only reader for authenticated Images capability/status. */
  readonly imageRuntimeStatus?: AdminImagesStatusReader;
  /**
   * Explicitly-consuming live image verification (images-settings-tab D3) —
   * delegates to the doctor service's `verifyLive` (Codex wire only). Absent
   * on light embedders; the endpoint then responds 501 and consumes nothing.
   */
  readonly imageLiveVerifier?: {
    verifyLive(config: ImagesServerConfig, signal: AbortSignal): Promise<ImageDoctorLiveResult>;
  };
  /** Metadata-only successful Images configuration audit sink. */
  readonly imageConfigAudit?: (record: ImageConfigurationAuditRecord) => void;
  /** Process-local machine-managed routing leases (optional for light embedders). */
  readonly routeLeaseManager?: RouteLeaseManager;
  /** Subscription accounts (token-free `listAll`). */
  readonly subscriptionAccounts: AdminAccountsLister;
  /**
   * Secret-free upstream allowance facade. Optional for lightweight embedders;
   * the standalone daemon wires it and the route returns 501 when absent.
   */
  readonly accountAllowanceService?: AccountAllowanceAdminReader;
  /** Live Claude cache worker; hot-reconfigured with allowance scheduling. */
  readonly allowanceRefreshScheduler?: Pick<ClaudeAllowanceRefreshScheduler, 'configure'>;
  /** Optional secret-free account connection probe + rolling history surface. */
  readonly accountProbeService?: AccountProbeHistoryReader & {
    probeAccount(
      providerId: import('@omnicross/contracts/subscription-types').SubscriptionProviderId,
      accountId: string,
    ): Promise<{ ok: boolean; marked: boolean }>;
    testAccountConnection(
      providerId: import('@omnicross/contracts/subscription-types').SubscriptionProviderId,
      accountId: string,
    ): Promise<{
      ok: boolean;
      marked: boolean;
      tier: 'local' | 'upstream' | 'generation';
      model?: string;
    }>;
  };
  /**
   * Least-authority subscription-token WRITER (design D4) — ONLY the mutation
   * methods (`writeProviderTokens` / `clearProvider`), never a token-returning
   * read. The token-free `subscriptionAccounts` lister stays separate so a GET
   * handler can never reach a token through this dep.
   */
  readonly subscriptionTokenWriter: SubscriptionTokenWriter;
  /**
   * Read-only pool-health reader (key-pool design D7) — cooldown health only,
   * never a key value. Drives `GET /admin/api/providers/:id/keys`.
   */
  readonly apiKeyPool: PoolHealthReader;
  /** In-memory auto-disable store (design D5) — read-only for the health view. */
  readonly autoDisableStore: AutoDisableStore;
  /**
   * OPTIONAL BYO provider-key quota service — same-key usage/quota probes for
   * provider rows with a known adapter (Z.AI coding plan, MiniMax Token Plan).
   * Absent ⇒ the keys view carries no `quota` field (light embedders).
   */
  readonly providerKeyQuota?: ProviderKeyQuotaReader;
  /**
   * Pending interactive-OAuth sessions (app-parity child 4, design D1) — the
   * in-memory `{ codeVerifier, state }` map keyed by a minted `sessionId`,
   * NEVER serialized to the client.
   */
  readonly oauthSessions: OAuthSessionStore;
  /**
   * Injected token-exchange `FetchLike` FACTORY (oauth design D2-a) — built per
   * provider in `bootstrap.ts` so the exchange carries a `{ providerId }` egress
   * ctx (per-provider proxy layer + upstream trace, bodies redacted); tests
   * inject a mock so no real token endpoint is hit. Mirrors how `login.ts`
   * injects its exchange fetch.
   */
  readonly oauthExchangeFetch: (providerId: SubscriptionProviderId) => FetchLike;
  /**
   * NARROW append handle (oauth design D2-a) — the OAuth complete handler needs
   * `appendProviderAccount` (NOT on the least-authority `SubscriptionTokenWriter`).
   * A minimal interface, NOT the full read-capable store, so no token-returning
   * read is reachable. Wired from the concrete `credentialStore` in `bootstrap.ts`.
   */
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
  /**
   * Codex interactive-OAuth flow store (app-parity-2 child 5). Tracks the async
   * loopback sign-in's polled status (token-free); only ONE codex login may be in
   * flight (port 1455 is one resource). Wired in `bootstrap.ts`.
   */
  readonly codexSessions: CodexOAuthSessionStore;
  /**
   * Kimi interactive-OAuth flow store (device code). Same token-free polled
   * shape as codex; one sign-in at a time. Wired in `bootstrap.ts`.
   */
  readonly kimiSessions: KimiOAuthSessionStore;
  /**
   * Grok interactive-OAuth flow store (device code). Same token-free polled
   * shape as codex; one sign-in at a time. Wired in `bootstrap.ts`.
   */
  readonly grokSessions: GrokOAuthSessionStore;
  /**
   * Copilot interactive-OAuth flow store (device code). Same token-free
   * polled shape; one sign-in at a time. Wired in `bootstrap.ts`.
   */
  readonly copilotSessions: CopilotOAuthSessionStore;
  /** Antigravity interactive OAuth (loopback 51121) — the async flow store. */
  readonly antigravitySessions: AntigravityOAuthSessionStore;
  /** The one-shot 127.0.0.1:51121 listener (test seam like `codexAwaitLoopback`). */
  readonly antigravityAwaitLoopback: AntigravityLoopbackFn;
  /**
   * Resolve the ACTIVE antigravity account's access token for the dynamic
   * model-catalog probe (secret used daemon-side only; the route is
   * secret-free). Optional for older tests; absent → static-only catalog.
   */
  readonly resolveAntigravityAccessToken?: () => Promise<string | null>;
  /**
   * Resolve an opencodego account's key + zen-half host override for the live
   * model-list probe (`GET /accounts/opencodego/models`). Secret used
   * daemon-side only; the route is secret-free. Optional for older tests;
   * absent → `discovered: false` with an error string.
   */
  readonly resolveOpenCodeGoModelsAccount?: (
    accountId?: string,
  ) => Promise<OpenCodeGoModelsAccount | null>;
  /**
   * Codex loopback listener (app-parity-2 child 5) — defaults to `awaitLoopbackCode`
   * (binds 127.0.0.1:1455) in `bootstrap.ts`; tests inject a mock so no real port
   * is bound. The captured code crosses to the daemon ONLY (never the client).
   */
  readonly codexAwaitLoopback: CodexLoopbackFn;
  /**
   * Migration credential-store handle (app-parity child 6, design D2/D3). The
   * export gather needs `getFullConfig()` (full DECRYPTED tokens, in-memory only —
   * the pack is the only thing that leaves) and import needs `appendProviderAccount`
   * (multi-account append + re-encrypt at-rest). Confined to the migration
   * handlers (which seal/validate everything); never reached by a GET handler.
   * Wired from the concrete `credentialStore` in `bootstrap.ts`.
   */
  readonly migrationCredentialStore: MigrationCredentialStore;
  /**
   * Usage-stats query facade (usage-pricing child) — delegates to the JSONL
   * usage-event store. Aggregates only; carries no key material.
   */
  readonly usageRecorder: UsageRecorder;
  /** Pricing engine (upsert / source refresh / conflict resolution). */
  readonly pricingEngine: PricingEngine;
  /**
   * CONCRETE pricing store — ONLY for the store-local row `delete` (the core
   * `PricingStore` port is frozen; delete is a daemon-local extra).
   */
  readonly pricingStore: JsonPricingStore;
  /**
   * External-terminal opener for the Code CLI launch route (dashboard parity).
   * Optional — defaults to the real `defaultTerminalOpener`; tests inject a spy so
   * no terminal window is actually spawned.
   */
  readonly cliTerminalOpener?: TerminalOpener;
  /** Injectable PATH probe for CLI detection (tests fake "installed"). */
  readonly cliPathProbe?: PathProbe;
  /**
   * Injectable shell runner for the Code CLI install route. Optional — defaults
   * to the real `exec`-based runner; tests inject a stub so no package manager
   * actually runs.
   */
  readonly cliCommandRunner?: CommandRunner;
  /**
   * Injectable runner for the Code CLI VERSION probes (`--version`,
   * `npm view <pkg> version`). Optional — defaults to the real `exec`-based
   * runner; tests inject a stub so no CLI/npm ever runs.
   */
  readonly cliVersionRunner?: VersionRunner;
  /**
   * Codex command-auth helper invocation for KEY-SCOPED launches (the `--key-id`
   * variant). Wired by bootstrap from the same inputs as the integration
   * install's helper; absent ⇒ `keyId` launches answer 501 (light embedders).
   */
  readonly codexAuthHelper?: CodexAuthHelperConfig;
  /** Factory so each request observes the outbound server's current loopback port. */
  readonly integrationManagerFactory?: () => IntegrationManager;
  /**
   * search-settings-ui D3: the daemon's ONE search runtime plus its
   * bootstrap-captured frontend modes. Optional for lightweight embedders; the
   * standalone daemon wires it and the `/admin/api/search` diagnostics/test
   * routes return 501 when absent (the voucher/allowance optionality precedent).
   */
  readonly searchStatus?: SearchAdminRuntimeStatus;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read the full request body as a UTF-8 string (mirrors the outbound router). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parse the request body as JSON (→ `{}` on an empty/invalid body). */
export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function writeJsonError(res: http.ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: { type: 'admin_api_error', message } });
}


/** Project a stored key row to the never-secret DTO (drops keyHash + plaintext). */
export function toKeyInfo(row: OutboundKeyDbRow): OutboundApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    // True only when a reversible `keySecret` envelope was persisted at creation
    // — gates the UI "view key" eye. Legacy hash-only rows read as absent.
    revealable: Boolean(row.keySecret),
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revoked: row.revokedAt !== null,
    kind: row.kind,
    allowedEndpoints: [...effectivePermissionsForRow(row)],
    loopbackOnly: row.loopbackOnly,
    maxConcurrency: row.maxConcurrency,
    // UPSTREAM ROUTING MODEL: the key's ordered upstream set ('all' = live
    // reference; explicit empty = deliberately bound to nothing). Absent on
    // legacy rows (downstream-route semantics).
    ...(row.upstreamBinding ? { upstreamBinding: row.upstreamBinding } : {}),
    // Key-policy envelope (outbound-key-policy) — all secret-free scalar fields;
    // the UI reads them to render + pre-fill the policy editor.
    expiresAt: row.expiresAt,
    activationMode: row.activationMode,
    activationDays: row.activationDays,
    activatedAt: row.activatedAt,
    dailyCostLimitUsd: row.dailyCostLimitUsd,
    totalCostLimitUsd: row.totalCostLimitUsd,
    weeklyCostLimitUsd: row.weeklyCostLimitUsd,
    rateLimitMaxRequests: row.rateLimitMaxRequests,
    rateLimitWindowMs: row.rateLimitWindowMs,
    // Per-key model restriction (#6) — secret-free scalars the UI pre-fills.
    enableModelRestriction: row.enableModelRestriction,
    restrictionMode: row.restrictionMode,
    restrictedModels: row.restrictedModels,
    // Direct upstream passthrough target (key→upstream binding) — references
    // only, never a credential. Absent = the key is served by the downstream
    // routes. `boundUpstreamProviderId` is the legacy first-cut shape.
    boundUpstream: row.boundUpstream,
    boundUpstreamProviderId: row.boundUpstreamProviderId,
  };
}


// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Dispatch one `/admin/api/*` request. `path` is the already-extracted pathname
 * (no query). The auth gate has already run in `AdminServer`.
 */
export async function handleAdminApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  deps: AdminApiDeps,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const protectedGet = path.endsWith('/reveal-key') || path.endsWith('/reveal');
  const [resource, , action] = path.slice('/admin/api/'.length).split('/');
  const probe = resource === 'providers' && (action === 'discover-models' || action === 'test' || path.endsWith('/logjev-probe'));
  if (!protectedGet && (method === 'GET' || !credentialResources.has(resource) || probe)) {
    return dispatchAdminApi(req, res, path, deps);
  }
  // A request waiting for its body must not retain a pre-recovery config and
  // write old credentials back after reset. Serialize credential writes with reset
  // and protected reads, separately from the verifier's own operation queue.
  const key = deps.configPath ? resolve(deps.configPath) : deps;
  const previous = adminWrites.get(key);
  const result = previous ? previous.then(() => dispatchAdminApi(req, res, path, deps)) : dispatchAdminApi(req, res, path, deps);
  const settled = result.catch(() => undefined);
  adminWrites.set(key, settled);
  void settled.then(() => { if (adminWrites.get(key) === settled) adminWrites.delete(key); });
  return result;
}

const adminWrites = new Map<string | AdminApiDeps, Promise<unknown>>();
const credentialResources = new Set(['key-viewing-password', 'providers', 'keys', 'upstreams',
  'server', 'images', 'search', 'accounts', 'integrations', 'import', 'export']);

async function dispatchAdminApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
  deps: AdminApiDeps,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const sub = path.slice('/admin/api/'.length);
  const [resource, ...rest] = sub.split('/').filter((s) => s.length > 0);

  try {
    if (resource === 'key-viewing-password') {
      const viewing = new KeyViewingPassword(deps.configPath);
      res.setHeader('Cache-Control', 'no-store');
      if (method === 'GET' && rest.length === 0) return writeJson(res, 200, await viewing.status());
      if (method === 'PUT' && rest.length === 0) {
        const body = await readJsonBody(req);
        await viewing.change(body.currentPassword, body.newPassword);
        return writeJson(res, 200, { ok: true });
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'reset') {
        const body = await readJsonBody(req);
        if (body.confirmClearCredentials !== true) return writeJsonError(res, 400, 'view-password-reset-confirm');
        if (!deps.clearStoredCredentials) return writeJsonError(res, 503, 'view-password-unavailable');
        await viewing.reset(body.newPassword, async () => {
          await deps.clearStoredCredentials!();
          const config = clearConfigCredentials(loadConfig(deps.configPath));
          saveConfigAtomically(deps.configPath, config);
          deps.llmConfig.reload(config);
          await reapplyLiveServerConfig(deps);
        });
        return writeJson(res, 200, { ok: true });
      }
      return writeJsonError(res, 405, 'method not allowed on key-viewing-password');
    }
    const providerReveal = resource === 'providers' && rest.length === 2 && rest[1] === 'reveal-key';
    const clientReveal = resource === 'keys' && rest.length === 2 && rest[1] === 'reveal';
    if (providerReveal || clientReveal) {
      const viewing = new KeyViewingPassword(deps.configPath);
      res.setHeader('Cache-Control', 'no-store');
      if (method !== 'GET' && method !== 'POST') return writeJsonError(res, 405, 'method not allowed on reveal');
      // Legacy GET remains usable only while protection is disabled. Passwords
      // are accepted exclusively in a POST body, never URLs or reusable headers.
      const body = method === 'POST' ? await readJsonBody(req) : {};
      return await viewing.read(body.viewingPassword, async () => providerReveal
        ? handleProviders(req, res, 'GET', rest, deps)
        : handleKeys(req, res, 'GET', rest, deps));
    }
    switch (resource) {
      case 'providers':
        return await handleProviders(req, res, method, rest, deps);
      case 'presets': {
        if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on presets`);
        const result = listPresets();
        return writeJson(res, result.status, result.body);
      }
      case 'keys':
        return await handleKeys(req, res, method, rest, deps);
      case 'upstreams':
        return await handleUpstreams(req, res, method, rest, deps);
      case 'voucher':
        return await handleVoucher(req, res, method, rest, deps);
      case 'server':
        return await handleServer(req, res, method, deps);
      case 'images':
        return await handleImages(req, res, method, rest, deps);
      case 'search':
        return await handleSearchAdmin(req, res, method, rest, deps);
      case 'accounts': {
        const result = await handleAccounts(req, res, method, rest, deps);
        // UPSTREAM ROUTING MODEL: an account add/remove changes which
        // subscription pools the catalog admits — re-derive after every
        // mutation (best-effort; a derive failure must not fail the response).
        if (method !== 'GET') await reapplyLiveServerConfig(deps).catch(() => undefined);
        return result;
      }
      case 'cli':
        return await handleCli(req, res, method, rest, deps);
      case 'chatgpt-web':
        return await handleChatGptWeb(req, res, method, rest, {
          registerBridgeProvider: (bridge) => ensureChatGptWebBridgeProvider(deps, bridge),
        });
      case 'integrations':
        return await handleIntegrations(req, res, method, rest, deps);
      case 'status':
        return await handleStatus(res, method, deps);
      case 'playground':
        return await handlePlayground(req, res, method, deps);
      case 'export':
        return await handleMigrationExport(req, res, method, deps);
      case 'import':
        return await handleMigrationImport(req, res, method, deps);
      case 'usage':
        return await handleUsage(req, res, method, rest, deps);
      case 'dashboard':
        return await handleDashboardRoute(res, method, deps);
      case 'logs':
        return handleLogsExport(res, method, rest, deps);
      case 'pricing':
        return await handlePricing(req, res, method, rest, deps);
      default:
        return writeJsonError(res, 404, `unknown admin resource '${resource}'`);
    }
  } catch (err) {
    if (err instanceof KeyViewingError) return writeJsonError(res, err.status, err.message);
    writeJsonError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

// ── Log export (bug-report bundle) ────────────────────────────────────────────

/**
 * `GET /admin/api/logs/export` → the daemon log bundle as ONE redacted
 * plain-text attachment (`omnicross-logs-<stamp>.log`): the live file plus its
 * rotated generations, oldest first, size-capped. See `admin/logsExport`.
 */
function handleLogsExport(
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): void {
  if (rest[0] !== 'export' || rest.length !== 1) {
    writeJsonError(res, 404, `unknown logs resource '${rest.join('/') || '(none)'}'`);
    return;
  }
  if (method !== 'GET') {
    writeJsonError(res, 405, `method ${method} not allowed on logs`);
    return;
  }
  if (!deps.logFile) {
    writeJsonError(res, 501, 'log export is not available in this build');
    return;
  }
  const bundle = buildLogExportBundle(deps.logFile, { auditDir: deps.auditDir });
  const body = Buffer.from(bundle.text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${bundle.filename}"`,
    'Content-Length': body.length,
  });
  res.end(body);
}

// ── Usage stats + pricing table (usage-pricing child) ─────────────────────────

/** Query params for the current request (the router strips them off `path`). */
function requestQuery(req: http.IncomingMessage): URLSearchParams {
  const raw = req.url ?? '';
  const qIdx = raw.indexOf('?');
  return new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
}

function writeResult(res: http.ServerResponse, result: UsagePricingResult): void {
  writeJson(res, result.status, result.body);
}

/**
 * `GET /admin/api/usage/{totals|by-model|by-api-key|timeseries}?startTs&endTs`,
 * plus `GET /admin/api/usage/throughput` (live rates; takes no range).
 */
async function handleUsage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on usage`);
  return writeResult(res, await handleUsageGet(rest[0], requestQuery(req), deps));
}

/**
 * `GET /admin/api/dashboard` → the read-only `DashboardSummary` aggregate.
 * GET-only (405 otherwise). `AdminApiDeps` structurally satisfies the focused
 * `DashboardDeps` — no deps widening.
 */
async function handleDashboardRoute(
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on dashboard`);
  const result = await handleDashboard(deps);
  return writeJson(res, result.status, result.body);
}

/** `/admin/api/pricing` (GET/PUT/DELETE) + `/fetch-latest` + `/resolve-conflicts`. */
async function handlePricing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') return writeResult(res, await handlePricingList(deps));
    if (method === 'PUT') {
      return writeResult(res, await handlePricingUpsert(await readJsonBody(req), deps));
    }
    if (method === 'DELETE') {
      return writeResult(res, await handlePricingDelete(requestQuery(req), deps));
    }
    return writeJsonError(res, 405, `method ${method} not allowed on pricing`);
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'fetch-latest') {
    return writeResult(res, await handlePricingFetchLatest(deps));
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'resolve-conflicts') {
    return writeResult(res, await handlePricingResolveConflicts(await readJsonBody(req), deps));
  }
  return writeJsonError(res, 404, `unknown pricing route '${rest.join('/')}'`);
}

// ── Migration pack (export / import) ──────────────────────────────────────────

/** Build the `MigrationDeps` view from the live admin deps (app-parity child 6). */
function migrationDeps(deps: AdminApiDeps): MigrationDeps {
  return {
    configPath: deps.configPath,
    llmConfig: deps.llmConfig,
    credentialStore: deps.migrationCredentialStore,
    parseProviderInput,
  };
}

/** `POST /admin/api/export { passphrase }` → seal the full state under the
 *  passphrase; respond ONLY `{ pack, version }` (the opaque blob). */
async function handleMigrationExport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on export`);
  const body = await readJsonBody(req);
  res.setHeader('Cache-Control', 'no-store');
  const result = await new KeyViewingPassword(deps.configPath).read(body.viewingPassword,
    () => handleExport(body, migrationDeps(deps)));
  return writeJson(res, result.status, result.body);
}

/** `POST /admin/api/import { blob, passphrase, mode? }` → open + validate + apply
 *  (re-encrypt at-rest); respond STATUS-ONLY counts. */
async function handleMigrationImport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on import`);
  const body = await readJsonBody(req);
  const result = await handleImport(body, migrationDeps(deps));
  return writeJson(res, result.status, result.body);
}

// ── Providers (CRUD + hot-reload) ─────────────────────────────────────────────

async function handleProviders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  const service = providerAdminDeps(deps);
  const send = (result: ServiceResult): void => writeJson(res, result.status, result.body);

  // GET /providers/:id/keys → read-only pool-health view (key-pool design D7).
  if (method === 'GET' && rest.length === 2 && rest[1] === 'keys') {
    return send(await listProviderKeys(service, rest[0]));
  }

  // POST /providers/:id/keys → add a pool key (app-parity child 3). Mints the id
  // daemon-side (OQ2). Matched BEFORE the generic `:id` POST (a sub-path, not a body).
  if (method === 'POST' && rest.length === 2 && rest[1] === 'keys') {
    return send(await addProviderKey(service, rest[0], await readJsonBody(req)));
  }

  // POST /providers/:id/keys/:keyId/enabled → toggle one pool key (child 3).
  // Matched before the 3-segment update/delete (it has a reserved trailing seg).
  if (method === 'POST' && rest.length === 4 && rest[1] === 'keys' && rest[3] === 'enabled') {
    return send(await setProviderKeyEnabled(service, rest[0], rest[2], await readJsonBody(req)));
  }

  // POST /providers/:id/keys/:keyId/quota/refresh → force one BYO key quota
  // probe (the per-key refresh button). Bypasses the service's read-through
  // cache; 404 when the row has no quota adapter or the key does not exist.
  if (method === 'POST' && rest.length === 5 && rest[1] === 'keys' && rest[3] === 'quota' && rest[4] === 'refresh') {
    return send(await refreshProviderKeyQuota(service, rest[0], rest[2]));
  }

  // PUT /providers/:id/keys/:keyId → update one pool key (child 3).
  if (method === 'PUT' && rest.length === 3 && rest[1] === 'keys') {
    return send(await updateProviderKey(service, rest[0], rest[2], await readJsonBody(req)));
  }

  // DELETE /providers/:id/keys/:keyId → remove one pool key (child 3).
  if (method === 'DELETE' && rest.length === 3 && rest[1] === 'keys') {
    return send(await deleteProviderKey(service, rest[0], rest[2]));
  }

  // POST /providers/reorder → reorder the persisted provider array (D8). Matched
  // BEFORE the `:id` fallthrough (`reorder` is a reserved sub-path, not an id).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'reorder') {
    return send(await reorderProviders(service, await readJsonBody(req)));
  }

  // POST /providers/logjev-probe { kind?, providerId, model } → the LogJev
  // config's logprobs-support probe (one minimal completion with the reader's
  // exact parameters). Matched before the `:id` fallthrough, same as `reorder`.
  if (method === 'POST' && rest.length === 1 && rest[0] === 'logjev-probe') {
    return await handleLogJevProbe(req, res, loadConfig(deps.configPath), deps);
  }

  // POST /providers/:id/discover-models → list upstream models (OpenAI-format
  // scoped, D8). Matched before the generic `:id` write handlers.
  if (method === 'POST' && rest.length === 2 && rest[1] === 'discover-models') {
    return send(await discoverProviderModels(service, rest[0]));
  }

  // POST /providers/:id/test { model } → a minimal upstream completion using the
  // provider's OWN stored key, so the per-model "test" button on each model card
  // works without minting a client key. Matched before the generic `:id` handlers.
  if (method === 'POST' && rest.length === 2 && rest[1] === 'test') {
    return send(await testProviderModel(service, rest[0], await readJsonBody(req)));
  }

  // GET /providers/:id/reveal-key → the DECRYPTED stored provider key (gated by
  // the viewing password in `handleAdminApi`; never part of the list).
  if (method === 'GET' && rest.length === 2 && rest[1] === 'reveal-key') {
    return send(revealProviderKey(service, rest[0]));
  }

  if (method === 'GET') return send(listProviders(service));

  if (method === 'POST') return send(await createProvider(service, await readJsonBody(req)));

  if (method === 'PUT') return send(await updateProvider(service, rest[0], await readJsonBody(req)));

  if (method === 'DELETE') return send(await deleteProvider(service, rest[0]));

  // Unsupported verb: keep the historical precedence (missing id → 400, unknown
  // id → 404, otherwise 405).
  const id = rest[0];
  if (!id) return writeJsonError(res, 400, 'provider id required in path');
  if (!loadConfig(deps.configPath).providers.some((p) => p.id === id)) {
    return writeJsonError(res, 404, `provider '${id}' not found`);
  }
  return writeJsonError(res, 405, `method ${method} not allowed on providers`);
}

/**
 * The provider service's deps over the live daemon handles. The two hooks carry
 * the daemon-only gateway effects: re-deriving live routing after a catalog
 * write, and the create-time default mapping row + onboarding access key.
 */
function providerAdminDeps(deps: AdminApiDeps): ProviderAdminDeps {
  return {
    configPath: deps.configPath,
    llmConfig: deps.llmConfig,
    apiKeyPool: deps.apiKeyPool,
    autoDisableStore: deps.autoDisableStore,
    providerKeyQuota: deps.providerKeyQuota,
    afterProvidersChanged: () => reapplyLiveServerConfig(deps),
    provisionProviderDefaults: (row, isFirstProvider) =>
      provisionGatewayDefaults(deps, row, isFirstProvider),
  };
}

/** Persist the config to disk AND hot-reload the live provider catalog. */
async function persistProviders(cfg: DaemonConfig, deps: AdminApiDeps): Promise<void> {
  await persistProviderCatalog(cfg, providerAdminDeps(deps));
}

/** Create-time provisioning over the live daemon handles (best-effort). */
async function provisionNewProvider(
  deps: AdminApiDeps,
  provider: DaemonProviderConfig,
  isFirstProvider: boolean,
): Promise<void> {
  await provisionProviderOnCreate(providerAdminDeps(deps), provider, isFirstProvider);
}

/**
 * The daemon's gateway half of create-time provisioning (runs after model
 * discovery, inside the service's best-effort block):
 *  - a `* -> <default model>` mapping row lands on the new upstream unless a
 *    table already exists, so it serves ANY client model name immediately —
 *    the operator never has to open the mapping editor to get a working route;
 *  - on the FIRST provider, when no live access key exists yet, an
 *    {@link ONBOARDING_ACCESS_KEY_NAME} key is created and bound to EVERY
 *    current upstream — the onboarding "enable access" step and CLI installs
 *    then have a key to use without ever visiting the keys page.
 */
async function provisionGatewayDefaults(
  deps: AdminApiDeps,
  row: DaemonProviderConfig,
  isFirstProvider: boolean,
): Promise<void> {
  const target = defaultProviderMappingTarget(row);
  const current = await loadServerConfig(deps.settingsStore);
  if (target && !current.upstreamModelMappings?.[row.id]) {
    await saveServerConfig(deps.settingsStore, {
      ...current,
      upstreamModelMappings: {
        ...(current.upstreamModelMappings ?? {}),
        [row.id]: [{ source: '*', target }],
      },
    });
  }
  if (isFirstProvider) {
    const rows = await deps.keyDb.outboundApiKeysList();
    const hasLiveKey = rows.some((keyRow) => keyRow.revokedAt === null);
    if (!hasLiveKey) {
      const created = await createNamedKey(deps.keyDb, ONBOARDING_ACCESS_KEY_NAME);
      await deps.keyDb.outboundApiKeysSetUpstreamBinding(created.id, {
        mode: 'explicit',
        targets: (await listUpstreamCatalog(deps)).map((entry) => entry.target),
      });
    }
  }
  await reapplyLiveServerConfig(deps);
}

/**
 * Ensure the chatgpt-web BRIDGE exists as a BYO provider row, so codex keeps
 * a single `omnicross` provider and routes `chatgpt-web/*` models through the
 * normal mapping table instead of a second provider entry. Called on every
 * bridge start (the token is persistent; the upsert is idempotent).
 *
 * CREATE seeds the full row (native Responses wire, universal model routes).
 * UPDATE refreshes ONLY `baseUrl` + `apiKey` — the operator's edits on the
 * row (name, model list — e.g. Pro/Luna routes via discover-models, enabled)
 * must survive a bridge restart (parseProviderInput's omit-keeps contract).
 */
export async function ensureChatGptWebBridgeProvider(
  deps: AdminApiDeps,
  bridge: { baseUrl: string; token: string },
): Promise<void> {
  const cfg = loadConfig(deps.configPath);
  const index = cfg.providers.findIndex((p) => p.id === CHATGPT_WEB_PROVIDER_ID);
  const existing = index >= 0 ? cfg.providers[index] : undefined;
  const row = parseProviderInput(existing
    ? {
      // PUT semantics: only the bridge-owned facts refresh; apiFormat is
      // re-asserted because parseProviderInput validates it from the body.
      apiFormat: 'openai-response',
      baseUrl: bridge.baseUrl,
      apiKey: bridge.token,
    }
    : {
      id: CHATGPT_WEB_PROVIDER_ID,
      name: 'ChatGPT Web (bridge)',
      apiFormat: 'openai-response',
      baseUrl: bridge.baseUrl,
      apiKey: bridge.token,
      models: [...CHATGPT_WEB_BRIDGE_MODELS],
      enabled: true,
    }, existing);
  if (!row) throw new Error(`invalid ${CHATGPT_WEB_PROVIDER_ID} provider shape`);
  if (index >= 0) cfg.providers[index] = row;
  else cfg.providers.push(row);
  await persistProviders(cfg, deps);
  if (!existing) {
    // Same onboarding conveniences as a manual provider create (best-effort
    // by design — the row itself was already persisted above).
    await provisionNewProvider(deps, row, cfg.providers.length === 1).catch(() => undefined);
  }
}


/**
 * `POST /providers/logjev-probe` `{ kind?, providerId, model }` — the LogJev
 * configuration's SUPPORT probe: one minimal completion carrying the exact
 * logprobs parameters the chat reader sends (`logprobs: true`,
 * `top_logprobs`, `max_tokens: 1`), then the same evidence check the reader
 * applies (`choices[0].logprobs.content[0].top_logprobs` non-empty).
 * `kind` defaults to `'provider'` (a 模型服务 row); `'account-pool'` probes
 * the ACTIVE opencodego account's zen chat wire. Answers
 * `{ ok, supported, message? }`; HTTP 200 even on an unsupported upstream so
 * the UI can render the reason instead of an error.
 */
async function handleLogJevProbe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: DaemonConfig,
  deps: AdminApiDeps,
): Promise<void> {
  const body = (await readJsonBody(req)) as { kind?: unknown; providerId?: unknown; model?: unknown };
  const kind = body['kind'] === 'account-pool' ? 'account-pool' : 'provider';
  const providerId = typeof body['providerId'] === 'string' ? body['providerId'].trim() : '';
  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  if (!providerId || !model) {
    return writeJsonError(res, 400, 'logjev-probe requires { providerId, model } strings');
  }

  // Resolve the TARGET: url + key + headers for either reference kind.
  let url: string;
  let headers: Record<string, string>;
  let fetchProviderId: 'byo' | 'opencodego' = 'byo';
  if (kind === 'account-pool') {
    if (providerId !== 'opencodego') {
      return writeJson(res, 200, { ok: false, supported: false, message: 'account-pool probes support opencodego only (the sole OpenAI-chat subscription wire)' });
    }
    const account = await (deps.resolveOpenCodeGoModelsAccount?.() ?? Promise.resolve(null)).catch(() => null);
    if (!account?.apiKey) {
      return writeJson(res, 200, { ok: false, supported: false, message: 'no opencodego account or API key configured (账号订阅)' });
    }
    url = `${openCodeGoChatBase(account.zenBaseUrl)}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.apiKey}`,
      // opencode.ai egress identity (same discipline as the relay path).
      'user-agent': getOpenCodeGoUserAgent(),
      'x-opencode-session': 'omnicross-logjev-probe',
    };
    fetchProviderId = 'opencodego';
  } else {
    const row = cfg.providers.find((p) => p.id === providerId && p.category !== 'other');
    if (!row) return writeJsonError(res, 404, `provider '${providerId}' not found`);
    if (row.apiFormat !== 'openai') {
      return writeJson(res, 200, { ok: false, supported: false, message: 'LogJev requires an OpenAI-wire (chat completions) provider' });
    }
    const resolvedKey = resolveEnvKey(row.apiKey);
    if (!resolvedKey) {
      return writeJson(res, 200, { ok: false, supported: false, message: 'no API key configured for this provider' });
    }
    url = chatCompletionsUrlForRow(row.baseUrl);
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolvedKey}`,
    };
    Object.assign(headers, expandRowExtraHeaders(row));
    applyAdminProbeIdentity(headers, row);
  }

  // Mirror the reader's exact read shape (core/logjev client.ts) so "probe
  // passed" ⇔ "evaluations will find evidence".
  const payload = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    temperature: 1,
    logprobs: true,
    top_logprobs: 20,
    stream: false,
    n: 1,
  };

  const startedAt = Date.now();
  try {
    const response = await fetchUpstream(
      url,
      { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) },
      { providerId: fetchProviderId },
    );
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        // keep the raw slice
      }
      return writeJson(res, 200, {
        ok: false,
        supported: false,
        latencyMs,
        message: `upstream rejected the probe (${response.status})${message ? `: ${message}` : ''}`,
      });
    }
    // The reader's evidence shape: choices[0].logprobs.content[0].top_logprobs.
    let supported = false;
    try {
      const data = JSON.parse(text) as {
        choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: unknown }> } }>;
      };
      const topLogprobs = data.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
      supported = Array.isArray(topLogprobs) && topLogprobs.length > 0;
    } catch {
      supported = false;
    }
    return writeJson(res, 200, {
      ok: true,
      supported,
      latencyMs,
      ...(supported ? {} : { message: 'the model answered but returned no top_logprobs — it cannot serve LogJev readings' }),
    });
  } catch (err) {
    return writeJson(res, 200, {
      ok: false,
      supported: false,
      latencyMs: Date.now() - startedAt,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}


// ── Keys (CRUD + one-time plaintext) ──────────────────────────────────────────

async function handleKeys(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET' && rest.length === 0) {
    const rows = await deps.keyDb.outboundApiKeysList();
    const reader = deps.keySpendReader;
    if (!reader) return writeJson(res, 200, { keys: rows.map(toKeyInfo) });
    // Attach each key's OWN accumulated spend (leak-safe — per-key only). The
    // reader lazily seeds once per key then serves O(1); this admin list is rare.
    const now = Date.now();
    const keys = await Promise.all(
      rows.map(async (row) => {
        const info = toKeyInfo(row);
        // Only for live keys — a revoked key never dispatches, so its spend is
        // frozen and uninteresting; skip the seed for it.
        if (row.revokedAt === null) {
          const s = await reader.getSpend(row.id, now);
          info.spend = { dailyUsd: s.dailyUsd, weeklyUsd: s.weeklyUsd, totalUsd: s.totalUsd };
        }
        return info;
      }),
    );
    return writeJson(res, 200, { keys });
  }

  if (method === 'POST' && rest.length === 0) {
    const body = await readJsonBody(req);
    const name = typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim() : 'key';
    const created = await createNamedKey(deps.keyDb, name);
    // UPSTREAM ROUTING MODEL: new keys materialize the configured default
    // ('all' = every CURRENT upstream selected, as a snapshot) as an EXPLICIT
    // decision — there is no live "all" mode; 'all' simply pre-selects the
    // whole catalog at creation time, and the key never sits in the ambiguous
    // "not migrated" state.
    const serverConfig = await loadServerConfig(deps.settingsStore);
    const defaultBinding: KeyUpstreamBinding = serverConfig.defaultKeyUpstreamBinding === 'all'
      ? { mode: 'explicit', targets: (await listUpstreamCatalog(deps)).map((entry) => entry.target) }
      : { mode: 'explicit', targets: [] };
    await deps.keyDb.outboundApiKeysSetUpstreamBinding(created.id, defaultBinding);
    await reapplyLiveServerConfig(deps);
    // `plaintextOnce` is the ONLY place a full key crosses the wire (design D4).
    return writeJson(res, 201, {
      id: created.id,
      name: created.name,
      keyPrefix: created.keyPrefix,
      createdAt: created.createdAt,
      allowedEndpoints: created.allowedEndpoints,
      upstreamBinding: defaultBinding,
      plaintextOnce: created.plaintextOnce,
    });
  }

  // GET /keys/:id/reveal → the DECRYPTED key plaintext, for the operator "view
  // key" affordance. Mirrors /providers/:id/reveal-key: the secret crosses OUT
  // here BY DESIGN, only on this explicit per-key request (never in the list).
  // Null covers both "missing" and "exists but not revealable (legacy hash-only
  // row)"; a list probe distinguishes them for a precise status code.
  if (method === 'GET' && rest.length === 2 && rest[1] === 'reveal') {
    const revealed = await deps.keyDb.outboundApiKeysReveal(rest[0]);
    if (revealed !== null) return writeJson(res, 200, { key: revealed });
    const exists = (await deps.keyDb.outboundApiKeysList()).some((r) => r.id === rest[0]);
    if (!exists) return writeJsonError(res, 404, `key '${rest[0]}' not found`);
    return writeJsonError(
      res,
      409,
      `key '${rest[0]}' is not revealable (created before revealable key storage)`,
    );
  }

  const id = rest[0];
  const action = rest[1];
  if (method === 'POST' && id && action === 'revoke') {
    const bound = await integrationKeyRequirement(deps, id);
    if (bound) return writeJsonError(res, 409, bound);
    const ok = await deps.keyDb.outboundApiKeysRevoke(id);
    return writeJson(res, ok ? 200 : 404, { ok });
  }
  if (method === 'POST' && id && action === 'enabled') {
    const body = await readJsonBody(req);
    const enabled = body['enabled'] === true;
    if (!enabled) {
      const bound = await integrationKeyRequirement(deps, id);
      if (bound) return writeJsonError(res, 409, bound);
    }
    const ok = await deps.keyDb.outboundApiKeysSetEnabled(id, enabled);
    return writeJson(res, ok ? 200 : 404, { ok, enabled });
  }
  if (method === 'POST' && id && action === 'max-concurrency') {
    const body = await readJsonBody(req);
    const raw = body['maxConcurrency'];
    // Strict admin-edge validation (unlike core's lenient clamp): a positive
    // integer 1..1000, or explicit `null` to clear. Anything else → 400.
    let value: number | null;
    if (raw === null) {
      value = null;
    } else if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= 1 &&
      raw <= 1000
    ) {
      value = raw;
    } else {
      return writeJsonError(
        res,
        400,
        'maxConcurrency must be an integer 1..1000 or null',
      );
    }
    const ok = await deps.keyDb.outboundApiKeysSetMaxConcurrency(id, value);
    return writeJson(res, ok ? 200 : 404, { ok, maxConcurrency: value });
  }
  // POST /keys/:id/upstream — set (or clear, with `null`) the key's DIRECT
  // upstream passthrough target. Body: `{ target: null | { kind: 'provider',
  // providerId } | { kind: 'account' | 'account-group' | 'account-pool',
  // providerId, accountId?/group? } }` (the first cut's `{ providerId }` shape
  // is still accepted as a provider target). A provider target must name an
  // EXISTING BYO row; a subscription target is only legal for claude/kimi —
  // the subscriptions whose upstream speaks the SAME Anthropic Messages wire
  // as the client (codex/gemini/… need translation, i.e. the downstream
  // routes). Stored as references only, never credentials.
  if (method === 'POST' && id && action === 'upstream') {
    const body = await readJsonBody(req);
    let raw: unknown;
    if (Object.prototype.hasOwnProperty.call(body, 'target')) {
      raw = body['target'];
    } else if (Object.prototype.hasOwnProperty.call(body, 'providerId')) {
      // Legacy #45 shape: a bare provider id (or null).
      const legacy = body['providerId'];
      raw =
        legacy === null || legacy === undefined
          ? null
          : { kind: 'provider', providerId: legacy };
    } else {
      return writeJsonError(res, 400, 'body must contain target (or the legacy providerId)');
    }
    if (raw === null || raw === undefined) {
      const ok = await deps.keyDb.outboundApiKeysSetUpstream(id, null);
      return writeJson(res, ok ? 200 : 404, { ok, target: null });
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return writeJsonError(res, 400, 'target must be an object or null');
    }
    const t = raw as Record<string, unknown>;
    const kind = t['kind'];
    const providerId = typeof t['providerId'] === 'string' ? (t['providerId'] as string).trim() : '';
    if (!providerId) {
      return writeJsonError(res, 400, 'target.providerId is required');
    }
    if (kind === 'provider') {
      const cfg = loadConfig(deps.configPath);
      if (!cfg.providers.some((p) => p.id === providerId)) {
        return writeJsonError(res, 404, `provider '${providerId}' not found`);
      }
    } else if (kind === 'account' || kind === 'account-group' || kind === 'account-pool') {
      if (providerId !== 'claude' && providerId !== 'kimi') {
        return writeJsonError(
          res,
          400,
          `subscription provider '${providerId}' cannot be direct-bound: its upstream wire differs ` +
            `from the client wire (translation required — use a downstream route); only claude and ` +
            `kimi subscriptions speak the same Anthropic Messages wire as the client`,
        );
      }
      if (kind === 'account' && typeof t['accountId'] !== 'string') {
        return writeJsonError(res, 400, 'target.accountId is required for kind account');
      }
      if (kind === 'account-group' && typeof t['group'] !== 'string') {
        return writeJsonError(res, 400, 'target.group is required for kind account-group');
      }
    } else {
      return writeJsonError(res, 400, 'target.kind must be provider, account, account-group, or account-pool');
    }
    const target = raw as unknown as GatewayBindingTarget;
    const ok = await deps.keyDb.outboundApiKeysSetUpstream(id, target);
    return writeJson(res, ok ? 200 : 404, { ok, target });
  }
  if (method === 'POST' && id && action === 'policy') {
    const body = await readJsonBody(req);
    const parsed = parseKeyPolicyBody(body);
    if (!parsed.ok) return writeJsonError(res, 400, parsed.message);
    const ok = await deps.keyDb.outboundApiKeysSetPolicy(id, parsed.policy);
    return writeJson(res, ok ? 200 : 404, { ok });
  }

  // UPSTREAM ROUTING MODEL — POST /keys/:id/upstream-binding
  // `{ binding: null | { mode: 'all' } | { mode: 'explicit', targets: [...] } }`.
  // `null` rolls the key back to the legacy downstream-route semantics;
  // an explicit EMPTY list deliberately binds nothing (403 per request).
  if (method === 'POST' && id && action === 'upstream-binding') {
    const body = await readJsonBody(req);
    const raw = body['binding'] === undefined ? body : body['binding'];
    if (raw === null) {
      const ok = await deps.keyDb.outboundApiKeysSetUpstreamBinding(id, null);
      if (!ok) return writeJson(res, 404, { ok: false });
      await reapplyLiveServerConfig(deps);
      return writeJson(res, 200, { ok: true, upstreamBinding: null });
    }
    const parsed = parseKeyUpstreamBinding(raw, await listUpstreamCatalog(deps));
    if (!parsed.ok) return writeJsonError(res, 400, parsed.message);
    const ok = await deps.keyDb.outboundApiKeysSetUpstreamBinding(id, parsed.binding);
    if (!ok) return writeJson(res, 404, { ok: false });
    await reapplyLiveServerConfig(deps);
    return writeJson(res, 200, { ok: true, upstreamBinding: parsed.binding });
  }

  return writeJsonError(res, 405, `method ${method} not allowed on keys`);
}

/** Parse + validate a key upstream binding against the live upstream catalog. */
function parseKeyUpstreamBinding(
  raw: unknown,
  catalog: Array<{ target: GatewayBindingTarget }>,
): { ok: true; binding: KeyUpstreamBinding } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'binding must be an object or null' };
  }
  const value = raw as Record<string, unknown>;
  const knownTargets = new Set(catalog.map((entry) => JSON.stringify(entry.target)));
  if (value['mode'] === 'all') return { ok: true, binding: { mode: 'all' } };
  if (value['mode'] !== 'explicit') {
    return { ok: false, message: "binding.mode must be 'all' or 'explicit'" };
  }
  if (!Array.isArray(value['targets'])) {
    return { ok: false, message: 'binding.targets must be an array' };
  }
  if (value['targets'].length > 32) {
    return { ok: false, message: 'binding.targets cannot exceed 32 upstreams' };
  }
  const targets: GatewayBindingTarget[] = [];
  for (const entry of value['targets']) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, message: 'each target must be an object' };
    }
    const kind = (entry as Record<string, unknown>)['kind'];
    const providerId = (entry as Record<string, unknown>)['providerId'];
    if (kind !== 'provider' && kind !== 'account-pool') {
      return { ok: false, message: "target.kind must be 'provider' or 'account-pool'" };
    }
    if (typeof providerId !== 'string' || providerId.trim() === '') {
      return { ok: false, message: 'target.providerId is required' };
    }
    const target = { kind, providerId: providerId.trim() } as GatewayBindingTarget;
    if (!knownTargets.has(JSON.stringify(target))) {
      return { ok: false, message: `unknown upstream '${providerId}' (kind ${kind})` };
    }
    if (targets.some((existing) => JSON.stringify(existing) === JSON.stringify(target))) continue;
    targets.push(target);
  }
  return { ok: true, binding: { mode: 'explicit', targets } };
}

/**
 * Re-apply the outbound server config with DERIVED bindings after any
 * key/upstream/mapping mutation. Keeps the listener's running state as-is
 * (the live `running` flag wins over the stored `enabled` toggle, so a
 * re-derive can never silently stop or start the gateway).
 */
async function reapplyLiveServerConfig(deps: AdminApiDeps): Promise<void> {
  const serverConfig = await loadServerConfig(deps.settingsStore);
  await deps.outboundApiServer.applyConfig({
    ...outboundServerConfigInput(serverConfig),
    enabled: deps.outboundApiServer.getStatus().running || serverConfig.enabled,
    bindings: await assembledGatewayBindings(deps, serverConfig),
  });
}

// ── Upstream routing model (catalog + mapping tables) ────────────────────────

/**
 * `GET /admin/api/upstreams` → the upstream catalog (providers + subscription
 * pools) with each entry's mapping table. `PUT /admin/api/upstreams/:key/mappings`
 * `{ mappings: [...] }` replaces one table (write-edge validation: non-blank
 * unique sources; >1 name rows without a `*` wildcard → 400).
 */
async function handleUpstreams(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET' && rest.length === 0) {
    const [catalog, serverConfig] = await Promise.all([
      listUpstreamCatalog(deps),
      loadServerConfig(deps.settingsStore),
    ]);
    const mappings = resolveUpstreamModelMappings(serverConfig, loadConfig(deps.configPath).providers, catalog);
    const force = serverConfig.upstreamModelMappingForce ?? {};
    return writeJson(res, 200, {
      upstreams: catalog.map((entry) => ({
        key: entry.key,
        label: entry.label,
        target: entry.target,
        mappings: mappings[entry.key] ?? [],
        // STRICT is the default (absent ⇒ strict): AUTO (reported false) is the
        // explicit `force: false` opt-out with declared-model passthrough via
        // derived identity rows; the stored table above is what the editor
        // edits (never the derived rows — they'd be unreadable noise).
        force: force[entry.key] !== false,
      })),
      // The derived + legacy aggregate actually being served (the UI's launch
      // target picker and route coverage read this instead of the stored
      // `server.bindings`, which only carries the legacy routes).
      liveBindings: await assembledGatewayBindings(deps, serverConfig),
    });
  }
  if (method === 'PUT' && rest.length === 2 && rest[1] === 'mappings') {
    const key = decodeURIComponent(rest[0]).trim();
    if (key === '') return writeJsonError(res, 400, 'upstream key is required');
    const catalog = await listUpstreamCatalog(deps);
    // The SERVING catalog excludes modelless/disabled providers, but their
    // mapping tables are still legit edit targets (edit-ahead-of-enablement;
    // create-time discovery fills the model list moments later). Accept any
    // configured BYO provider id; subscription pools stay catalog-gated.
    const knownProvider = !key.startsWith('sub:')
      && loadConfig(deps.configPath).providers.some((provider) => provider.id === key);
    if (!catalog.some((entry) => entry.key === key) && !knownProvider) {
      return writeJsonError(res, 404, `unknown upstream '${key}'`);
    }
    const body = await readJsonBody(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'mappings')) {
      return writeJsonError(res, 400, 'body must contain mappings');
    }
    const invalid = validateUpstreamMappingTable(body['mappings']);
    if (invalid) return writeJsonError(res, 400, invalid);
    const rows = sanitizeUpstreamMappingRows(body['mappings']);
    const current = await loadServerConfig(deps.settingsStore);
    const tables = { ...(current.upstreamModelMappings ?? {}) };
    // Persist an explicit passthrough choice so default resolution cannot
    // recreate a table the operator deliberately cleared.
    tables[key] = rows;
    // The strict-mapping flag rides the same PUT: absent keeps the stored
    // value (an editor that doesn't know about force can't clobber it). STRICT
    // is the default (absent flag ⇒ strict), so an explicit `false` must be
    // PERSISTED — deleting it would silently re-enable strict on the next read.
    const forceTable = { ...(current.upstreamModelMappingForce ?? {}) };
    if (Object.prototype.hasOwnProperty.call(body, 'force')) {
      forceTable[key] = body['force'] === true;
    }
    const next = {
      ...current,
      upstreamModelMappings: Object.keys(tables).length > 0 ? tables : undefined,
      upstreamModelMappingForce: Object.keys(forceTable).length > 0 ? forceTable : undefined,
    };
    await saveServerConfig(deps.settingsStore, next);
    await reapplyLiveServerConfig(deps);
    return writeJson(res, 200, { ok: true, key, mappings: rows, force: forceTable[key] !== false });
  }
  // P4 (D7): the one-time legacy→upstream-model conversion. The stored legacy
  // routes are NOT removed — rollback is wholesale below or per key.
  if (method === 'POST' && rest.length === 1 && rest[0] === 'migrate-legacy') {
    const result = await migrateLegacyUpstreamRouting(deps);
    await reapplyLiveServerConfig(deps);
    return writeJson(res, 200, { ok: true, ...result });
  }
  // P4 (D7): the wholesale rollback — every key returns to the stored legacy
  // routes (its `upstreamBinding` field is cleared, nothing is deleted).
  if (method === 'POST' && rest.length === 1 && rest[0] === 'rollback-legacy') {
    const result = await rollbackLegacyUpstreamRouting(deps);
    await reapplyLiveServerConfig(deps);
    return writeJson(res, 200, { ok: true, cleared: result.cleared });
  }
  return writeJsonError(res, 405, `method ${method} not allowed on upstreams`);
}

// ── Server config (live apply) ────────────────────────────────────────────────

/**
 * Strictly range-validate the queue config segments PRESENT in a `PUT /server`
 * patch (§1 ranges, planning-context). Deliberately stricter than core's lenient
 * `normalizeQueueSegments` clamp — an operator write gets a clear error, not a
 * silently coerced value. Only validates segments actually present in the patch
 * (a partial PUT stays partial). Returns a list of field errors (empty = valid).
 */
function validateQueueSegments(patch: Partial<OutboundApiServerConfig>): string[] {
  const errors: string[] = [];
  const checkNum = (label: string, value: unknown, min: number, max: number): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      errors.push(`${label} must be a number ${min}..${max}`);
    }
  };
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  // A PRESENT segment must be a plain object before we deref its fields — an
  // explicit `null` / string / array otherwise dereferences null → TypeError →
  // 500; reject it as a 400 like any other malformed input.
  const umq: unknown = patch.userMessageQueue;
  if (umq !== undefined) {
    if (!isPlainObject(umq)) {
      errors.push('userMessageQueue must be an object');
    } else {
      if (typeof umq.enabled !== 'boolean') {
        errors.push('userMessageQueue.enabled must be a boolean');
      }
      checkNum('userMessageQueue.delayMs', umq.delayMs, 0, 10_000);
      checkNum('userMessageQueue.waitTimeoutMs', umq.waitTimeoutMs, 1000, 300_000);
    }
  }

  const cq: unknown = patch.concurrencyQueue;
  if (cq !== undefined) {
    if (!isPlainObject(cq)) {
      errors.push('concurrencyQueue must be an object');
    } else {
      checkNum('concurrencyQueue.maxQueueSizeFactor', cq.maxQueueSizeFactor, 1, 10);
      checkNum('concurrencyQueue.minQueueSize', cq.minQueueSize, 1, 100);
      checkNum('concurrencyQueue.waitTimeoutMs', cq.waitTimeoutMs, 1000, 300_000);
    }
  }

  // Subscription account-health segment (subscription-account-health, LEAD OQ1).
  const ah: unknown = patch.accountHealth;
  if (ah !== undefined) {
    if (!isPlainObject(ah)) {
      errors.push('accountHealth must be an object');
    } else {
      if (typeof ah.overloadCooldownEnabled !== 'boolean') {
        errors.push('accountHealth.overloadCooldownEnabled must be a boolean');
      }
      checkNum('accountHealth.overloadCooldownMs', ah.overloadCooldownMs, 60_000, 3_600_000);
    }
  }

  return errors;
}

function validateAllowanceSchedulingSegment(
  patch: Partial<OutboundApiServerConfig>,
): string[] {
  const value: unknown = patch.allowanceScheduling;
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['allowanceScheduling must be an object'];
  }
  const allowance = value as Record<string, unknown>;
  const errors: string[] = [];
  const checkNumber = (field: string, min: number, max: number): void => {
    const candidate = allowance[field];
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate < min ||
      candidate > max
    ) {
      errors.push(`allowanceScheduling.${field} must be a number ${min}..${max}`);
    }
  };
  if (typeof allowance.enabled !== 'boolean') {
    errors.push('allowanceScheduling.enabled must be a boolean');
  }
  checkNumber('demoteAtPercent', 0, 100);
  checkNumber('pauseAtPercent', 0, 100);
  checkNumber('priorityPenalty', 1, 1_000);
  if (
    typeof allowance.demoteAtPercent === 'number' &&
    typeof allowance.pauseAtPercent === 'number' &&
    allowance.pauseAtPercent < allowance.demoteAtPercent
  ) {
    errors.push('allowanceScheduling.pauseAtPercent must be >= demoteAtPercent');
  }
  return errors;
}

function applyLiveServerConfigEffects(
  config: OutboundApiServerConfig,
  deps: AdminApiDeps,
): void {
  setServerProxyConfig(config.proxy);
  getSharedAccountAllowanceScheduling().configure(config.allowanceScheduling);
  deps.allowanceRefreshScheduler?.configure(config.allowanceScheduling);
  applyWebhookConfig(config.webhook);
  applyAuditConfig(config.audit);
  applyBillingConfig(config.billing);
}

function outboundServerConfigInput(
  config: OutboundApiServerConfig,
): Parameters<OutboundApiServer['prepareConfig']>[0] {
  return {
    enabled: config.enabled,
    networkBinding: config.networkBinding,
    imagesEnabled: config.images?.enabled === true,
    endpoints: config.endpoints,
    bindings: config.bindings,
    port: config.port,
    userMessageQueue: config.userMessageQueue,
    concurrencyQueue: config.concurrencyQueue,
    voucher: config.voucher,
    anthropic: config.anthropic,
    search: config.search,
    modelNaming: config.modelNaming,
  };
}

/** GET sentinel for storage credentials that are configured but never leaked. */
const IMAGES_STORAGE_SECRET_SET = '__SET__';
const IMAGES_STORAGE_CREDENTIAL_KEYS = ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const;

function projectImagesConfigForAdmin(config: OutboundApiServerConfig): OutboundApiServerConfig {
  if (!config.images) return config;
  const { storageRoot, ...references } = config.images.references;
  const { storage, ...images } = config.images;
  return {
    ...config,
    images: {
      ...images,
      references: {
        ...references,
        ...(storageRoot ? { storageRootConfigured: true } : {}),
      },
      ...(storage
        ? {
            storage: {
              ...storage,
              ...Object.fromEntries(
                IMAGES_STORAGE_CREDENTIAL_KEYS.map((key) => [
                  key,
                  storage[key] ? IMAGES_STORAGE_SECRET_SET : '',
                ])
              ),
            },
          }
        : {}),
    } as OutboundApiServerConfig['images'],
  };
}

/**
 * Admin Images views omit the machine path and mask storage credentials. An
 * Images PUT that omits the path keeps the current root; explicit JSON null
 * selects the daemon default. Storage credential fields that are absent or
 * still carry the GET sentinel keep their stored values, so a round-tripped
 * admin view never wipes secrets. Strict validation still runs on the
 * reconstructed complete segment.
 */
function preserveImagesAdminOmissions(
  value: unknown,
  current: OutboundApiServerConfig['images'],
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const images = value as Record<string, unknown>;
  const referencesValue = images['references'];
  if (referencesValue && typeof referencesValue === 'object' && !Array.isArray(referencesValue)) {
    const references = { ...(referencesValue as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(references, 'storageRoot')) {
      if (references['storageRoot'] === null) delete references['storageRoot'];
    } else if (current?.references.storageRoot) {
      references['storageRoot'] = current.references.storageRoot;
    }
    images['references'] = references;
  }
  const storageValue = images['storage'];
  if (
    storageValue &&
    typeof storageValue === 'object' &&
    !Array.isArray(storageValue) &&
    current?.storage
  ) {
    const storage = { ...(storageValue as Record<string, unknown>) };
    for (const key of IMAGES_STORAGE_CREDENTIAL_KEYS) {
      const incoming = storage[key];
      if (incoming === undefined || incoming === IMAGES_STORAGE_SECRET_SET) {
        if (current.storage[key]) storage[key] = current.storage[key];
        else delete storage[key];
      }
    }
    images['storage'] = storage;
  }
  return images;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function imageConfigurationAuditFields(
  previous: ImagesServerConfig | undefined,
  next: ImagesServerConfig | undefined,
): ImageConfigurationAuditField[] {
  const before = previous ?? DEFAULT_IMAGES_SERVER_CONFIG;
  const after = next ?? DEFAULT_IMAGES_SERVER_CONFIG;
  const fields: ImageConfigurationAuditField[] = [];
  if (before.enabled !== after.enabled) fields.push('enablement');
  if (!sameConfigValue(before.models, after.models)) fields.push('provider');
  if (
    before.defaultModel !== after.defaultModel ||
    !sameConfigValue(before.aliases, after.aliases) ||
    !sameConfigValue(before.codex, after.codex)
  ) fields.push('model');
  if (!sameConfigValue(before.account, after.account)) fields.push('account');
  if (!sameConfigValue(before.queue, after.queue)) fields.push('queue');
  if (!sameConfigValue(before.temporary, after.temporary)) fields.push('temporary');
  if (!sameConfigValue(before.limits, after.limits)) fields.push('limits');
  const { storageRoot: beforeStorage, ...beforeRetention } = before.references;
  const { storageRoot: afterStorage, ...afterRetention } = after.references;
  if (!sameConfigValue(beforeRetention, afterRetention)) fields.push('retention');
  if (beforeStorage !== afterStorage || !sameConfigValue(before.storage, after.storage)) {
    fields.push('storage');
  }
  if (!sameConfigValue(before.remote, after.remote)) fields.push('remote');
  if (before.evidenceTtlMs !== after.evidenceTtlMs) fields.push('evidence');
  return fields;
}

function currentImageGenerationId(deps: AdminApiDeps): string | undefined {
  try {
    return deps.imageRuntimeStatus?.status().current.generationId;
  } catch {
    return undefined;
  }
}

async function handleServer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET') {
    const config = await loadServerConfig(deps.settingsStore);
    // upstream-proxy + webhook-notifications: mask proxy passwords AND webhook
    // destination secrets in the GET view — never leak plaintext.
    let server = config;
    if (config.proxy) server = { ...server, proxy: redactOutboundProxy(config.proxy) };
    if (config.webhook) server = { ...server, webhook: redactWebhookConfig(config.webhook) };
    // billing-event-stream: mask the HMAC secret in the GET view — never leak plaintext.
    if (config.billing) server = { ...server, billing: redactBillingConfig(config.billing) };
    // search-settings-ui: mask the search provider secrets the same way —
    // presence markers carry "a key is stored", never values.
    if (config.search) {
      server = {
        ...server,
        search: redactSearchServerConfig(config.search) as unknown as OutboundApiServerConfig['search'],
      };
    }
    return writeJson(res, 200, { server: projectImagesConfigForAdmin(server) });
  }
  if (method === 'PUT') {
    const patch = (await readJsonBody(req)) as Partial<OutboundApiServerConfig>;
    // Strict queue-segment validation BEFORE any merge/persist: an illegal value
    // in a PRESENT segment → 400 and nothing is written (unlike core's lenient
    // clamp). Segments absent from the patch are not validated (partial PUT).
    const queueErrors = validateQueueSegments(patch);
    if (queueErrors.length > 0) {
      return writeJsonError(res, 400, `invalid queue config: ${queueErrors.join('; ')}`);
    }
    const allowanceErrors = validateAllowanceSchedulingSegment(patch);
    if (allowanceErrors.length > 0) {
      return writeJsonError(
        res,
        400,
        `invalid allowance scheduling config: ${allowanceErrors.join('; ')}`,
      );
    }
    const bindingErrors = validateGatewayBindingsSegment(patch);
    if (bindingErrors.length > 0) {
      return writeJsonError(res, 400, `invalid gateway bindings: ${bindingErrors.join('; ')}`);
    }
    // webhook-notifications: strict validation of a present webhook segment (400
    // rather than a silent core-normalize drop).
    const webhookErrors = validateWebhookSegment(patch);
    if (webhookErrors.length > 0) {
      return writeJsonError(res, 400, `invalid webhook config: ${webhookErrors.join('; ')}`);
    }
    // request-audit-log: strict validation of a present audit segment (no secret,
    // so no preserve concern) — 400 rather than a silent core-normalize clamp.
    const auditErrors = validateAuditSegment(patch);
    if (auditErrors.length > 0) {
      return writeJsonError(res, 400, `invalid audit config: ${auditErrors.join('; ')}`);
    }
    // billing-event-stream: strict validation of a present billing segment.
    const billingErrors = validateBillingSegment(patch);
    if (billingErrors.length > 0) {
      return writeJsonError(res, 400, `invalid billing config: ${billingErrors.join('; ')}`);
    }
    const current = await loadServerConfig(deps.settingsStore);
    // upstream-proxy + webhook-notifications: the admin GET masks the proxy
    // passwords + webhook secrets, so an incoming PUT that edits other fields omits
    // them. Preserve the existing (decrypted) secret write-only when the patch
    // masks/blanks it — editing host/port/url/events never wipes the secret.
    let effectivePatch: Partial<OutboundApiServerConfig> = patch;
    if (patch.proxy) {
      effectivePatch = { ...effectivePatch, proxy: preserveOutboundProxySecrets(patch.proxy, current.proxy) };
    }
    if (patch.webhook) {
      effectivePatch = { ...effectivePatch, webhook: preserveWebhookSecrets(patch.webhook, current.webhook) };
    }
    // billing-event-stream: preserve the write-only HMAC secret when a PUT masks it.
    if (patch.billing) {
      effectivePatch = { ...effectivePatch, billing: preserveBillingSecret(patch.billing, current.billing) };
    }
    if (patch.images !== undefined) {
      const images = preserveImagesAdminOmissions(patch.images, current.images);
      const imageErrors = validateImagesAdminConfig(images, {
        remoteResolverAvailable: deps.imageRemoteResolverAvailable,
      });
      if (imageErrors.length > 0) {
        return writeJsonError(res, 400, `invalid Images config: ${imageErrors.join('; ')}`);
      }
      effectivePatch = { ...effectivePatch, images: images as OutboundApiServerConfig['images'] };
    }
    // plan 阶段5: the search section gets the same treatment as images — a
    // malformed section is REJECTED here rather than silently normalized, so an
    // operator learns about a typo at PUT time instead of discovering at
    // restart that a provider was quietly dropped.
    // search-settings-ui D2: secrets are WRITE-ONLY. Strip the admin-view
    // markers and re-attach stored values for omitted/blanked secret fields
    // BEFORE validation, so editing a host/policy/mode never wipes a key and a
    // masked round-trip (GET → edit → PUT) is lossless.
    if (patch.search !== undefined) {
      // `loadServerConfig` normalizes `search` in, so the fallback is inert —
      // typed optional, always present after a load.
      const searchPatch = preserveSearchSecrets(
        patch.search,
        current.search ?? DEFAULT_SEARCH_SERVER_CONFIG,
      );
      const searchErrors = validateSearchServerConfig(searchPatch);
      if (searchErrors.length > 0) {
        return writeJsonError(res, 400, `invalid search config: ${searchErrors.join('; ')}`);
      }
      effectivePatch = {
        ...effectivePatch,
        search: searchPatch as OutboundApiServerConfig['search'],
      };
    }
    const merged = mergeServerConfig(current, effectivePatch);
    const priorImageGenerationId = currentImageGenerationId(deps);
    try {
      await applyServerConfigTransaction(current, merged, {
        capturePersisted: () => deps.settingsStore.captureDocumentSnapshot(),
        prepare: async (previous, next) => {
          const changes: PreparedServerConfigChange[] = [];
          try {
            if (deps.imageRuntimeConfig && next.images) {
              changes.push(await deps.imageRuntimeConfig.prepareConfig(next.images));
            }
            changes.push({
              publish: () => applyLiveServerConfigEffects(next, deps),
              rollback: () => applyLiveServerConfigEffects(previous, deps),
              dispose: () => undefined,
            });
            changes.push(
              // UPSTREAM ROUTING MODEL: apply the DERIVED aggregate (per-key
              // upstream sets + upstream mappings + legacy routes for
              // unmigrated keys), never the stored routes alone.
              await deps.outboundApiServer.prepareConfig({
                ...outboundServerConfigInput(next),
                bindings: await assembledGatewayBindings(deps, next),
              }),
            );
            return changes;
          } catch (error) {
            for (const change of [...changes].reverse()) {
              try {
                await change.dispose();
              } catch {
                // The transaction surfaces the original preparation failure.
              }
            }
            throw error;
          }
        },
        persist: (next) => saveServerConfig(deps.settingsStore, next),
        restorePersisted: (snapshot) => deps.settingsStore.restoreDocumentSnapshot(snapshot),
      });
    } catch (error) {
      if (error instanceof ServerConfigTransactionError) {
        return writeJsonError(res, 500, error.message);
      }
      throw error;
    }
    // model-name-visibility: the Claude integration's discovery env tracks the
    // toggle — rewrite the installed file when the setting changed. Best-effort:
    // a failed rewrite surfaces as integration drift (never fails the save).
    if (current.modelNaming?.realNames !== merged.modelNaming?.realNames) {
      try {
        await deps.integrationManagerFactory?.().refreshInstalledClients();
      } catch {
        // The integration status panel reports the drift; the config save stands.
      }
    }
    const imageAuditFields = imageConfigurationAuditFields(current.images, merged.images);
    if (imageAuditFields.length > 0) {
      const nextImageGenerationId = currentImageGenerationId(deps);
      try {
        deps.imageConfigAudit?.({
          outcome: 'applied',
          fields: imageAuditFields,
          ...(priorImageGenerationId ? { previousGenerationId: priorImageGenerationId } : {}),
          ...(nextImageGenerationId ? { generationId: nextImageGenerationId } : {}),
        });
      } catch {
        // Observability must never turn an already-committed transaction into a false failure.
      }
    }
    // search-settings-ui: the PUT echo masks search secrets exactly like the
    // GET view — the merged config never crosses the wire with a secret VALUE.
    const mergedForAdmin = merged.search
      ? {
          ...merged,
          search: redactSearchServerConfig(merged.search) as unknown as OutboundApiServerConfig['search'],
        }
      : merged;
    return writeJson(res, 200, { server: projectImagesConfigForAdmin(mergedForAdmin) });
  }
  return writeJsonError(res, 405, `method ${method} not allowed on server`);
}

// ── Accounts (token-free GET status + secret-IN-never-OUT write) ───────────────

/**
 * `GET /admin/api/accounts` → token-free `listAll()` (UNCHANGED read path).
 * `PUT|POST /admin/api/accounts/:providerId` → validate the body to the
 * provider's token shape, write it via the least-authority writer, respond
 * STATUS-ONLY (the token-free `SubscriptionListEntry`).
 * `DELETE /admin/api/accounts/:providerId` → clear that provider's block.
 *
 * SECRET SPINE (design D5): the response NEVER serializes the request body or any
 * token field — only the token-free status. The write is auth-gated by
 * `AdminServer.dispatch` (constant-time `admin.token` + LAN fail-closed) like
 * every `/admin/*` route.
 */
async function handleAccounts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  // GET /accounts/route-activity — bounded, process-local, metadata-only history
  // of the credential that actually served each upstream attempt: subscription
  // pool accounts AND BYO provider API keys (key IDS only — never key strings).
  // Session keys are already one-way hashes; prompts, headers and tokens never
  // enter this store or response. `credentialKind` filters to
  // `subscription-account` or `provider-key` rows (absent ⇒ both).
  if (rest[0] === 'route-activity' && rest.length === 1) {
    if (method !== 'GET') {
      return writeJsonError(res, 405, `method ${method} not allowed on account route activity`);
    }
    const query = requestQuery(req);
    const parsedLimit = Number(query.get('limit') ?? '100');
    const kindParam = query.get('credentialKind');
    const credentialKind = kindParam === 'subscription-account' || kindParam === 'provider-key'
      ? kindParam
      : undefined;
    const records = getSharedAccountRouteActivity().list({
      providerId: query.get('providerId') ?? undefined,
      accountId: query.get('accountId') ?? undefined,
      sessionKey: query.get('sessionKey') ?? undefined,
      credentialKind,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 100,
    });
    return writeJson(res, 200, {
      available: true,
      records,
      capacity: ACCOUNT_ROUTE_ACTIVITY_LIMIT,
      collectedAt: Date.now(),
    });
  }

  // GET /accounts/overload-counters — bounded, process-local, metadata-only tally
  // of Codex server-overload events (`response.failed` with `server_is_overloaded`
  // / `slow_down`) per provider+account+endpoint. These arrive inside 200 streams
  // and so are invisible at the route-activity status layer; this counter is the
  // operator's "how often is account X overloaded, and is it worsening" view.
  // Counts + epoch timestamps only — no prompts, headers, or tokens.
  if (rest[0] === 'overload-counters' && rest.length === 1) {
    if (method !== 'GET') {
      return writeJsonError(res, 405, `method ${method} not allowed on overload counters`);
    }
    const query = requestQuery(req);
    const entries = getSharedOverloadCounter().list({
      providerId: query.get('providerId') ?? undefined,
      accountId: query.get('accountId') ?? undefined,
    });
    return writeJson(res, 200, {
      available: true,
      entries,
      collectedAt: Date.now(),
    });
  }

  // Account allowances are delegated to a focused handler before `allowances`
  // could be mistaken for a provider id. This surface never receives a token.
  if (rest[0] === 'allowances') {
    return handleAccountAllowanceApi(
      req,
      res,
      method,
      rest.slice(1),
      deps.accountAllowanceService,
    );
  }

  // GET /accounts/antigravity/models — the STATIC-PRIORITY merged antigravity
  // catalog (dynamic fetchAvailableModels discovery; denylist applied; the
  // static census wins conflicts). Secret-free: model ids + metadata only.
  if (method === 'GET' && rest[0] === 'antigravity' && rest[1] === 'models') {
    const result = await handleAntigravityModelsRoute({
      resolveAntigravityAccessToken:
        deps.resolveAntigravityAccessToken ?? (async () => null),
    });
    return writeJson(res, result.status, result.body);
  }

  // GET /accounts/opencodego/models?accountId=… — the LIVE zen-half
  // `/v1/models` list for one (or the ACTIVE) opencodego account. No static
  // preset exists for this provider; an unreachable upstream answers
  // `{ models: [], discovered: false, error }` (HTTP 200). Secret-free.
  if (method === 'GET' && rest[0] === 'opencodego' && rest[1] === 'models') {
    const result = await handleOpenCodeGoModelsRoute(
      { resolveAccount: deps.resolveOpenCodeGoModelsAccount ?? (async () => null) },
      requestQuery(req).get('accountId') ?? undefined,
    );
    return writeJson(res, result.status, result.body);
  }

  const service = accountAdminDeps(deps);
  const send = (result: ServiceResult): void => writeJson(res, result.status, result.body);

  // GET (no `:providerId`) → token-free list + sanitized per-provider accounts
  // arrays (design D8 — id/label/status/expiresAt/hasAccessToken/isActive only,
  // NEVER a raw token or `enc:` envelope) + external CLI presence booleans.
  if (method === 'GET' && rest.length === 0) return send(await listAccounts(service));

  // POST /accounts/batch — bounded, all-or-nothing management action across
  // provider pools. Matched before `batch` could be parsed as a provider id.
  if (method === 'POST' && rest[0] === 'batch' && rest.length === 1) {
    return send(await batchAccounts(service, await readJsonBody(req)));
  }

  // GET /accounts/{codex,kimi,grok,copilot,antigravity}/oauth/:sessionId/status →
  // token-free poll for the async sign-ins. Returns ONLY { state, message? }.
  if (method === 'GET' && isPolledOAuthProvider(rest[0]) && rest[1] === 'oauth' && rest[3] === 'status') {
    return send(oauthStatus(deps, rest[0], rest[2]));
  }

  if (method === 'DELETE' && isPolledOAuthProvider(rest[0]) && rest[1] === 'oauth' && rest[2]) {
    return send(cancelOAuth(deps, rest[0], rest[2]));
  }

  // GET /accounts/:providerId/:accountId/diagnostics — one account's bounded,
  // secret-free health/allowance diagnostic projection.
  if (method === 'GET' && rest.length === 3 && rest[2] === 'diagnostics') {
    return send(await accountDiagnostics(service, rest[0], rest[1]));
  }

  // GET /accounts/:providerId/:accountId/events — bounded, secret-free probe history.
  if (method === 'GET' && rest.length === 3 && rest[2] === 'events') {
    return send(await accountEvents(service, rest[0], rest[1]));
  }

  // PATCH /accounts/:providerId/:accountId — consolidated non-secret metadata
  // mutation. Deny-by-default validation rejects token-like or unknown fields.
  if (method === 'PATCH' && rest.length === 2) {
    if (!asSubscriptionProviderId(rest[0])) {
      return writeJsonError(res, 400, `unknown subscription provider '${rest[0] ?? ''}'`);
    }
    return send(await patchAccount(service, rest[0], rest[1], await readJsonBody(req)));
  }

  if (method === 'PUT' || method === 'POST' || method === 'DELETE') {
    const providerId = asSubscriptionProviderId(rest[0]);
    if (!providerId) {
      return writeJsonError(res, 400, `unknown subscription provider '${rest[0] ?? ''}'`);
    }

    // POST /accounts/:providerId/oauth/start → `{ authUrl, sessionId }` (+ the
    // device `userCode` for device-code flows). No secret crosses the wire.
    // Copilot alone reads a body (optional GitHub Enterprise domain).
    if (method === 'POST' && rest[1] === 'oauth' && rest[2] === 'start') {
      const body = providerId === 'copilot' ? await readJsonBody(req) : {};
      return send(await startOAuth(deps, providerId, body));
    }

    // POST /accounts/:providerId/oauth/complete { sessionId, code } → exchange +
    // persist (encrypted) + activate; respond ONLY the sanitized status.
    if (method === 'POST' && rest[1] === 'oauth' && rest[2] === 'complete') {
      return send(await completeOAuth(deps, providerId, await readJsonBody(req)));
    }

    // POST /accounts/:providerId/accounts → APPEND a new account (manual add).
    if (method === 'POST' && rest[1] === 'accounts') {
      return send(await addManualAccount(service, providerId, await readJsonBody(req)));
    }

    // POST /accounts/:providerId/import-external { label? } → copy the external
    // CLI's current login into a NEW account. claude/codex only.
    if (method === 'POST' && rest[1] === 'import-external') {
      if (providerId !== 'claude' && providerId !== 'codex') {
        return writeJsonError(res, 400, `provider '${providerId}' has no external CLI store`);
      }
      return send(await importExternalAccount(service, providerId, await readJsonBody(req)));
    }

    // POST /accounts/:providerId/refresh → refresh the ACTIVE account's token.
    if (method === 'POST' && rest[1] === 'refresh') {
      return send(await refreshAccount(service, providerId));
    }

    // Manual account test. Codex uses a real luna generation; other providers
    // retain the existing cheapest-first probe. The result remains secret-free.
    if (method === 'POST' && rest.length === 3 && rest[2] === 'test') {
      return send(await testAccount(service, providerId, rest[1]));
    }

    // POST /accounts/:providerId/:accountId/label { label } → rename one account.
    if (method === 'POST' && rest[2] === 'label') {
      return send(await renameAccount(service, providerId, rest[1], await readJsonBody(req)));
    }

    // POST /accounts/:providerId/:accountId/priority { priority }.
    if (method === 'POST' && rest[2] === 'priority') {
      return send(await setAccountPriority(service, providerId, rest[1], await readJsonBody(req)));
    }

    // POST /accounts/:providerId/:accountId/proxy { proxy: ProxyConfig | null }.
    if (method === 'POST' && rest[2] === 'proxy') {
      return send(await setAccountProxy(service, providerId, rest[1], await readJsonBody(req)));
    }

    // POST /accounts/:providerId/:accountId/supported-models { supportedModels }.
    if (method === 'POST' && rest[2] === 'supported-models') {
      return send(await setAccountSupportedModels(service, providerId, rest[1], await readJsonBody(req)));
    }

    // PUT /accounts/:providerId/active { id } → switch active account (STATUS-ONLY).
    if (method === 'PUT' && rest[1] === 'active') {
      return send(await setActiveAccount(service, providerId, await readJsonBody(req)));
    }

    // DELETE /accounts/:providerId/:accountId → remove one account (STATUS-ONLY).
    if (method === 'DELETE' && rest.length === 2) {
      return send(await removeAccount(service, providerId, rest[1]));
    }

    // DELETE /accounts/:providerId → clear the whole provider block.
    if (method === 'DELETE' && rest.length === 1) {
      return send(await clearProviderAccounts(service, providerId));
    }

    if (method === 'DELETE') {
      return writeJsonError(res, 405, 'method DELETE not allowed on this accounts path');
    }

    return send(await writeProviderTokens(service, providerId, await readJsonBody(req)));
  }

  return writeJsonError(res, 405, `method ${method} not allowed on accounts`);
}

/** The account service's deps over the live daemon handles. */
function accountAdminDeps(deps: AdminApiDeps): AccountAdminDeps {
  return {
    subscriptionAccounts: deps.subscriptionAccounts,
    subscriptionTokenWriter: deps.subscriptionTokenWriter,
    subscriptionAccountAppender: deps.subscriptionAccountAppender,
    accountAllowanceService: deps.accountAllowanceService,
    accountProbeService: deps.accountProbeService,
  };
}

// ── Code CLI launch (dashboard parity) ────────────────────────────────────────

/**
 * `GET /cli` → per-CLI availability (PATH probe). `POST /cli/:cli/launch
 * { providerId?, model?, cwd? }` → open a terminal running the CLI pointed at the
 * daemon proxy (route-token env — never a provider key). `GET /cli/sessions` /
 * `DELETE /cli/sessions/:id` → list / stop the registered launches.
 */
async function handleCli(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (method === 'GET' && rest.length === 0) {
    const result = handleCliList(process.platform, deps.cliPathProbe);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'GET' && rest[0] === 'sessions') {
    const result = handleCliSessions();
    return writeJson(res, result.status, result.body);
  }
  if (method === 'GET' && rest[0] === 'versions') {
    const result = await handleCliVersions(process.platform, deps.cliPathProbe, deps.cliVersionRunner);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'DELETE' && rest[0] === 'sessions' && rest[1]) {
    const result = handleCliStop(rest[1]);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'POST' && rest[1] === 'install') {
    const cli = rest[0];
    if (!isTrackedCliId(cli)) {
      return writeJsonError(res, 400, `unknown cli '${cli ?? ''}'`);
    }
    const result = await handleCliInstall(cli, deps.cliCommandRunner);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'POST' && rest[1] === 'upgrade') {
    const cli = rest[0];
    if (!isTrackedCliId(cli)) {
      return writeJsonError(res, 400, `unknown cli '${cli ?? ''}'`);
    }
    const result = await handleCliUpgrade(cli, deps.cliCommandRunner, deps.cliVersionRunner);
    return writeJson(res, result.status, result.body);
  }
  if (method === 'POST' && rest[1] === 'launch') {
    const cli = rest[0];
    // Tracked-but-install-only ids pass through — handleCliLaunch answers those
    // with a clearer "install-only" 400 than a generic unknown-id one.
    if (!isTrackedCliId(cli)) {
      return writeJsonError(res, 400, `unknown cli '${cli ?? ''}'`);
    }
    const body = await readJsonBody(req);
    const providers = loadConfig(deps.configPath).providers ?? [];
    // Key-scoped codex launches need the live gateway state + key store; read
    // both per request (same fresh-read discipline as integrationManagerFactory).
    const codexAuthHelper = deps.codexAuthHelper;
    const keyScoped = codexAuthHelper
      ? await (async () => {
          const gateway = deps.outboundApiServer.getStatus();
          const serverConfig = await loadServerConfig(deps.settingsStore);
          return {
            keyDb: deps.keyDb,
            // Derived + legacy aggregate — a key-scoped launch on a migrated
            // key must preflight against its DERIVED candidates.
            bindings: await assembledGatewayBindings(deps, serverConfig),
            gatewayRunning: gateway.running,
            gatewayBaseUrl: gateway.loopbackUrl ?? `http://127.0.0.1:${gateway.port}`,
            codexAuthHelper,
          };
        })()
      : undefined;
    const result = await handleCliLaunch(cli, body, {
      llmConfig: deps.llmConfig,
      providers,
      routeLeaseManager: deps.routeLeaseManager,
      keyScoped,
      opener: deps.cliTerminalOpener,
      probe: deps.cliPathProbe,
    });
    return writeJson(res, result.status, result.body);
  }
  return writeJsonError(res, 405, `method ${method} not allowed on cli`);
}

// ── Status ────────────────────────────────────────────────────────────────────

// Native CLI persistent gateway integration. Never returns the gateway secret.
async function handleIntegrations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  const factory = deps.integrationManagerFactory;
  if (!factory) return writeJsonError(res, 501, 'native CLI integration is not available');
  const manager = factory();
  try {
    if (method === 'GET' && rest.length === 0) {
      return writeJson(res, 200, {
        integrations: await manager.listStatus(),
        gateway: deps.outboundApiServer.getStatus(),
      });
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'rotate') {
      await manager.rotateGatewayKey();
      return writeJson(res, 200, { ok: true, integrations: await manager.listStatus() });
    }
    const client = rest[0];
    if (!isIntegrationClient(client)) {
      return writeJsonError(res, 400, `unknown integration client '${client ?? ''}'`);
    }
    if (method === 'POST' && rest[1] === 'key') {
      const body = await readJsonBody(req);
      if (Object.keys(body).length !== 1 || typeof body.keyId !== 'string' || !body.keyId.trim()) {
        return writeJsonError(res, 400, 'body must contain a non-empty keyId string');
      }
      const status = await manager.bindIntegrationKey(client, body.keyId.trim());
      return writeJson(res, 200, { integration: status });
    }
    if (method === 'POST' && rest[1] === 'plan') {
      const body = await readJsonBody(req);
      const configPath = body.configPath;
      if (configPath !== undefined && typeof configPath !== 'string') {
        return writeJsonError(res, 400, 'configPath must be a string');
      }
      const plan = await manager.plan(client, configPath);
      return writeJson(res, 200, { plan });
    }
    if (method === 'POST' && (rest[1] === 'install' || rest[1] === 'apply')) {
      const body = await readJsonBody(req);
      const configPath = body.configPath;
      if (configPath !== undefined && typeof configPath !== 'string') {
        return writeJsonError(res, 400, 'configPath must be a string');
      }
      const status = await manager.install(client, configPath);
      return writeJson(res, 200, { integration: status });
    }
    if (method === 'POST' && rest[1] === 'repair') {
      const status = await manager.repair(client);
      return writeJson(res, 200, { integration: status });
    }
    if ((method === 'DELETE' && rest.length === 1) || (method === 'POST' && rest[1] === 'remove')) {
      const status = await manager.remove(client);
      return writeJson(res, 200, { integration: status });
    }
    return writeJsonError(res, 405, `method ${method} not allowed on integrations`);
  } catch (error) {
    if (error instanceof IntegrationConflictError) {
      return writeJsonError(res, 409, error.message);
    }
    throw error;
  }
}

function isIntegrationClient(value: string | undefined): value is IntegrationClientId {
  return value === 'codex' || value === 'claude';
}

async function integrationKeyRequirement(
  deps: AdminApiDeps,
  keyId: string,
): Promise<string | undefined> {
  const factory = deps.integrationManagerFactory;
  if (!factory) return undefined;
  const bound = (await factory().listStatus()).filter((status) => status.key?.id === keyId);
  if (bound.length === 0) return undefined;
  return `key '${keyId}' is bound to a CLI integration; select another key or remove the integration first`;
}

const IMAGE_ADMIN_STATUS_TENANT = 'admin:image-capability-status';

function safeStatusCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value)
    : 0;
}

function safeStatusTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

const SAFE_IMAGE_CAPABILITY_REASONS = new Set<string>([
  ...IMAGE_CAPABILITY_UNAVAILABLE_REASONS,
  'disabled',
  'runtime_unavailable',
]);

function safeImageCapabilityReason(value: unknown): string {
  return typeof value === 'string' && SAFE_IMAGE_CAPABILITY_REASONS.has(value)
    ? value
    : 'runtime_unavailable';
}

function safeImageGenerationId(value: unknown): string {
  return typeof value === 'string' && /^image-runtime-\d+$/.test(value)
    ? value
    : 'image-runtime-unavailable';
}

function safeCapabilityValues(values: ImageCapabilities | undefined, configuredModel: string) {
  const allowedFormats = new Set(['png', 'jpeg', 'webp']);
  const allowedQuality = new Set(['auto', 'low', 'medium', 'high']);
  const allowedModeration = new Set(['auto', 'low']);
  const compression = values?.outputCompression;
  return Object.freeze({
    available: values?.available === true,
    models: Object.freeze(values?.models.includes(configuredModel) ? [configuredModel] : []),
    generate: values?.generate === true,
    edit: values?.edit === true,
    maskEdit: values?.maskEdit === true,
    streaming: values?.streaming === true,
    transparentBackground: values?.transparentBackground === true,
    flexibleSizes: values?.flexibleSizes === true,
    responsesTool: values?.responsesTool === true,
    multiTurnEdit: values?.multiTurnEdit === true,
    supportsFileId: values?.supportsFileId === true,
    supportsImageUrl: values?.supportsImageUrl === true,
    maxInputImages: safeStatusCount(values?.maxInputImages),
    maxOutputImages: safeStatusCount(values?.maxOutputImages),
    maxPartialImages: safeStatusCount(values?.maxPartialImages),
    outputFormats: Object.freeze(
      (values?.outputFormats ?? []).filter((value) => allowedFormats.has(value)),
    ),
    qualityLevels: Object.freeze(
      (values?.qualityLevels ?? []).filter((value) => allowedQuality.has(value)),
    ),
    moderationModes: Object.freeze(
      (values?.moderationModes ?? []).filter((value) => allowedModeration.has(value)),
    ),
    outputCompression: compression?.supported === true
      ? Object.freeze({
          supported: true as const,
          formats: Object.freeze(compression.formats.filter((value) => allowedFormats.has(value))),
          min: safeStatusCount(compression.min),
          max: safeStatusCount(compression.max),
        })
      : Object.freeze({ supported: false as const }),
  });
}

function safeRuntimeResources(resources: ImageRuntimeResourceStatus | undefined) {
  if (!resources) return undefined;
  return Object.freeze({
    queue: Object.freeze({
      activeJobs: safeStatusCount(resources.queue.activeJobs),
      waitingJobs: safeStatusCount(resources.queue.waitingJobs),
      activeAccounts: safeStatusCount(resources.queue.activeAccounts),
      waitingAccounts: safeStatusCount(resources.queue.waitingAccounts),
      waitingTenants: safeStatusCount(resources.queue.waitingTenants),
      maxConcurrentJobsPerAccount: safeStatusCount(resources.queue.maxConcurrentJobsPerAccount),
      maxQueuedJobs: safeStatusCount(resources.queue.maxQueuedJobs),
      accepting: resources.queue.accepting === true,
      shuttingDown: resources.queue.shuttingDown === true,
    }),
    temporary: Object.freeze({
      activeScopes: safeStatusCount(resources.temporary.activeScopes),
      totalBytes: safeStatusCount(resources.temporary.totalBytes),
      tenantCount: safeStatusCount(resources.temporary.tenantCount),
      maxActiveScopes: safeStatusCount(resources.temporary.maxActiveScopes),
      maxTotalBytes: safeStatusCount(resources.temporary.maxTotalBytes),
      maxTenantBytes: safeStatusCount(resources.temporary.maxTenantBytes),
    }),
    storage: Object.freeze({
      mounts: safeStatusCount(resources.storage.mounts),
      retiredMounts: safeStatusCount(resources.storage.retiredMounts),
      referenceEntries: safeStatusCount(resources.storage.referenceEntries),
      referenceBytes: safeStatusCount(resources.storage.referenceBytes),
      referenceTombstones: safeStatusCount(resources.storage.referenceTombstones),
      stateCalls: safeStatusCount(resources.storage.stateCalls),
      stateResponses: safeStatusCount(resources.storage.stateResponses),
      stateTombstones: safeStatusCount(resources.storage.stateTombstones),
      pendingReferenceDeletes: safeStatusCount(resources.storage.pendingReferenceDeletes),
      maxReferenceEntries: safeStatusCount(resources.storage.maxReferenceEntries),
      maxReferenceBytes: safeStatusCount(resources.storage.maxReferenceBytes),
      maxTenantReferenceBytes: safeStatusCount(resources.storage.maxTenantReferenceBytes),
      maxStateCalls: safeStatusCount(resources.storage.maxStateCalls),
      maxStateResponses: safeStatusCount(resources.storage.maxStateResponses),
    }),
  });
}

function imageEndpointUrls(base: string | null) {
  return base
    ? Object.freeze({
        generations: `${base}/v1/images/generations`,
        edits: `${base}/v1/images/edits`,
      })
    : null;
}

/** Project one provider's evidence-age block (mirrors the default-provider derivation). */
function imageProviderEvidence(
  images: ImagesServerConfig,
  capabilities: { oldestEvidenceAt?: number; resolvedAt?: number } | undefined,
): { verifiedAt: number; ageMs: number; expiresAt?: number } | null {
  const evidenceAt = safeStatusTimestamp(capabilities?.oldestEvidenceAt);
  const resolvedAt = safeStatusTimestamp(capabilities?.resolvedAt);
  if (evidenceAt === undefined || resolvedAt === undefined) return null;
  const expiresAt = evidenceAt <= Number.MAX_SAFE_INTEGER - images.evidenceTtlMs
    ? evidenceAt + images.evidenceTtlMs
    : undefined;
  return Object.freeze({
    verifiedAt: evidenceAt,
    ageMs: Math.max(0, resolvedAt - evidenceAt),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

/**
 * POST /images/verify-live — the explicitly-consuming live verification
 * (images-settings-tab D3): the admin-HTTP twin of `doctor images --live`.
 * Rides the same AdminServer auth gate as every sibling endpoint; 501 when
 * the verifier dependency is not wired; the response carries stable safe
 * codes/metadata only and annotates Codex-only coverage when Antigravity
 * models are routed.
 */
async function handleImagesVerifyLive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: AdminApiDeps,
): Promise<void> {
  const verifier = deps.imageLiveVerifier;
  if (!verifier) {
    return writeJsonError(res, 501, 'Images live verification is not available');
  }
  const serverConfig = await loadServerConfig(deps.settingsStore);
  const images = serverConfig.images ?? DEFAULT_IMAGES_SERVER_CONFIG;
  // Drain the (empty) request body so the connection stays reusable, and tie
  // the consuming generation to the admin connection: a client disconnect
  // aborts the wait (the verifier's own timeout still bounds it).
  req.resume();
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const result = await verifier.verifyLive(images, controller.signal);
  const antigravityRouted = Object.values(images.models).includes('antigravity-subscription');
  return writeJson(res, 200, {
    ...result,
    ...(antigravityRouted ? { antigravityDeferred: true } : {}),
  });
}

async function handleImages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  rest: string[],
  deps: AdminApiDeps,
): Promise<void> {
  if (rest.length === 1 && rest[0] === 'verify-live') {
    if (method !== 'POST') {
      return writeJsonError(res, 405, `method ${method} not allowed on Images verify-live`);
    }
    return handleImagesVerifyLive(req, res, deps);
  }
  if (rest.length !== 1 || rest[0] !== 'capabilities') {
    return writeJsonError(res, 404, 'unknown Images admin resource');
  }
  if (method !== 'GET') {
    return writeJsonError(res, 405, `method ${method} not allowed on Images capabilities`);
  }
  const reader = deps.imageRuntimeStatus;
  if (!reader) return writeJsonError(res, 501, 'Images runtime status is not available');

  const serverConfig = await loadServerConfig(deps.settingsStore);
  const images = serverConfig.images ?? DEFAULT_IMAGES_SERVER_CONFIG;
  const lifecycle = reader.status();
  const capability = await reader.inspectCapability(IMAGE_ADMIN_STATUS_TENANT);
  const resources = safeRuntimeResources(reader.resourceStatus());
  const outbound = deps.outboundApiServer.getStatus();
  const evidence = imageProviderEvidence(images, capability.capabilities);
  // Per-provider rows (images-settings-tab D2): one card per provider the
  // routing table names, each with its own affirmed models and evidence age.
  const providers = (capability.providers ?? []).map((provider) => Object.freeze({
    providerId: provider.providerId,
    available: provider.available === true,
    reason: provider.available ? null : safeImageCapabilityReason(provider.reason),
    models: Object.freeze([...provider.models]),
    evidence: imageProviderEvidence(images, provider.capabilities),
  }));
  const draining = lifecycle.draining.map((generation) => Object.freeze({
    generationId: safeImageGenerationId(generation.generationId),
    enabled: generation.enabled,
    httpLeases: safeStatusCount(generation.httpLeases),
    hostedLeases: safeStatusCount(generation.hostedLeases),
  }));

  return writeJson(res, 200, {
    configured: {
      enabled: images.enabled,
      provider: images.models[images.defaultModel] ?? 'codex-subscription',
      model: images.defaultModel,
      remoteUrlsEnabled: images.remote.enabled,
      referenceTtlMs: images.references.ttlMs,
    },
    effective: {
      available: capability.available === true,
      reason: capability.available ? null : safeImageCapabilityReason(capability.reason),
      evidence,
      features: safeCapabilityValues(capability.capabilities, images.defaultModel),
    },
    providers,
    runtime: {
      disposed: lifecycle.disposed,
      generationId: safeImageGenerationId(lifecycle.current.generationId),
      drainingCount: draining.length,
      draining,
      ...(resources ? { resources } : {}),
    },
    endpoints: images.enabled ? imageEndpointUrls(outbound.loopbackUrl) : null,
    lanEndpoints: images.enabled ? imageEndpointUrls(outbound.lanUrl) : null,
  });
}

async function handleStatus(
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'GET') return writeJsonError(res, 405, `method ${method} not allowed on status`);
  const status = deps.outboundApiServer.getStatus();
  const serverConfig = await loadServerConfig(deps.settingsStore);
  // Class-aware read-only projection, one row per endpoint, merged across the
  // ENABLED downstream routes that serve it (routes are the only routing
  // source). Kind-mapped endpoints (`messages`/`responses`) summarize their
  // per-kind refs; `chat` projects its model list; role-based `gemini` projects
  // its default. The kind-mapped set is read from core's `isKindMappedEndpoint`
  // (SSOT over `ENDPOINT_MODEL_KINDS`) — no daemon-side hand-mirror.
  const endpoints = (['chat', 'responses', 'messages', 'gemini'] as const).map((endpoint) => {
    // Project through the resolver's own shape so refs are always the resolved
    // `"providerId,modelId"` (a route stores the bare id + its target).
    const routes = (serverConfig.bindings ?? [])
      .filter((binding) => binding.enabled && binding.endpoint === endpoint)
      .map((binding) => gatewayBindingToEndpointConfig(binding));
    const useSubscription = routes.some((route) => route.useSubscription);
    if (isKindMappedEndpoint(endpoint)) {
      const kinds: Record<string, string> = {};
      for (const route of routes) {
        for (const [kind, ref] of Object.entries(route.modelMap ?? {})) {
          if (ref?.trim() && !kinds[kind]) kinds[kind] = ref;
        }
      }
      return { endpoint, kinds, useSubscription };
    }
    if (endpoint === 'chat') {
      return {
        endpoint,
        models: [...new Set(routes.flatMap((route) => route.models ?? []))],
        useSubscription,
      };
    }
    return {
      endpoint,
      model: routes.find((route) => route.defaultModel?.trim())?.defaultModel ?? '',
      useSubscription,
    };
  });
  const imageRuntime = serverConfig.images?.enabled && deps.imageRuntimeStatus
    ? (() => {
        const lifecycle = deps.imageRuntimeStatus!.status();
        const resources = safeRuntimeResources(deps.imageRuntimeStatus!.resourceStatus());
        return {
          enabled: lifecycle.current.enabled,
          generationId: lifecycle.current.generationId,
          drainingCount: lifecycle.draining.length,
          ...(resources ? { resources } : {}),
        };
      })()
    : undefined;
  // Live queue-occupancy snapshot from the wire layer's frozen `getQueueStatus()`
  // — included only when the server is running (§4 allows omission otherwise), so
  // the field stays genuinely optional. Existing status fields are untouched.
  if (status.running) {
    const queueStatus = deps.outboundApiServer.getQueueStatus();
    return writeJson(res, 200, {
      ...status,
      endpoints,
      queueStatus,
      ...(imageRuntime ? { imageRuntime } : {}),
    });
  }
  return writeJson(res, 200, {
    ...status,
    endpoints,
    ...(imageRuntime ? { imageRuntime } : {}),
  });
}

// ── Playground (same-origin proxy to /v1/*) ───────────────────────────────────

/** Map an endpoint id + body to the outbound `/v1/*` path. */
function resolvePlaygroundPath(endpoint: string, body: Record<string, unknown>): string | null {
  switch (endpoint) {
    case 'chat':
      return '/v1/chat/completions';
    case 'responses':
      return '/v1/responses';
    case 'messages':
      return '/v1/messages';
    case 'gemini': {
      const model = typeof body['model'] === 'string' ? body['model'] : 'gemini-pro';
      return `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    }
    default:
      return null;
  }
}

async function handlePlayground(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  deps: AdminApiDeps,
): Promise<void> {
  if (method !== 'POST') return writeJsonError(res, 405, `method ${method} not allowed on playground`);
  const body = await readJsonBody(req);
  const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : '';
  const key = typeof body['key'] === 'string' ? body['key'] : '';
  const payload = body['body'];

  const status = deps.outboundApiServer.getStatus();
  if (!status.running || !status.port) return writeJsonError(res, 503, 'outbound server not running');
  const path = resolvePlaygroundPath(endpoint, isRecord(payload) ? payload : {});
  if (!path) return writeJsonError(res, 400, `unknown endpoint '${endpoint}'`);

  // Stringify the payload (accept a JSON object or a raw string).
  const upstreamBody = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});

  await proxyToOutbound(res, status.port, path, key, upstreamBody);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Server-side proxy to the outbound `/v1/*` server (same-origin from the
 * browser's view — design D5). Pipes the upstream status + headers + body back,
 * streaming so SSE passes through.
 */
function proxyToOutbound(
  res: http.ServerResponse,
  outboundPort: number,
  path: string,
  key: string,
  body: string,
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: outboundPort,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${key}`,
        },
      },
      (proxRes) => {
        const headers: http.OutgoingHttpHeaders = {};
        const ct = proxRes.headers['content-type'];
        if (ct) headers['Content-Type'] = ct;
        res.writeHead(proxRes.statusCode ?? 502, headers);
        proxRes.on('data', (chunk) => res.write(chunk));
        proxRes.on('end', () => {
          res.end();
          resolve();
        });
      },
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) writeJsonError(res, 502, `playground proxy failed: ${err.message}`);
      else res.end();
      resolve();
    });
    upstream.write(body);
    upstream.end();
  });
}
