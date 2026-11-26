/**
 * createEmbeddedHost — compose the provider/account/lease runtime as an
 * in-process library for another Node application.
 *
 * What it composes (the same pieces `bootstrap.ts` wires for the daemon):
 * at-rest SecretBox, the file-backed provider catalog + subscription credential
 * store, the subscription account service/registry, the key pool, the upstream
 * proxy resolver, the resident ProviderProxy, the route-lease manager (with the
 * subscription preflight), the token refresh sweep, and the interactive sign-in
 * stores + loopback listeners.
 *
 * What it deliberately leaves out: the outbound gateway (8765), the admin
 * server (8766), the dashboard UI, usage/pricing/audit/billing stores, search,
 * image generation, chatgpt-web, integrations and every log file. All state
 * lives in `dataDir`.
 *
 * The admin operations are the SAME service-layer functions the daemon's admin
 * HTTP handlers call (`service/*`); this module only unwraps their results.
 *
 * Process model: the underlying runtime uses module-level singletons (proxy,
 * subscription registry, secret box). One host may be active per process, and
 * it cannot share a process with `buildDaemon`. `stop()` releases them so a new
 * host can be created afterwards. Import this entry via ESM only.
 *
 * @module @omnicross/daemon/embed/EmbeddedHost
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { getGeminiCodeAssistProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { ApiKeyPoolService } from '@omnicross/core/completion/ApiKeyPoolService';
import { DEFAULT_ACCOUNT_PROBE } from '@omnicross/core/outbound-api';
import { setSubscriptionRegistryForOutbound } from '@omnicross/core/outbound-api/subscriptionRegistryPort';
import { resolveProviderChain } from '@omnicross/core/pipeline/resolveProviderChain';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { fetchUpstream, setUpstreamProxyResolver } from '@omnicross/core/pipeline/upstreamFetch';
import { setGeminiCodeAssistResolver } from '@omnicross/core/ports/gemini-code-assist-resolver';
import type { Logger } from '@omnicross/core/ports';
import {
  __resetProviderProxyForTests,
  getProviderProxy,
  normalizeRouteLeaseTtl,
  type ProviderProxy,
  ROUTE_LEASE_DEFAULT_TTL_SECONDS,
  ROUTE_LEASE_MAX_TTL_SECONDS,
  ROUTE_LEASE_REQUEST_SCHEMA,
  ROUTE_LEASE_WIRES,
  RouteLeaseError,
  RouteLeaseManager,
  RouteLeaseTargetResolver,
  type RouteLeaseDescriptorPort,
  type RouteLeaseWire,
} from '@omnicross/core/provider-proxy';
import { setOpenCodeGoUserAgent } from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';
import {
  type FetchLike,
  setSubscriptionAccountService,
  setSubscriptionProviderRegistry,
  SubscriptionAccountService,
  SubscriptionProviderRegistry,
} from '@omnicross/subscriptions';

import { AccountHealthProbeScheduler } from '../AccountHealthProbeScheduler';
import { AntigravityOAuthSessionStore } from '../admin/accountsAntigravityOAuth';
import { CodexOAuthSessionStore } from '../admin/accountsCodexOAuth';
import { CopilotOAuthSessionStore } from '../admin/accountsCopilotOAuth';
import { GrokOAuthSessionStore } from '../admin/accountsGrokOAuth';
import { KimiOAuthSessionStore } from '../admin/accountsKimiOAuth';
import type { SubscriptionAccountAppender } from '../admin/accountsOAuth';
import { DEFAULT_OAUTH_SESSION_TTL_MS, OAuthSessionStore } from '../admin/oauthSessions';
import { declaredUpstreamModels, listUpstreamCatalog } from '../admin/upstreamRoutingAdmin';
import { ProviderKeyQuotaService } from '../allowance/ProviderKeyQuotaService';
import { awaitLoopbackCode } from '../commands/loopbackCallback';
import { type DaemonConfig, loadConfig, setSecretBox } from '../config';
import { AutoDisableStore } from '../pool/autoDisableStore';
import { createPoolKeysLoader, setSecretBox as setPoolSecretBox } from '../pool/loadPoolKeys';
import { resolveEnvKey } from '../pool/resolveEnvKey';
import { ConfigFileProviderConfigSource } from '../ports/ConfigFileProviderConfigSource';
import { JsonSubscriptionCredentialStore } from '../ports/JsonSubscriptionCredentialStore';
import { createUpstreamProxyResolver, setServerProxyConfig } from '../proxy/upstreamProxyResolver';
import { createRouteLeaseSubscriptionPreflight } from '../routeLeaseSubscriptionPreflight';
import { resolveMasterKey, SecretBox } from '../secrets';
import * as accountAdmin from '../service/accountAdmin';
import * as oauthAdmin from '../service/oauthAdmin';
import * as providerAdmin from '../service/providerAdmin';
import type { ServiceResult } from '../service/result';
import { TokenRefreshScheduler } from '../TokenRefreshScheduler';

import { createRouteLeaseDescriptors } from './descriptors';
import { HostError, hostErrorFromLease, hostErrorFromResult } from './errors';
import type {
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
  OAuthSession,
  OAuthStatus,
  PoolKeyView,
  ProviderTestResult,
  ProviderView,
  UpstreamView,
} from './types';

/** Subscription providers the lease preflight can back (mirrors `routeLeaseSubscriptionPreflight`). */
const LEASE_SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderId[] = Object.freeze([
  'claude',
  'codex',
  'gemini',
  'opencodego',
]);

