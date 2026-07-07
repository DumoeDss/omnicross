/**
 * bootstrap.ts — `buildDaemon` wires `@omnicross/core`'s `ProviderProxy` +
 * `OutboundApiServer` STANDALONE (design D6).
 *
 * A DB-backed embedder wires the same `@omnicross/core` surface differently;
 * this standalone wiring makes SUBSTITUTIONS (file-backed ports replace
 * DB-backed ones) and SUBTRACTIONS:
 *  - no `CompletionService` (the BYO proxy path doesn't need it),
 *  - no `anthropicIngressHandlerFactory` (→ `/v1/messages` returns 502 by core's
 *    existing contract — no daemon code needed).
 * (`apiKeyPool` and `usageRecorder` are NO LONGER subtracted: the pool is wired
 * for multi-key load balancing, and the usage recorder is wired over the
 * file-backed pricing/usage stores so every served request is cost-stamped and
 * persisted to `usage-events.jsonl`.)
 *
 * `getProviderProxy` / `getOutboundApiServer` are module singletons, so the boot
 * smoke test calls `__resetProviderProxyForTests` / `__resetOutboundApiServerForTests`
 * (re-exported here) in `beforeEach`.
 *
 * @module @omnicross/daemon/bootstrap
 */

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';

import { DEFAULT_AUDIT_CONFIG } from '@omnicross/contracts/audit-types';
import { DEFAULT_BILLING_CONFIG } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import { getGeminiCodeAssistProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import {
  __resetOutboundApiServerForTests,
  DEFAULT_ACCOUNT_PROBE,
  getOutboundApiServer,
  type OutboundApiServer,
} from '@omnicross/core/outbound-api';
import { setSubscriptionRegistryForOutbound } from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { fetchUpstream, setUpstreamProxyResolver } from '@omnicross/core/pipeline/upstreamFetch';
import { __resetSharedIdentityStoreForTests } from '@omnicross/core/provider-proxy/identity/SubscriptionIdentityStore';
import { setGeminiCodeAssistResolver } from '@omnicross/core/ports/gemini-code-assist-resolver';
import {
  __resetProviderProxyForTests,
  getProviderProxy,
  type ProviderProxy,
} from '@omnicross/core/provider-proxy';
import { KeySpendTracker } from '@omnicross/core/outbound-api';
import { PricingEngine, UsageRecorder } from '@omnicross/core/usage';
import {
  type FetchLike,
  setSubscriptionAccountService,
  setSubscriptionProviderRegistry,
  SubscriptionAccountService,
  SubscriptionProviderRegistry,
} from '@omnicross/subscriptions';

import { type CodexLoopbackFn, CodexOAuthSessionStore } from './admin/accountsCodexOAuth';
import { AdminServer } from './admin/AdminServer';
import { buildHealthReport } from './admin/health';
import { DAEMON_VERSION } from './admin/version';
import type { CommandRunner, PathProbe, TerminalOpener } from './admin/cliLaunch';
import { OAuthSessionStore } from './admin/oauthSessions';
import { awaitLoopbackCode } from './commands/loopbackCallback';
import { type DaemonConfig, resolveAdminConfig, setSecretBox } from './config';
import { AutoDisableStore } from './pool/autoDisableStore';
import { createPoolKeysLoader, setSecretBox as setPoolSecretBox } from './pool/loadPoolKeys';
import { resolveEnvKey } from './pool/resolveEnvKey';
import {
  defaultAuditDir,
  defaultBillingDir,
  defaultPricingPath,
  defaultUsageEventsPath,
  defaultVouchersPath,
} from './commands/paths';
import { ConfigFileProviderConfigSource } from './ports/ConfigFileProviderConfigSource';
import { ConfigurableLogger } from './ports/ConfigurableLogger';
import { JsonApiServerSettingsStore } from './ports/JsonApiServerSettingsStore';
import { JsonlUsageEventStore } from './ports/JsonlUsageEventStore';
import { JsonOutboundKeyDb } from './ports/JsonOutboundKeyDb';
import { JsonPricingStore } from './ports/JsonPricingStore';
import { JsonVoucherDb } from './ports/JsonVoucherDb';
import { JsonSubscriptionCredentialStore } from './ports/JsonSubscriptionCredentialStore';
import { createUpstreamProxyResolver, setServerProxyConfig } from './proxy/upstreamProxyResolver';
import { AccountHealthProbeScheduler } from './AccountHealthProbeScheduler';
import { AccountHealthSweeper } from './AccountHealthSweeper';
import { AuditPruneSweeper } from './audit/AuditPruneSweeper';
import { readAuditRecords } from './audit/auditReader';
import { resetAuditRuntimeForTests, setAuditRuntime } from './audit/auditRuntime';
import { AuditWriter } from './audit/AuditWriter';
import { BillingPublisher } from './billing/BillingPublisher';
import { readBillingStatus } from './billing/billingReader';
import { resetBillingRuntimeForTests, setBillingRuntime } from './billing/billingRuntime';
import { BillingRetrySweeper } from './billing/BillingRetrySweeper';
import { decryptConfigSecrets, resolveMasterKey, SecretBox } from './secrets';
import { TokenRefreshScheduler } from './TokenRefreshScheduler';
import { WebhookDispatcher } from './webhook/WebhookDispatcher';
import { resetWebhookRuntimeForTests, setWebhookRuntime } from './webhook/webhookRuntime';

/** On-disk locations the file-backed ports persist to. */
export interface DaemonPaths {
  /** The config.json path (provider catalog + persisted `server` field). */
  configPath: string;
  /** The named-key json store path (sibling of config.json by convention). */
  keysPath: string;
  /** The subscription `tokens.json` store path (sibling of config.json by convention). */
  tokensPath: string;
  /**
   * OPTIONAL `--master-key-file` override for the at-rest master key (secrets
   * design D3). Absent → the default `~/.omnicross/master.key`. The
   * `OMNICROSS_MASTER_KEY` env still beats this when set.
   */
  masterKeyFilePath?: string;
  /**
   * TEST SEAM (optional, app-parity-2 child 5): override the codex loopback listener
   * so tests need not bind `127.0.0.1:1455`. Absent → the real `awaitLoopbackCode`.
   */
  codexAwaitLoopback?: CodexLoopbackFn;
  /**
   * TEST SEAM (optional): override the OAuth token-exchange fetch so tests need not
   * hit a real token endpoint. Absent → the global `fetch`.
   */
  oauthExchangeFetch?: FetchLike;
  /**
   * TEST SEAM (optional): override the Code CLI external-terminal opener so tests
   * never spawn a window. Absent → the real `defaultTerminalOpener`.
   */
  cliTerminalOpener?: TerminalOpener;
  /**
   * TEST SEAM (optional): override the Code CLI PATH probe so tests can fake an
   * installed CLI. Absent → the real PATH scan.
   */
  cliPathProbe?: PathProbe;
  /**
   * TEST SEAM (optional): override the Code CLI install command runner so tests
   * never invoke a real package manager. Absent → the real `exec`-based runner.
   */
  cliCommandRunner?: CommandRunner;
}

/** The constructed daemon handles the CLI commands operate on. */
export interface Daemon {
  /** The injected `Logger` port (a `ConfigurableLogger` built from `config.logging`). */
  readonly logger: Logger;
  readonly llmConfig: ConfigFileProviderConfigSource;
  readonly keyDb: JsonOutboundKeyDb;
  readonly settingsStore: JsonApiServerSettingsStore;
  readonly providerProxy: ProviderProxy;
  readonly outboundApiServer: OutboundApiServer;
  /**
   * Multi-key load balancer. Wired into the proxy deps slot
   * AND exposed here so the admin read-only key-health view can
   * read `getKeyHealth`. NOTE: outbound failover does NOT fire on
   * the daemon's null-session outbound path — v1 is cold-standby + observable.
   */
  readonly apiKeyPool: ApiKeyPoolService;
  /** In-memory 401/403 auto-disable store (design D5; read by the admin view). */
  readonly autoDisableStore: AutoDisableStore;
  /** File-backed subscription credential store (reads `tokens.json`). */
  readonly credentialStore: JsonSubscriptionCredentialStore;
  /** Subscription dispatch-profile registry (mirrored into core's outbound slot). */
  readonly subscriptionRegistry: SubscriptionProviderRegistry;
  /** Subscription account service (token-free `listAll`) — now exposed for the
   *  admin dashboard's read-only accounts panel (RT3). */
  readonly subscriptionAccounts: SubscriptionAccountService;
  /** File-backed pricing table (`pricing.json`; concrete for the admin DELETE). */
  readonly pricingStore: JsonPricingStore;
  /** Pricing engine (cost calc + source refresh + conflict resolution). */
  readonly pricingEngine: PricingEngine;
  /** Usage recorder over `usage-events.jsonl` — also the admin stats query facade. */
  readonly usageRecorder: UsageRecorder;
  /** The localhost admin/dashboard HTTP listener (RT3). Started by `start.ts`. */
  readonly adminServer: AdminServer;
  /**
   * Proactive background OAuth refresh sweep (external-cli-sync). NOT started
   * here — `start.ts` arms it for the resident daemon; the short-lived `launch`
   * boot leaves it off (the lazy strategy refresh covers a single session) but
   * still disposes it in cleanup.
   */
  readonly tokenRefreshScheduler: TokenRefreshScheduler;
  /**
   * Proactive account-health recovery sweep (subscription-account-health, D6).
   * NOT started here — `start.ts` arms it for the resident daemon; disposed in
   * cleanup. Correctness never depends on it (health self-heals lazily on read).
   */
  readonly accountHealthSweeper: AccountHealthSweeper;
  /**
   * Scheduled ACTIVE account-health probe (subscription-account-probe #8).
   * Constructed armed-off with default config (`enabled:false`); `start.ts`
   * `configure(...)`s it from the persisted `accountProbe` segment and starts it
   * ONLY when enabled. Disposed in cleanup.
   */
  readonly accountHealthProbeScheduler: AccountHealthProbeScheduler;
  /**
   * Fire-and-forget webhook sender (webhook-notifications). Wired into the core
   * emit sink + the #2 health signals by `start.ts`/admin PUT via
   * `applyWebhookConfig`. INERT until a config enables it (zero regression).
   */
  readonly webhookDispatcher: WebhookDispatcher;
  /**
   * File-backed audit sink (request-audit-log) — appends each captured record to
   * `audit/audit-YYYY-MM-DD.jsonl` fire-and-forget. Registered as the core sink
   * (via the audit runtime slot) by `start.ts`/admin PUT ONLY when the `audit`
   * segment is enabled. INERT until then (no sink ⇒ capture hook is a no-op).
   */
  readonly auditWriter: AuditWriter;
  /**
   * TTL prune for the audit store (request-audit-log) — unlinks date files past
   * `retentionDays`. Armed-off; `start.ts` configures from the persisted `audit`
   * segment + starts it (running one prune at boot) ONLY when enabled. Disposed
   * in cleanup.
   */
  readonly auditPruneSweeper: AuditPruneSweeper;
  /**
   * Durable-first billing publisher (billing-event-stream) — appends each event
   * to `billing/billing-YYYY-MM-DD.jsonl` FIRST, then best-effort POSTs it.
   * Registered as the core billing sink (via the billing runtime slot) by
   * `start.ts`/admin PUT ONLY when the `billing` segment is enabled. INERT until
   * then (no sink ⇒ `publishBillingEvent` is a no-op).
   */
  readonly billingPublisher: BillingPublisher;
  /**
   * Bounded retry + reconciliation sweep for the billing ledger
   * (billing-event-stream) — re-POSTs undelivered events within `maxRetryAgeMs`,
   * NEVER deletes. Armed-off; `start.ts` configures from the persisted `billing`
   * segment + starts it ONLY when enabled with an endpoint. Disposed in cleanup.
   */
  readonly billingRetrySweeper: BillingRetrySweeper;
}

/**
 * Construct the standalone daemon from a loaded config + on-disk paths. Does NOT
 * start the listeners — the `start` command awaits `providerProxy.start()` then
 * `outboundApiServer.applyConfig(...)`.
 */
export function buildDaemon(config: DaemonConfig, paths: DaemonPaths): Daemon {
  // Configurable logger (configurable-logging) — level/format/file from
  // `config.logging`. Absent config ⇒ console + all levels + text = byte-
  // identical to the legacy `ConsoleLogger`. `logging.file` is a plain value
  // (not a secret), so it is read straight off the loaded config.
  const logger = new ConfigurableLogger(config.logging);

  // At-rest encryption wiring (secrets design D3/D5/D7). Build the shared
  // `SecretBox` with a LAZY master-key resolver (env → keyfile → auto-gen 0600)
  // and inject it into BOTH config-load/save and the pool key accessor (the same
  // instance) so every read/write seam decrypts/encrypts through one box. The
  // credential store gets the box via its constructor below. The key is resolved
  // (and a keyfile auto-generated) ONLY on the first encrypt/decrypt — so a pure
  // legacy-PLAINTEXT boot with no master key present never materializes a keyfile
  // (design D3 "首次需要时"). Calling `setSecretBox` HERE (before the catalog
  // source is built) guarantees the live `loadConfig` calls the admin API +
  // `start` make are decrypting — see the re-decrypt of the passed-in `config`
  // next, which is idempotent (and key-touch-free) when it was already plaintext.
  const secretBox = new SecretBox(() => resolveMasterKey({ keyFilePath: paths.masterKeyFilePath }));
  setSecretBox(secretBox);
  setPoolSecretBox(secretBox);
  // The passed-in `config` may have been loaded before the box existed (e.g.
  // `start` calls `loadConfig` first). Re-normalize it through the box so the
  // catalog source holds DECRYPTED rows (its `getProvider` puts `row.apiKey`
  // straight into the outbound `LLMProvider.api_key`, bypassing the pool
  // accessor). `decryptConfigSecrets` is idempotent on already-plaintext values.
  const decryptedConfig = decryptConfigSecrets(config, secretBox);

  const llmConfig = new ConfigFileProviderConfigSource(decryptedConfig);
  const keyDb = new JsonOutboundKeyDb(paths.keysPath);
  // Voucher (redemption-card) store (voucher-redemption #9) — a sibling
  // `vouchers.json`, the SAME update-capable JSON mechanism as the key store so
  // the redeem status CAS works. Constructed always; the redeem endpoint + admin
  // surface stay inert until `voucher.enabled` (zero regression when off).
  const voucherDb = new JsonVoucherDb(defaultVouchersPath(paths.configPath));
  // upstream-proxy: pass the box so the settings-store path (admin PUT) encrypts
  // `server.proxy.*` passwords at rest + decrypts on read (other server fields
  // are non-secret). Mirrors config.ts's proxy-secret handling.
  const settingsStore = new JsonApiServerSettingsStore(paths.configPath, secretBox);

  // Subscription wiring. The file-backed credential store feeds the account
  // service (which builds all
  // four auth strategies) + the provider registry. `setSubscriptionProviderRegistry`
  // internally mirrors the registry into `@omnicross/core`'s outbound subscription
  // slot (`setSubscriptionRegistryForOutbound`) — that single call is the entire
  // route-resolution wiring for `/v1/responses` subscription dispatch. Placed
  // after `llmConfig` (TransformerService ready) so boot stays deterministic.
  const credentialStore = new JsonSubscriptionCredentialStore(paths.tokensPath, secretBox);

  // Subscription account health (subscription-account-health): the account service
  // builds its strategies over the process-shared tracker (`getSharedAccountHealth`)
  // for `schedulable` computation. Its 529 overload cooldown honors the persisted
  // `accountHealth` config, applied by the async `start.ts` path via
  // `getSharedAccountHealth().configure(...)` (buildDaemon is sync); the default
  // already matches LEAD OQ1 (ON, 10 min) for the short-lived `launch` path.
  const subscriptionAccounts = new SubscriptionAccountService(credentialStore);
  setSubscriptionAccountService(subscriptionAccounts);
  const subscriptionRegistry = new SubscriptionProviderRegistry(
    subscriptionAccounts,
    credentialStore,
  );
  setSubscriptionProviderRegistry(subscriptionRegistry); // → mirrors into core's outbound slot

  // Upstream proxy (upstream-proxy): seed the global/provider segment from the
  // persisted (decrypted) server config and register the layered resolver into
  // core's `fetchUpstream` egress seam. Precedence account > provider > global >
  // env; the per-account layer reads the DECRYPTED account entry via the store.
  // Absent ALL proxy config AND env ⇒ the resolver returns undefined ⇒ bare fetch
  // (byte-identical zero regression). `start.ts` re-seeds the live config on boot.
  setServerProxyConfig(decryptedConfig.server?.proxy);
  setUpstreamProxyResolver(
    createUpstreamProxyResolver({
      getAccountProxy: (providerId, accountId) =>
        credentialStore.getAccountProxy(providerId, accountId),
    }),
  );

  // Wire the shared host-clean Gemini Code-Assist project resolver from core
  // into the core port (the same module singleton any embedder wires). The gemini
  // subscription responses path then resolves the PAID-tier Cloud AI Companion
  // project id; a free-tier account still resolves `undefined` (no behavior
  // change for accounts without a paid project). The resolver caches the
  // handshake result per access token, so this is a one-time round-trip per
  // account read lazily at request time.
  setGeminiCodeAssistResolver(getGeminiCodeAssistProjectResolver());

  // Multi-key API-key pool. Constructed BEFORE the proxy because
  // `getProviderProxy` only honors `deps` on its FIRST (construction) call and
  // ignores them afterward (module singleton), so the pool must occupy the
  // `apiKeyPool` slot at that first call.
  //  - `loadKeys` reads the LIVE provider row via `llmConfig.getProviderRow`
  //    (hot-reload visible after `invalidateCache`) and synthesizes the
  //    `ApiKeyEntry[]` per design D1 (multi-key / single-key 1-key fallback).
  //  - `resolveEnvKey` is the daemon's single `$ENV` resolver (design D6).
  //  - `disableKey`/`markAutoDisabled` write the IN-MEMORY auto-disable store
  //    (design D5 — NOT config.json; no write amplification, no child-3 schema
  //    collision). `loadKeys` reads it back to flip a disabled key off.
  // Design D2 caveat: the daemon's outbound path resolves with sessionId=null,
  // so core's `LlmConfigProviderAuth.onResult` short-circuits — failover does
  // NOT fire on outbound traffic. v1 ships the pool as cold-standby +
  // observable (admin health view + CLI); a separate core-side knife
  // (`omnicross-daemon-parity-poolseam`) makes it hot.
  const autoDisableStore = new AutoDisableStore();
  const apiKeyPool = new ApiKeyPoolService(
    createPoolKeysLoader((id) => llmConfig.getProviderRow(id), autoDisableStore),
    resolveEnvKey,
    logger,
    async (keyId: string) => {
      autoDisableStore.markAutoDisabled(keyId, 0, Date.now());
      return true;
    },
    async (keyId: string, status: number, at: number) => {
      autoDisableStore.markAutoDisabled(keyId, status, at);
    },
  );

  // Usage/pricing wiring (file-backed stores, siblings of config.json):
  // JsonPricingStore → PricingEngine → JsonlUsageEventStore (its `unpriced`
  // lookup resolves through the ENGINE so wildcard/model-alias fallbacks
  // apply) → UsageRecorder. The recorder occupies the proxy's existing
  // `usageRecorder` deps slot, so all four ingress taps cost-stamp + persist
  // every served request. Recording is fire-and-forget (deferred; errors
  // logged) — the serving hot path gains no latency or failure modes. Files
  // are created lazily on first write; boot needs neither to exist.
  const pricingStore = new JsonPricingStore(defaultPricingPath(paths.configPath));
  const pricingEngine = new PricingEngine(pricingStore, logger);
  const usageEventStore = new JsonlUsageEventStore(
    defaultUsageEventsPath(paths.configPath),
    async (providerId, model) => (await pricingEngine.getEntry(providerId, model)) !== null,
  );
  // Per-key spend tracker (outbound-key-policy) — lazily seeds each key's
  // daily/weekly/total spend from the jsonl store (once per key), then stays hot
  // via the recorder's `onRecord` hook. `totalUsd` survives a restart by
  // re-seeding from the durable store. Wired into the outbound deps below so the
  // wire layer's 402 cost check reads it O(1) with no per-request scan.
  const keySpendTracker = new KeySpendTracker(usageEventStore);
  const usageRecorder = new UsageRecorder(usageEventStore, pricingEngine, logger, {
    onRecord: (apiKeyId, costUsd, at) => keySpendTracker.add(apiKeyId, costUsd, at),
  });

  // Resident ProviderProxy — pool wired into the `apiKeyPool` deps slot, the
  // usage recorder into `usageRecorder`. NO Anthropic factory. (Reads the
  // subscription slot lazily at request time, so this call is otherwise
  // unchanged.)
  const providerProxy = getProviderProxy({ llmConfig, apiKeyPool, usageRecorder });

  // Hot-reload × keyCache (design D4): flush the pool's keyCache after every
  // `reload(...)` so the next `loadKeys` reads the swapped catalog. The port
  // never imports `ApiKeyPoolService` — it only holds this no-type-coupling hook.
  llmConfig.setReloadHook(() => apiKeyPool.invalidateCache());

  // Scheduled account-health probe (subscription-account-probe #8) — the ACTIVE
  // complement to the passive #2 tracker. Constructed armed-off with the frozen
  // defaults (enabled:false); the async `start.ts` path `configure(...)`s it from
  // the persisted `accountProbe` segment and `start()`s it ONLY when enabled.
  // It reads token state via the credential store (#1), probes through the
  // proxy-aware `fetchUpstream` (#3), and feeds outcomes to the shared #2 tracker.
  const accountHealthProbeScheduler = new AccountHealthProbeScheduler(
    credentialStore,
    getSharedAccountHealth(),
    logger,
    DEFAULT_ACCOUNT_PROBE,
  );

  // Shared `/health` report builder (daemon-health-endpoint, D1/D3). ONE closure
  // over the live handles, wired into BOTH the outbound server (below, before
  // key-auth) and the admin server (below, before the auth gate). Coarse +
  // secret-free; the checks are cheap synchronous probes (no upstream, no
  // decrypt). `outboundApiServer`/`adminServer` are referenced lazily — the
  // closure only runs at request time, after both consts are initialized.
  const getHealthReport = (): ReturnType<typeof buildHealthReport> =>
    buildHealthReport({
      version: DAEMON_VERSION,
      // CRITICAL: the config loaded with a providers array.
      configPresent: () => Array.isArray(decryptedConfig.providers),
      // CRITICAL: the credential store's tokens.json is readable WITHOUT
      // decrypting (a missing file is fine — no accounts yet). A stat/access
      // only; never reads or decrypts token material.
      credentialStoreReadable: () => isTokensStoreReadable(paths.tokensPath),
      outboundServerRunning: () => outboundApiServer.getStatus().running,
      adminServerRunning: () => adminServer.getStatus().running,
      // Coarse, account-anonymous probe signal (#8, D5) — added to `checks` ONLY
      // when probing is ENABLED; disabled ⇒ `undefined` ⇒ key omitted ⇒ the
      // `/health` body stays byte-identical (zero regression).
      subscriptionAccountsHealthy: () =>
        accountHealthProbeScheduler.enabled
          ? accountHealthProbeScheduler.probedAccountsHealthy()
          : undefined,
    });

  // Outbound API server — shares the proxy's route map + deps (one conversion
  // stack), authenticated by named keys from the file-backed key store. The
  // `healthReportProvider` mounts an UNAUTHENTICATED `/health` on the traffic
  // port before key-auth (daemon-health-endpoint, D1 secondary mount).
  const outboundApiServer = getOutboundApiServer({
    db: keyDb,
    // voucher-redemption #9: the key-authenticated `POST /redeem` endpoint redeems
    // cards against the presenting key (gated on `voucher.enabled`).
    voucherDb,
    llmConfig,
    providerProxy,
    proxyDeps: providerProxy.getDeps(),
    healthReportProvider: getHealthReport,
    // outbound-key-policy: the wire layer's 402 cost check reads per-key spend.
    keySpendTracker,
    // configurable-logging: route the server's OWN lifecycle + relay dispatch-error
    // lines through the injected logger (honors level/format/file sink).
    logger,
  });

  // Request-audit store dir (request-audit-log) — sibling `audit/` of config.json.
  // Resolved here so the AUTHED admin query reader can close over it below.
  const auditDir = defaultAuditDir(paths.configPath);
  // Billing ledger dir (billing-event-stream) — sibling `billing/` of config.json.
  // Resolved here so the AUTHED admin status reader can close over it below.
  const billingDir = defaultBillingDir(paths.configPath);

  // Admin dashboard listener (RT3) — a SEPARATE node:http server over the live
  // daemon handles. Instance-scoped on the Daemon (not a module singleton); the
  // `start` command starts it (honoring the LAN fail-closed gate), tests stop it
  // in afterEach. `getAdminConfig` resolves defaults from the loaded config.
  const adminServer = new AdminServer({
    configPath: paths.configPath,
    llmConfig,
    keyDb,
    // voucher-redemption #9: the admin `/admin/api/voucher` surface generates/
    // lists/revokes redemption cards (gated on `voucher.enabled`).
    voucherDb,
    // outbound-key-policy: the admin key list surfaces each key's OWN spend.
    keySpendReader: keySpendTracker,
    settingsStore,
    outboundApiServer,
    subscriptionAccounts,
    // Least-authority token WRITER (design D4) — the concrete credential store
    // exposes `writeProviderTokens` / `clearProvider` as daemon-only methods (NOT
    // on the `SubscriptionCredentialStore` port). The admin API sees ONLY these two
    // mutators through the `SubscriptionTokenWriter` shape, never a token read.
    subscriptionTokenWriter: credentialStore,
    // Read-only pool-health view (key-pool design D7): the admin API reads
    // `getKeyHealth` (cooldown) + the in-memory auto-disable store; the key
    // values themselves NEVER leave (masked via `maskProviderApiKey`).
    apiKeyPool,
    autoDisableStore,
    // Interactive OAuth login over admin HTTP (app-parity child 4, design
    // D1/D2-a). The in-memory pending-session store (NEVER serialized), the
    // injected token-exchange fetch (global `fetch` here; mocked in tests), and a
    // NARROW `{ appendProviderAccount }` handle from the concrete credential store
    // (NOT widening the least-authority writer — no token-returning read reachable).
    oauthSessions: new OAuthSessionStore(),
    // Real global fetch by default; a test seam (`paths.oauthExchangeFetch`) can
    // inject a mock so no real token endpoint is hit.
    // upstream-proxy: default the OAuth token-exchange fetch to the proxy-aware
    // helper so interactive login honors a configured proxy (global/env layers).
    oauthExchangeFetch: paths.oauthExchangeFetch ?? ((url, init) => fetchUpstream(url, init)),
    subscriptionAccountAppender: credentialStore,
    // Codex interactive OAuth (app-parity-2 child 5) — the async loopback flow store
    // + the one-shot 127.0.0.1:1455 listener. Token captured + persisted daemon-side;
    // the app polls the token-free status. A test seam (`paths.codexAwaitLoopback`)
    // can inject a mock so no real port is bound.
    codexSessions: new CodexOAuthSessionStore(),
    codexAwaitLoopback: paths.codexAwaitLoopback ?? ((state, timeoutMs) => awaitLoopbackCode(state, timeoutMs)),
    // Migration pack (app-parity child 6, design D2/D3) — the concrete credential
    // store provides BOTH the full DECRYPTED read (`getFullConfig`, export) and
    // the multi-account append (`appendProviderAccount`, import re-encrypts at-
    // rest). Confined to the export/import handlers; never reached by a GET.
    migrationCredentialStore: credentialStore,
    // Code CLI launch (dashboard parity): the external-terminal opener + PATH probe
    // default to the real implementations; tests inject spies so no window spawns.
    cliTerminalOpener: paths.cliTerminalOpener,
    cliPathProbe: paths.cliPathProbe,
    cliCommandRunner: paths.cliCommandRunner,
    // Usage/pricing admin surface (usage-pricing child): stats queries go
    // through the recorder facade, pricing mutations through the engine, and
    // the row DELETE through the concrete store (delete is store-local — the
    // core port stays frozen). None of these can reach key material.
    usageRecorder,
    pricingEngine,
    pricingStore,
    // Use the DECRYPTED config so `admin.token` (if stored as `enc:`) is the
    // plaintext bearer the AdminServer's constant-time compare expects (D4).
    getAdminConfig: () => resolveAdminConfig(decryptedConfig.admin),
    // Unauthenticated `/health` probe (daemon-health-endpoint) — the SAME shared
    // builder the outbound server uses, served before the admin auth gate.
    getHealthReport,
    // configurable-logging: the admin listener's lifecycle lines route through
    // the injected logger.
    logger,
    // subscription-account-probe #8: the AUTHED `GET /admin/api/account-probes`
    // reads per-account probe history from the scheduler (secret-free — ids +
    // status labels only). Routed in `AdminServer` (not `adminApi.ts`).
    probeHistoryReader: accountHealthProbeScheduler,
    // request-audit-log: the AUTHED `GET /admin/api/audit` reads + filters the
    // date-rotated audit store. Bound to the store dir here so the AdminServer
    // carries no path/store coupling. Records hold IP/UA/bodies → admin-only,
    // NEVER unauth, NEVER on `/health`. Routed in `AdminServer` (not `adminApi.ts`).
    auditReader: (query) => readAuditRecords(auditDir, query),
    // billing-event-stream: the AUTHED `GET /admin/api/billing-status` returns the
    // secret-free total/delivered/pending counts of the durable ledger.
    billingStatusReader: () => readBillingStatus(billingDir),
  });

  // Webhook dispatcher (webhook-notifications) — the fire-and-forget sender.
  // Injected into the runtime slot with the shared health tracker; `start.ts`
  // (boot) + the admin config PUT (hot-reload) call `applyWebhookConfig(...)` to
  // (un)register the core sink + subscribe recovery/anomaly. Constructed ALWAYS
  // (so the admin `test` button works), but INERT until a config enables it — no
  // sink is wired ⇒ `emitWebhookEvent` stays a no-op (zero regression).
  const webhookDispatcher = new WebhookDispatcher({
    logger,
    fetchImpl: (url, init) => fetchUpstream(url, init),
  });
  setWebhookRuntime(webhookDispatcher, getSharedAccountHealth());

  // Request audit store (request-audit-log) — the fire-and-forget date-rotated
  // jsonl writer + its TTL prune sweeper, both siblings of config.json under
  // `audit/`. Injected into the audit runtime slot; `start.ts` (boot) + the admin
  // config PUT (hot-reload) call `applyAuditConfig(...)` to (un)register the core
  // capture config + sink and arm/disarm the prune. Constructed ALWAYS but INERT
  // until a config enables it — no sink ⇒ the capture hook is a no-op (zero
  // regression). The sweeper starts armed-off with the frozen defaults.
  const auditWriter = new AuditWriter(auditDir, logger);
  const auditPruneSweeper = new AuditPruneSweeper(auditDir, logger, DEFAULT_AUDIT_CONFIG);
  setAuditRuntime(auditWriter, auditPruneSweeper);

  // Billing event stream (billing-event-stream) — the durable-first publisher
  // (append `billing/billing-YYYY-MM-DD.jsonl` FIRST, then best-effort POST) + its
  // bounded retry sweep. Injected into the billing runtime slot; `start.ts` (boot)
  // + the admin config PUT (hot-reload) call `applyBillingConfig(...)` to
  // (un)register the core sink + capture gate and arm/disarm the retry sweep.
  // Constructed ALWAYS but INERT until a config enables it — no sink ⇒
  // `publishBillingEvent` is a no-op (zero regression). The billing ledger is a
  // financial record — NEVER auto-pruned.
  const billingPublisher = new BillingPublisher(billingDir, logger);
  const billingRetrySweeper = new BillingRetrySweeper(
    billingDir,
    billingPublisher,
    logger,
    DEFAULT_BILLING_CONFIG,
  );
  setBillingRuntime(billingPublisher, billingRetrySweeper);

  // Background token-refresh sweep (external-cli-sync) — constructed armed-off;
  // `start.ts` calls `.start()` on the resident daemon.
  const tokenRefreshScheduler = new TokenRefreshScheduler(credentialStore, logger);

  // Account-health recovery sweep (subscription-account-health, D6) — armed-off;
  // `start.ts` starts it alongside the token-refresh sweep. Correctness never
  // depends on it (lazy clear self-heals); it fires the recovery signal for idle
  // recoveries + nudges a fresh token for a recovered OAuth account.
  const accountHealthSweeper = new AccountHealthSweeper(
    credentialStore,
    getSharedAccountHealth(),
    logger,
  );

  return {
    logger,
    llmConfig,
    keyDb,
    settingsStore,
    providerProxy,
    outboundApiServer,
    apiKeyPool,
    autoDisableStore,
    credentialStore,
    subscriptionRegistry,
    subscriptionAccounts,
    pricingStore,
    pricingEngine,
    usageRecorder,
    adminServer,
    tokenRefreshScheduler,
    accountHealthSweeper,
    accountHealthProbeScheduler,
    webhookDispatcher,
    auditWriter,
    auditPruneSweeper,
    billingPublisher,
    billingRetrySweeper,
  };
}

/** Reset the core singletons (tests / teardown only). Re-exported for the suite.
 *
 * Also clears BOTH subscription singletons (design D4). This is mandatory: the
 * `setSubscriptionProviderRegistry` setter mirrors into core's outbound slot, so
 * without it a prior test's registry would leak into a BYO-only boot and
 * mis-route. We clear the core outbound slot directly via
 * `setSubscriptionRegistryForOutbound(null)` (which accepts `null`), and null
 * the `@omnicross/subscriptions` module singletons through their setters (the
 * setters assign verbatim — passing `null` is a no-throw runtime clear; the
 * `as never` keeps the call within the package's non-nullable type without
 * modifying its behavior). It also nulls the core Gemini Code-Assist resolver
 * slot so a wired resolver does not leak across boots.
 *
 * NOTE: the `AdminServer` is INSTANCE-scoped on the returned `Daemon` (not a
 * module singleton), so it needs no reset here — the test stops it in `afterEach`
 * via `daemon.adminServer.stop()`. */
export function resetDaemonSingletonsForTests(): void {
  __resetProviderProxyForTests();
  __resetOutboundApiServerForTests();
  setSubscriptionRegistryForOutbound(null);
  setSubscriptionProviderRegistry(null as never);
  setSubscriptionAccountService(null as never);
  // Clear the upstream-proxy resolver + server-proxy holder so a prior boot's
  // proxy config does not leak into a fresh (e.g. no-proxy) boot-smoke test.
  setUpstreamProxyResolver(null);
  setServerProxyConfig(undefined);
  // Clear the Gemini Code-Assist resolver slot so a wired resolver from a prior
  // boot does not leak into a fresh (e.g. BYO-only) boot-smoke test.
  setGeminiCodeAssistResolver(null);
  // Clear the module-level at-rest SecretBox in BOTH config.ts and the pool key
  // accessor so a prior boot's box does not leak into a legacy/no-box test
  // (which expects plaintext passthrough). The next `buildDaemon` re-injects.
  setSecretBox(null);
  setPoolSecretBox(null);
  // Clear the webhook runtime slot (dispatcher + sink + health subscriptions) so
  // a prior boot's dispatcher does not leak the core sink into a fresh boot.
  resetWebhookRuntimeForTests();
  // Clear the audit runtime slot (writer + prune sweeper + core capture/sink) so
  // a prior boot's writer does not leak the core audit sink into a fresh boot.
  resetAuditRuntimeForTests();
  // Clear the billing runtime slot (publisher + retry sweeper + core capture/sink)
  // so a prior boot's publisher does not leak the core billing sink into a fresh boot.
  resetBillingRuntimeForTests();
  // Clear the shared client-fingerprint identity store so a prior boot's captured
  // identities / enabled flag / persistence port do not leak into a fresh boot.
  __resetSharedIdentityStoreForTests();
}

/**
 * Cheap, non-blocking, secret-free readability probe for the credential store's
 * `tokens.json` (daemon-health-endpoint check). A MISSING file is healthy (no
 * accounts configured yet); a present-but-unreadable file is unhealthy. Never
 * reads or decrypts token material — a `stat`/`access` only.
 */
function isTokensStoreReadable(tokensPath: string): boolean {
  try {
    if (!existsSync(tokensPath)) return true;
    accessSync(tokensPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