/** Device-code flows' session lifetime (the per-provider stores use the same windows). */
const DEVICE_CODE_TTL_MS = 15 * 60_000;
const LOOPBACK_CALLBACKS: Readonly<Partial<Record<SubscriptionProviderId, string>>> = Object.freeze({
  codex: 'http://localhost:1455/auth/callback',
  antigravity: 'http://127.0.0.1:51121/oauth-callback',
});

const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

let activeHost: object | null = null;

/** The embedded runtime. See {@link createEmbeddedHost}. */
export interface EmbeddedHost {
  /** Bind the proxy and arm the token refresh sweep. Idempotent. */
  start(): Promise<void>;
  /** Release every lease, cancel pending sign-ins, close the proxy, free the process slot. Idempotent. */
  stop(): Promise<void>;
  /** `http://<host>:<port>` once started, else `null`. */
  readonly proxyBaseUrl: string | null;

  readonly leases: {
    create(request: LeaseRequest, idempotencyKey: string): Promise<Lease>;
    renew(leaseId: string, ttlSeconds?: number): Promise<{ expiresAt: string }>;
    release(leaseId: string): Promise<{ released: boolean }>;
    capabilities(): LeaseCapabilities;
  };

  readonly providers: {
    list(): Promise<ProviderView[]>;
    get(id: string): Promise<ProviderView>;
    /** Validates input, persists, discovers models (best-effort) and returns the masked row. */
    create(input: Record<string, unknown>): Promise<ProviderView>;
    /** Omitted fields keep, `null` clears, a blank `apiKey` keeps the stored key. */
    update(id: string, patch: Record<string, unknown>): Promise<ProviderView>;
    remove(id: string): Promise<void>;
    /** Listed ids first, the rest keep their relative order. */
    reorder(ids: readonly string[]): Promise<ProviderView[]>;
    /** Real `/models` call with the provider's key. */
    discoverModels(id: string): Promise<DiscoveredModels>;
    /** Real, minimal completion with the provider's key (may bill). */
    test(id: string, model: string): Promise<ProviderTestResult>;
    readonly keys: {
      list(providerId: string): Promise<PoolKeyView[]>;
      add(providerId: string, input: { apiKey: string; label?: string; weight?: number; enabled?: boolean }): Promise<PoolKeyView[]>;
      update(providerId: string, keyId: string, patch: { apiKey?: string; label?: string; weight?: number; enabled?: boolean }): Promise<PoolKeyView[]>;
      remove(providerId: string, keyId: string): Promise<PoolKeyView[]>;
      setEnabled(providerId: string, keyId: string, enabled: boolean): Promise<PoolKeyView[]>;
      /** Force one quota probe (providers with a quota adapter only). */
      refreshQuota(providerId: string, keyId: string): Promise<unknown>;
    };
  };

  readonly presets: {
    list(): Promise<{ presets: unknown[]; excluded: unknown[] }>;
  };

  readonly upstreams: {
    list(): Promise<UpstreamView[]>;
  };

  readonly accounts: {
    list(): Promise<AccountList>;
    patch(providerId: SubscriptionProviderId, accountId: string, patch: AccountMetadataPatch): Promise<void>;
    setActive(providerId: SubscriptionProviderId, accountId: string): Promise<void>;
    batch(request: AccountBatchRequest): Promise<{ affected: number }>;
    remove(providerId: SubscriptionProviderId, accountId: string): Promise<void>;
    /** Append an account from a credential block (credentials go in, never come out). */
    addManual(providerId: SubscriptionProviderId, credential: Record<string, unknown> & { label?: string }): Promise<AccountView | null>;
    /** Copy the local `claude` / `codex` CLI login into a new account. */
    importExternal(providerId: 'claude' | 'codex', options?: { label?: string }): Promise<AccountView | null>;
    /** Refresh the ACTIVE account's OAuth token. */
    refresh(providerId: SubscriptionProviderId): Promise<{ ok: boolean }>;
    /** Live connection test (may bill). */
    test(providerId: SubscriptionProviderId, accountId: string): Promise<{ ok: boolean; tier: string; model?: string }>;
    diagnostics(providerId: SubscriptionProviderId, accountId: string): Promise<unknown[]>;
    setSupportedModels(providerId: SubscriptionProviderId, accountId: string, supportedModels: unknown): Promise<void>;
    setProxy(providerId: SubscriptionProviderId, accountId: string, proxy: Record<string, unknown> | null): Promise<void>;
  };

  readonly oauth: {
    /** The flow kind for a provider, or `null` when it has no interactive sign-in. */
    kindOf(providerId: SubscriptionProviderId): OAuthSession['kind'] | null;
    start(providerId: SubscriptionProviderId, options?: { enterpriseUrl?: string }): Promise<OAuthSession>;
    /** Paste-code flows: exchange the pasted code and add the account. */
    complete(providerId: SubscriptionProviderId, sessionId: string, code: string, options?: { label?: string }): Promise<AccountView | null>;
    status(providerId: SubscriptionProviderId, sessionId: string): Promise<OAuthStatus>;
    cancel(providerId: SubscriptionProviderId, sessionId: string): Promise<void>;
  };

  health(): Promise<HostHealth>;
  on(event: 'change', listener: HostChangeListener): () => void;
  off(event: 'change', listener: HostChangeListener): void;
}

/**
 * Create (but do not start) the embedded host. Throws a {@link HostError}
 * (`code: 'host_conflict'`) when another host or a daemon is already active in
 * this process.
 */
export function createEmbeddedHost(options: EmbeddedHostOptions): EmbeddedHost {
  if (!options || typeof options.dataDir !== 'string' || options.dataDir.trim() === '') {
    throw new HostError('invalid_request', 400, 'dataDir is required');
  }
  if (activeHost) {
    throw new HostError('host_conflict', 409, 'an embedded host is already active in this process');
  }
  if (providerProxyExists()) {
    // A daemon (or another composition) owns the process-level runtime slots;
    // composing on top would silently rebind them under it.
    throw new HostError('host_conflict', 409, 'a provider runtime is already active in this process');
  }
  const token = {};
  activeHost = token;
  try {
    return composeHost(options, () => {
      if (activeHost === token) activeHost = null;
    });
  } catch (error) {
    activeHost = null;
    throw error;
  }
}

function composeHost(options: EmbeddedHostOptions, releaseSlot: () => void): EmbeddedHost {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const tokensPath = join(dataDir, 'tokens.json');
  const keyFilePath = options.masterKey?.file ? resolve(options.masterKey.file) : join(dataDir, 'master.key');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ providers: [] }, null, 2) + '\n', 'utf8');
  }
  const logger = options.logger ?? SILENT_LOGGER;
  const productName = options.productName ?? 'This app';
  const consumer = options.leaseConsumer ?? 'host';

  // At-rest encryption: one lazy box shared by config load/save, the pool key
  // accessor and the credential store. The env key is opt-in.
  const secretBox = new SecretBox(
    () => resolveMasterKey({ keyFilePath, readEnv: options.masterKey?.readEnv === true }),
    {
      decryptFailureMessage:
        'failed to decrypt a stored secret: the master key does not match the one these secrets were saved with, or the stored value was tampered with',
    },
  );
  setSecretBox(secretBox);
  setPoolSecretBox(secretBox);

  let config: DaemonConfig;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    resetRuntimeSlots();
    throw error;
  }

  const llmConfig = new ConfigFileProviderConfigSource(config);
  const credentialStore = new JsonSubscriptionCredentialStore(tokensPath, secretBox);
  const subscriptionAccounts = new SubscriptionAccountService(credentialStore);
  setSubscriptionAccountService(subscriptionAccounts);
  const subscriptionRegistry = new SubscriptionProviderRegistry(subscriptionAccounts, credentialStore);
  setSubscriptionProviderRegistry(subscriptionRegistry);

  setServerProxyConfig(config.server?.proxy);
  setUpstreamProxyResolver(
    createUpstreamProxyResolver({
      getAccountProxy: (providerId, accountId) => credentialStore.getAccountProxy(providerId, accountId),
    }),
  );
  setGeminiCodeAssistResolver(getGeminiCodeAssistProjectResolver());
  setOpenCodeGoUserAgent(options.identity?.opencodegoUserAgent ?? config.opencodego?.userAgent ?? null);

  const autoDisableStore = new AutoDisableStore();
  const providerKeyQuota = new ProviderKeyQuotaService(secretBox);
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
  llmConfig.setReloadHook(() => apiKeyPool.invalidateCache());

  const providerProxy: ProviderProxy = getProviderProxy({ llmConfig, apiKeyPool, logger });

  const descriptorOption = options.routeLeaseDescriptors;
  const descriptors: RouteLeaseDescriptorPort = isDescriptorPort(descriptorOption)
    ? descriptorOption
    : createRouteLeaseDescriptors(descriptorOption ?? {});
  const routeLeaseManager = new RouteLeaseManager(
    providerProxy,
    new RouteLeaseTargetResolver(llmConfig, {
      providerKeys: apiKeyPool,
      subscriptions: createRouteLeaseSubscriptionPreflight(credentialStore),
    }),
    descriptors,
    { logger, endpointRuntime: true, exposeEndpoint: true },
  );
  providerProxy.registerBeforeStop(() => routeLeaseManager.shutdown());

  const tokenRefreshScheduler = new TokenRefreshScheduler(credentialStore, logger);
  const accountProbe = new AccountHealthProbeScheduler(
    credentialStore,
    getSharedAccountHealth(),
    logger,
    DEFAULT_ACCOUNT_PROBE,
  );

  // ── change notification ──────────────────────────────────────────────────
  const events = new EventEmitter();
  const emitChange = (event: HostChangeEvent): void => {
    try {
      events.emit('change', event);
    } catch (error) {
      logger.warn('[embed] change listener threw', { error: error instanceof Error ? error.message : String(error) });
    }
  };

  // Account appends from async sign-ins (loopback / device code) land after
  // `oauth.start` returned, so the appender itself announces them.
  const appender: SubscriptionAccountAppender = {
    async appendProviderAccount(providerId, block, label) {
      const result = await credentialStore.appendProviderAccount(providerId, block, label);
      emitChange({ scope: 'accounts', action: 'added', providerId });
      return result;
    },
  };

  const exchangeFetch: (providerId: SubscriptionProviderId) => FetchLike = options.oauth?.exchangeFetch
    ? () => options.oauth!.exchangeFetch as FetchLike
    : (providerId) => (url, init) => fetchUpstream(url, init, { providerId, redactBodies: true });
  const pageTitle = options.oauth?.callbackPageTitle ?? 'Sign-in';
  const pageHint = options.oauth?.callbackPageHint ?? 'You can close this window.';

  const oauthDeps: oauthAdmin.OAuthAdminDeps = {
    oauthSessions: new OAuthSessionStore(),
    oauthExchangeFetch: exchangeFetch,
    subscriptionAccountAppender: appender,
    subscriptionAccounts,
    codexSessions: new CodexOAuthSessionStore(),
    codexAwaitLoopback:
      options.oauth?.awaitLoopback?.codex ??
      ((state, timeoutMs, signal) =>
        awaitLoopbackCode(state, timeoutMs, signal, { pageTitle, pageHint })),
    kimiSessions: new KimiOAuthSessionStore(),
    grokSessions: new GrokOAuthSessionStore(),
    copilotSessions: new CopilotOAuthSessionStore(),
    antigravitySessions: new AntigravityOAuthSessionStore(),
    antigravityAwaitLoopback:
      options.oauth?.awaitLoopback?.antigravity ??
      ((state, timeoutMs, signal) =>
        awaitLoopbackCode(state, timeoutMs, signal, {
          port: 51121,
          path: '/oauth-callback',
          label: 'antigravity',
          pageTitle,
          pageHint,
        })),
  };
  /** Polled sign-ins started through this host (cancelled on stop). */
  const pendingSignIns = new Map<string, SubscriptionProviderId>();

  const providerDeps: providerAdmin.ProviderAdminDeps = {
    configPath,
    llmConfig,
    apiKeyPool,
    autoDisableStore,
    providerKeyQuota,
  };
  const accountDeps: accountAdmin.AccountAdminDeps = {
    subscriptionAccounts,
    subscriptionTokenWriter: credentialStore,
    subscriptionAccountAppender: appender,
    accountProbeService: accountProbe,
  };

  // Provider writes are read-modify-write over config.json: serialize them.
  let providerWrites: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = providerWrites.then(work, work);
    providerWrites = next.catch(() => undefined);
    return next;
  };

  let started = false;
  let stopped = false;

  const assertOpen = (): void => {
    if (stopped) throw new HostError('host_stopped', 503, 'the embedded host has been stopped');
  };
  const unwrap = <T>(result: ServiceResult): T => {
    if (result.status >= 400) throw hostErrorFromResult(result);
    return result.body as T;
  };
  const run = async <T>(work: () => Promise<ServiceResult> | ServiceResult): Promise<T> => {
    assertOpen();
    return unwrap<T>(await work());
  };
  const mutateProviders = async <T>(
    action: string,
    work: () => Promise<ServiceResult>,
    providerId?: string,
  ): Promise<T> => {
    assertOpen();
    const body = await serialized(async () => unwrap<T>(await work()));
    emitChange({ scope: 'providers', action, ...(providerId ? { providerId } : {}) });
    return body;
  };
  const mutateAccounts = async <T>(
    action: string,
    work: () => Promise<ServiceResult>,
    providerId?: string,
  ): Promise<T> => {
    const body = await run<T>(work);
    emitChange({ scope: 'accounts', action, ...(providerId ? { providerId } : {}) });
    return body;
  };
  const accountEntry = (body: unknown): AccountView | null => {
    const account = (body as { account?: AccountView } | null)?.account;
    return account ?? null;
  };

  const host: EmbeddedHost = {
    async start() {
      assertOpen();
      if (started) return;
      await llmConfig.ready();
      await providerProxy.start({ host: options.proxy?.host, port: options.proxy?.port });
      tokenRefreshScheduler.start();
      started = true;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      tokenRefreshScheduler.dispose();
      accountProbe.dispose();
      for (const [sessionId, providerId] of pendingSignIns) {
        oauthAdmin.cancelOAuth(oauthDeps, providerId, sessionId);
      }
      pendingSignIns.clear();
      try {
        await providerProxy.stop(); // runs routeLeaseManager.shutdown() first
      } finally {
        apiKeyPool.dispose();
        events.removeAllListeners();
        resetRuntimeSlots();
        releaseSlot();
      }
    },

    get proxyBaseUrl() {
      return started && !stopped && providerProxy.isReady() ? providerProxy.getBaseUrl() : null;
    },

    leases: {
      async create(request, idempotencyKey) {
        assertOpen();
        try {
          const outcome = await routeLeaseManager.createFromRequest(
            {
              schemaVersion: ROUTE_LEASE_REQUEST_SCHEMA,
              consumer: request.consumer ?? consumer,
              runtime: request.runtime,
              upstream: request.upstream,
              model: request.model,
              ...(request.wire !== undefined ? { wire: request.wire } : {}),
              ...(request.execution !== undefined ? { execution: request.execution } : {}),
              ...(request.ttlSeconds !== undefined ? { ttlSeconds: request.ttlSeconds } : {}),
            },
            idempotencyKey,
          );
          const result = outcome.result;
          if (!result.endpoint) throw new RouteLeaseError('daemon_not_ready', 'lease endpoint is unavailable');
          return {
            leaseId: result.leaseId,
            created: outcome.created,
            runtime: result.runtime,
            upstream: result.upstream,
            model: result.model,
            createdAt: result.createdAt,
            expiresAt: result.expiresAt,
            launch: { env: { ...result.launch.env }, extraArgs: [...result.launch.extraArgs] },
            endpoint: { ...result.endpoint },
          };
        } catch (error) {
          throw hostErrorFromLease(error);
        }
      },
      async renew(leaseId, ttlSeconds) {
        assertOpen();
        try {
          const ttl = normalizeRouteLeaseTtl(ttlSeconds ?? ROUTE_LEASE_DEFAULT_TTL_SECONDS);
          return { expiresAt: routeLeaseManager.renew(leaseId, ttl).expiresAt };
        } catch (error) {
          throw hostErrorFromLease(error);
        }
      },
      async release(leaseId) {
        assertOpen();
        return { released: routeLeaseManager.release(leaseId).released };
      },
      capabilities() {
        return {
          runtimes: ['claude', 'codex', 'endpoint'],
          wires: [...ROUTE_LEASE_WIRES],
          upstreamKinds: ['provider', 'account', 'account-group', 'account-pool'],
          maxTtlSeconds: ROUTE_LEASE_MAX_TTL_SECONDS,
          defaultTtlSeconds: ROUTE_LEASE_DEFAULT_TTL_SECONDS,
          tokenHeaders: ['authorization', 'x-api-key', 'x-goog-api-key'],
          subscriptionProviders: [...LEASE_SUBSCRIPTION_PROVIDERS],
        };
      },
    },

    providers: {
      async list() {
        return (await run<{ providers: ProviderView[] }>(() => providerAdmin.listProviders(providerDeps))).providers;
      },
      async get(id) {
        const providers = (await run<{ providers: ProviderView[] }>(() => providerAdmin.listProviders(providerDeps))).providers;
        const found = providers.find((provider) => provider.id === id);
        if (!found) throw new HostError('not_found', 404, `provider '${id}' not found`);
        return found;
      },
      async create(input) {
        const body = await mutateProviders<{ provider: ProviderView }>(
          'created',
          () => providerAdmin.createProvider(providerDeps, { ...input }),
          typeof input['id'] === 'string' ? input['id'] : undefined,
        );
        // Discovery may have merged models after the row was first written.
        return (await host.providers.get(body.provider.id).catch(() => body.provider));
      },
      async update(id, patch) {
        const body = await mutateProviders<{ provider: ProviderView }>(
          'updated',
          () => providerAdmin.updateProvider(providerDeps, id, { ...patch }),
          id,
        );
        return body.provider;
      },
      async remove(id) {
        await mutateProviders('removed', () => providerAdmin.deleteProvider(providerDeps, id), id);
      },
      async reorder(ids) {
        const body = await mutateProviders<{ providers: ProviderView[] }>(
          'reordered',
          () => providerAdmin.reorderProviders(providerDeps, { order: [...ids] }),
        );
        return body.providers;
      },
      async discoverModels(id) {
        return run<DiscoveredModels>(() => providerAdmin.discoverProviderModels(providerDeps, id));
      },
      async test(id, model) {
        return run<ProviderTestResult>(() => providerAdmin.testProviderModel(providerDeps, id, { model }));
      },
      keys: {
        async list(providerId) {
          return (await run<{ keys: PoolKeyView[] }>(() => providerAdmin.listProviderKeys(providerDeps, providerId))).keys;
        },
        async add(providerId, input) {
          const body = await mutateProviders<{ keys: PoolKeyView[] }>(
            'key-added',
            () => providerAdmin.addProviderKey(providerDeps, providerId, { ...input }),
            providerId,
          );
          return body.keys;
        },
        async update(providerId, keyId, patch) {
          const body = await mutateProviders<{ keys: PoolKeyView[] }>(
            'key-updated',
            () => providerAdmin.updateProviderKey(providerDeps, providerId, keyId, { ...patch }),
            providerId,
          );
          return body.keys;
        },
        async remove(providerId, keyId) {
          const body = await mutateProviders<{ keys: PoolKeyView[] }>(
            'key-removed',
            () => providerAdmin.deleteProviderKey(providerDeps, providerId, keyId),
            providerId,
          );
          return body.keys;
        },
        async setEnabled(providerId, keyId, enabled) {
          const body = await mutateProviders<{ keys: PoolKeyView[] }>(
            'key-updated',
            () => providerAdmin.setProviderKeyEnabled(providerDeps, providerId, keyId, { enabled }),
            providerId,
          );
          return body.keys;
        },
        async refreshQuota(providerId, keyId) {
          return (await run<{ quota: unknown }>(() =>
            providerAdmin.refreshProviderKeyQuota(providerDeps, providerId, keyId),
          )).quota;
        },
      },
    },

    presets: {
      async list() {
        return run<{ presets: unknown[]; excluded: unknown[] }>(() => providerAdmin.listPresets());
      },
    },

    upstreams: {
      async list() {
        assertOpen();
        const catalog = await listUpstreamCatalog({
          configPath,
          subscriptionAccounts,
          subscriptionTokenWriter: credentialStore,
        });
        const rows = loadConfig(configPath).providers;
        const views: UpstreamView[] = [];
        for (const entry of catalog) {
          const models = declaredUpstreamModels(entry.target, rows);
          if (entry.target.kind === 'provider') {
            const row = rows.find((candidate) => candidate.id === entry.target.providerId);
            views.push({
              key: entry.key,
              label: entry.label,
              kind: 'provider',
              target: { kind: 'provider', providerId: entry.target.providerId },
              models,
              lease: { supported: true, wires: await providerLeaseWires(llmConfig, row?.apiFormat, entry.target.providerId, models[0]) },
            });
          } else {
            const supported = (LEASE_SUBSCRIPTION_PROVIDERS as readonly string[]).includes(entry.target.providerId);
            views.push({
              key: entry.key,
              label: entry.label,
              kind: 'subscription',
              target: { kind: 'account-pool', providerId: entry.target.providerId },
              models,
              lease: { supported, wires: supported ? [...ROUTE_LEASE_WIRES] : [] },
            });
          }
        }
        return views;
      },
    },

    accounts: {
      async list() {
        assertOpen();
        const providerAccounts = await credentialStore.listSanitizedAccounts();
        const externalCli = await credentialStore.listExternalCliAvailability();
        const accounts: AccountView[] = [];
        for (const [providerId, rows] of Object.entries(providerAccounts)) {
          for (const row of rows) accounts.push({ ...row, providerId: providerId as SubscriptionProviderId });
        }
        return { accounts, externalCli };
      },
      async patch(providerId, accountId, patch) {
        await mutateAccounts('updated', () => accountAdmin.patchAccount(accountDeps, providerId, accountId, { ...patch }), providerId);
      },
      async setActive(providerId, accountId) {
        await mutateAccounts('activated', () => accountAdmin.setActiveAccount(accountDeps, providerId, { id: accountId }), providerId);
      },
      async batch(request) {
        const { accounts: refs, ...mutation } = request;
        const body = await mutateAccounts<{ affected: number }>(
          'batch',
          () => accountAdmin.batchAccounts(accountDeps, { ...mutation, accounts: refs.map((ref) => ({ ...ref })) }),
        );
        return { affected: body.affected };
      },
      async remove(providerId, accountId) {
        await mutateAccounts('removed', () => accountAdmin.removeAccount(accountDeps, providerId, accountId), providerId);
      },
      async addManual(providerId, credential) {
        return accountEntry(
          await mutateAccounts('added', () => accountAdmin.addManualAccount(accountDeps, providerId, { ...credential })),
        );
      },
      async importExternal(providerId, importOptions) {
        return accountEntry(
          await mutateAccounts(
            'imported',
            () => accountAdmin.importExternalAccount(accountDeps, providerId, { ...importOptions }, productName),
            providerId,
          ),
        );
      },
      async refresh(providerId) {
        const body = await mutateAccounts<{ ok: boolean }>('refreshed', () => accountAdmin.refreshAccount(accountDeps, providerId), providerId);
        return { ok: body.ok };
      },
      async test(providerId, accountId) {
        return run<{ ok: boolean; tier: string; model?: string }>(() =>
          accountAdmin.testAccount(accountDeps, providerId, accountId),
        );
      },
      async diagnostics(providerId, accountId) {
        return (await run<{ diagnostics: unknown[] }>(() =>
          accountAdmin.accountDiagnostics(accountDeps, providerId, accountId),
        )).diagnostics;
      },
      async setSupportedModels(providerId, accountId, supportedModels) {
        await mutateAccounts(
          'updated',
          () => accountAdmin.setAccountSupportedModels(accountDeps, providerId, accountId, { supportedModels }),
          providerId,
        );
      },
      async setProxy(providerId, accountId, proxy) {
        await mutateAccounts('updated', () => accountAdmin.setAccountProxy(accountDeps, providerId, accountId, { proxy }), providerId);
      },
    },

    oauth: {
      kindOf(providerId) {
        return oauthAdmin.oauthFlowKind(providerId);
      },
      async start(providerId, startOptions) {
        const kind = oauthAdmin.oauthFlowKind(providerId);
        if (!kind) throw new HostError('invalid_request', 400, `interactive sign-in is not available for '${providerId}'`);
        const body = await run<{ authUrl: string; sessionId: string; userCode?: string }>(() =>
          oauthAdmin.startOAuth(oauthDeps, providerId, { ...startOptions }),
        );
        if (oauthAdmin.isPolledOAuthProvider(providerId)) pendingSignIns.set(body.sessionId, providerId);
        const ttlMs = kind === 'device-code' ? DEVICE_CODE_TTL_MS : DEFAULT_OAUTH_SESSION_TTL_MS;
        return {
          sessionId: body.sessionId,
          providerId,
          kind,
          authUrl: body.authUrl,
          ...(body.userCode ? { userCode: body.userCode, verificationUri: body.authUrl } : {}),
          ...(kind === 'loopback' && LOOPBACK_CALLBACKS[providerId] ? { callbackUrl: LOOPBACK_CALLBACKS[providerId] } : {}),
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        };
      },
      async complete(providerId, sessionId, code, completeOptions) {
        const body = await run<unknown>(() =>
          oauthAdmin.completeOAuth(oauthDeps, providerId, { sessionId, code, ...(completeOptions?.label ? { label: completeOptions.label } : {}) }),
        );
        return accountEntry(body);
      },
      async status(providerId, sessionId) {
        assertOpen();
        if (oauthAdmin.oauthFlowKind(providerId) === 'paste-code') {
          // Paste-code sessions have no background work: pending until completed.
          if (oauthDeps.oauthSessions.peek(sessionId)?.providerId === providerId) return { state: 'pending' };
          throw new HostError('not_found', 404, 'unknown, expired or already completed sign-in session');
        }
        const status = unwrap<OAuthStatus>(oauthAdmin.oauthStatus(oauthDeps, providerId, sessionId));
        if (status.state !== 'pending') pendingSignIns.delete(sessionId);
        return status;
      },
      async cancel(providerId, sessionId) {
        assertOpen();
        if (oauthAdmin.oauthFlowKind(providerId) === 'paste-code') {
          oauthDeps.oauthSessions.consume(sessionId);
          return;
        }
        unwrap(oauthAdmin.cancelOAuth(oauthDeps, providerId, sessionId));
        pendingSignIns.delete(sessionId);
      },
    },

    async health() {
      const rows = llmConfig.listProviderRows();
      const providers: Array<HostHealth['providers'][number]> = [];
      for (const row of rows) {
        const cooldown = await apiKeyPool.getKeyHealth(row.id).catch(() => ({} as Record<string, { until: number }>));
        const entries = row.apiKeys && row.apiKeys.length > 0
          ? row.apiKeys
          : row.apiKey ? [{ id: `${row.id}:default`, enabled: true }] : [];
        const now = Date.now();
        providers.push({
          id: row.id,
          ...(row.name ? { name: row.name } : {}),
          enabled: row.enabled !== false,
          modelCount: row.models?.length ?? 0,
          keys: {
            total: entries.length,
            enabled: entries.filter((entry) => entry.enabled !== false && !autoDisableStore.isDisabled(entry.id)).length,
            coolingDown: entries.filter((entry) => (cooldown[entry.id]?.until ?? 0) > now).length,
            autoDisabled: entries.filter((entry) => autoDisableStore.isDisabled(entry.id)).length,
          },
        });
      }
      const sanitized = await credentialStore.listSanitizedAccounts().catch(() => ({} as Record<string, never[]>));
      const accounts: Array<HostHealth['accounts'][number]> = [];
      for (const [providerId, list] of Object.entries(sanitized)) {
        for (const account of list) {
          accounts.push({
            providerId,
            accountId: account.id,
            ...(account.label ? { label: account.label } : {}),
            enabled: account.enabled,
            schedulable: account.schedulable,
            status: account.status,
          });
        }
      }
      const ready = started && !stopped && providerProxy.isReady();
      return {
        ready,
        proxyBaseUrl: ready ? providerProxy.getBaseUrl() : null,
        activeLeases: routeLeaseManager.activeCount(),
        providers,
        accounts,
      };
    },

    on(event, listener) {
      if (event !== 'change') throw new TypeError(`unknown event '${String(event)}'`);
      events.on('change', listener);
      return () => events.off('change', listener);
    },
    off(event, listener) {
      if (event === 'change') events.off('change', listener);
    },
  };
  return host;
}

/** Whether the process-wide ProviderProxy singleton has already been constructed. */
function providerProxyExists(): boolean {
  try {
    getProviderProxy();
    return true;
  } catch {
    return false;
  }
}

function isDescriptorPort(value: unknown): value is RouteLeaseDescriptorPort {
  return Boolean(value) &&
    typeof (value as RouteLeaseDescriptorPort).build === 'function' &&
    typeof (value as RouteLeaseDescriptorPort).has === 'function';
}

/**
 * Advisory wires a provider can serve a lease on: its native wire, plus every
 * other wire when a transformer chain exists for it (the lease preflight runs
 * the same check authoritatively).
 */
async function providerLeaseWires(
  llmConfig: ConfigFileProviderConfigSource,
  apiFormat: string | undefined,
  providerId: string,
  sampleModel: string | undefined,
): Promise<RouteLeaseWire[]> {
  const native: RouteLeaseWire | undefined =
    apiFormat === 'anthropic'
      ? 'anthropic-messages'
      : apiFormat === 'openai-response'
        ? 'openai-responses'
        : apiFormat === 'openai'
          ? 'openai-chat'
          : undefined;
  let converts = false;
  if (sampleModel) {
    try {
      converts = (await resolveProviderChain(llmConfig, providerId, sampleModel)).hasTransformers;
    } catch {
      converts = false;
    }
  }
  if (converts) return [...ROUTE_LEASE_WIRES];
  return native ? [native] : [];
}

/** Clear the process-level runtime slots this host filled. */
function resetRuntimeSlots(): void {
  __resetProviderProxyForTests();
  setSubscriptionRegistryForOutbound(null);
  setSubscriptionProviderRegistry(null as never);
  setSubscriptionAccountService(null as never);
  setUpstreamProxyResolver(null);
  setServerProxyConfig(undefined);
  setGeminiCodeAssistResolver(null);
  setOpenCodeGoUserAgent(null);
  setSecretBox(null);
  setPoolSecretBox(null);
}
