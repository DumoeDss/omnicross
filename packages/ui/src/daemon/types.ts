/**
 * types.ts — the daemon admin-API wire DTOs + the LLM-config API subset the
 * Provider page consumes (design D3/D5). The adapter (`llmConfigAdapter.ts`)
 * maps between the daemon DTOs and the page's `LLMProvider` shape.
 *
 * The Phase-2 page DTOs (server/status/keys + accounts) live in
 * `types-server.ts` / `types-accounts.ts` (type-file size discipline) and are
 * re-exported here so the seam has one import surface.
 */

import type {
  ApiKeyEntry,
  ApiKeyEntryInput,
  KeyHealthMap,
  LLMProvider,
  LLMProviderInput,
  LLMProviderResult,
  LLMProviderUpdateInput,
  ModelConfig,
  ProviderModelDiscoveryResult,
  TransformerConfig,
} from '@shared/llm-config';

import type {
  AccountsListResponse,
  AccountTokenInput,
  SubscriptionListEntry,
  SubscriptionProviderId,
} from './types-accounts';
import type {
  EndpointRoutingConfig,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundKeyPolicyPatch,
  OutboundModelConfigError,
  ProxyConfig,
} from './types-server';

export type * from './types-server';
export type * from './types-accounts';

/** Uniform mutation result mirroring `llmConfigAdapter`'s `{ success, message }`. */
export interface MutationResult {
  success: boolean;
  message?: string;
  /**
   * Present ONLY when a `/server` enable PUT was rejected because a kind-mapped
   * endpoint is missing required model mappings (`incomplete-model-config`). The
   * page surfaces this as the "service can't start" prompt; the partial config is
   * still persisted daemon-side. Absent on ordinary success/failure.
   */
  missing?: OutboundModelConfigError[];
}

// ── Daemon wire DTOs ────────────────────────────────────────────────────────────

/** `GET /admin/api/providers` row (secrets IN-never-OUT; literal key absent). */
export interface DaemonProviderView {
  id: string;
  /** app-parity-2 child 1: optional mutable display name (absent → app falls back to id). */
  name?: string;
  apiFormat: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string;
  models: string[];
  /**
   * app-parity child 2: optional per-model metadata, parallel to the flat
   * `models[]` (named-five only: id/name/enabled/group/vision/reasoning). Absent
   * for a flat-models-only row. Non-secret — round-trips verbatim. The wider
   * `ModelConfig` fields the daemon does not store are simply never present.
   */
  modelConfigs?: ModelConfig[];
  hasApiKey: boolean;
  apiKeyMasked: string;
  /** app-foundation D8: absent reads as enabled. */
  enabled?: boolean;
  /** app-parity child 1: optional non-secret scalar fields (absent = prior default). */
  isOfficial?: boolean;
  apiVersion?: string;
  maxConcurrency?: number;
  modelsEndpoint?: string;
  /**
   * app-parity child 5: optional provider transformer config (the provider-level
   * `use[]` chain + any per-model keys preserved verbatim). Non-secret —
   * round-trips verbatim. PERSISTED-NOT-ENFORCED: the daemon stores it but derives
   * its transform chain from `apiFormat`, so this is the STORED config view (the
   * count badge + the minimal editor), not a routing claim.
   */
  transformer?: TransformerConfig;
  /**
   * app-parity-2 child 3: optional coding-plan endpoint, MASKED — the secret
   * `apiKey` is NEVER returned (only `hasApiKey`). Enforced by core's
   * `resolveProviderEndpoint`. Absent for a row with no coding-plan.
   */
  codingPlan?: { enabled: boolean; baseUrl?: string; hasApiKey: boolean; note?: string };
  /**
   * app-parity-2 child 4: optional API modes, MASKED — each mode's secret `apiKey`
   * is NEVER returned (only a per-mode `hasApiKey`). Enforced by core's
   * `resolveProviderEndpoint` (layer 1). Absent for a row with no modes.
   */
  apiModes?: Array<{ id: string; label: string; baseUrl: string; hasApiKey: boolean; apiKeyPrefix?: string; note?: string }>;
  selectedApiModeId?: string;
}

/** `GET /admin/api/providers/:id/keys` pool-health row (masked). */
export interface DaemonPoolKeyView {
  id: string;
  label: string;
  enabled: boolean;
  weight: number;
  apiKeyMasked: string;
  health?: {
    cooldown?: { until: number; errors: number; lastStatus: number | null };
    autoDisabled?: { status: number; at: number; reason: string };
  };
}

/** `GET /admin/api/presets` row. */
export interface DaemonPresetView {
  id: string;
  presetId: string;
  name: string;
  apiFormat: 'openai' | 'anthropic' | 'gemini';
  baseUrl: string;
  models: string[];
}

/** `POST /admin/api/providers/:id/discover-models` response. */
export interface DaemonDiscoverResponse {
  models: string[];
  unsupportedFormat?: boolean;
  error?: string;
}

/** `POST /admin/api/providers/:id/test` result (provider key NEVER echoed). */
export interface ModelTestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  message?: string;
  sample?: string;
  unsupportedFormat?: boolean;
}

// ── The LLM-config API subset the page calls ────────────────────────────────────
//
// Mirrors the upstream `AgentLLMConfigApi` for the methods the ported page invokes.
// Methods the daemon does not back (router/transformer/coding-plan/default-models
// CRUD) are intentionally OMITTED — the page never calls them.
export interface AgentLLMConfigApi {
  getProviders(): Promise<LLMProvider[]>;
  getProvider(id: string): Promise<LLMProvider | null>;
  /**
   * Return the DECRYPTED stored API key for a provider (the "view key"
   * affordance). The BYO key is stored reversibly at rest, so unlike the masked
   * list this returns the real key — only on this explicit per-key request.
   * `apiKey` is '' when no key is stored.
   */
  revealProviderKey?(id: string): Promise<{ success: boolean; apiKey?: string; message?: string }>;
  addProvider(payload: LLMProviderInput): Promise<LLMProviderResult>;
  updateProvider(payload: LLMProviderUpdateInput & { id: string }): Promise<LLMProviderResult>;
  deleteProvider(id: string): Promise<{ success: boolean; message?: string }>;
  toggleProvider(id: string, enabled: boolean): Promise<LLMProviderResult>;
  reorderProviders(orderedIds: string[]): Promise<{ success: boolean; message?: string }>;
  resetProvider(id: string): Promise<LLMProviderResult>;
  discoverModels(id: string, options?: { forceRefresh?: boolean }): Promise<ProviderModelDiscoveryResult>;
  /** Issue one minimal upstream completion for `model` via the provider's key. */
  testModel(providerId: string, model: string): Promise<ModelTestResult>;
  addFromPreset(payload: {
    presetId: string;
    apiKey?: string;
    enabled?: boolean;
  }): Promise<LLMProviderResult>;
  // API key pool — READ + MUTATIONS are daemon-backed (app-parity child 3). Each
  // mutation maps a provider-scoped pool-key write endpoint and returns the masked
  // entry (the submitted key is never echoed back); a failure returns
  // `{ success: false }` (never fake success). The daemon routes are
  // provider-scoped, so the mutation signatures carry `providerId` (D7 option a) —
  // this is the app-local interface, NOT shared with the host.
  getApiKeys(providerId: string): Promise<ApiKeyEntry[]>;
  getKeyHealth(providerId: string): Promise<KeyHealthMap>;
  addApiKey(input: ApiKeyEntryInput): Promise<{ success: boolean; entry?: ApiKeyEntry; message?: string }>;
  updateApiKey(
    providerId: string,
    id: string,
    updates: Partial<Pick<ApiKeyEntry, 'label' | 'weight' | 'enabled' | 'apiKey'>>,
  ): Promise<{ success: boolean; entry?: ApiKeyEntry; message?: string }>;
  deleteApiKey(providerId: string, id: string): Promise<{ success: boolean; message?: string }>;
  toggleApiKey(
    providerId: string,
    id: string,
    enabled: boolean,
  ): Promise<{ success: boolean; message?: string }>;
  // Preset catalog (used by the preset grid)
  getPresets(): Promise<DaemonPresetView[]>;
}

// ── API Service adapter (server config + status + named-key CRUD) ─────────────

/** Create-key result carrying the one-time `plaintextOnce`, or a failure. */
export type CreateKeyResult =
  | { success: true; created: OutboundApiKeyCreated }
  | { success: false; message: string };

/**
 * `agent.apiService` — the daemon server-config + status + keys surface. All
 * mutations return `{ success, message? }` (never fake success). `updateEndpoint`
 * rebuilds the FULL endpoints array from the last-loaded config (trap D9.1).
 */
export interface AgentApiServiceApi {
  getConfig(): Promise<OutboundApiServerConfig | null>;
  getStatus(): Promise<OutboundApiServerStatus | null>;
  setEnabled(enabled: boolean): Promise<MutationResult>;
  setNetworkBinding(networkBinding: boolean): Promise<MutationResult>;
  updateEndpoint(endpoint: EndpointRoutingConfig): Promise<MutationResult>;
  /**
   * Set a key's outbound concurrency ceiling (`POST /keys/:id/max-concurrency`).
   * `null` clears the ceiling → unlimited. Mirrors `setKeyEnabled`'s `{ ok }`
   * handling (`ok:false` → "key not found").
   */
  setKeyMaxConcurrency(id: string, maxConcurrency: number | null): Promise<MutationResult>;
  /**
   * Set a key's policy envelope (`POST /keys/:id/policy`, outbound-key-policy):
   * expiry / activation / cost limits / per-key rate. Each field is three-way
   * (omit keeps, `null` clears, value sets). Mirrors `setKeyMaxConcurrency`'s
   * `{ ok }` handling.
   */
  setKeyPolicy(id: string, policy: OutboundKeyPolicyPatch): Promise<MutationResult>;
  /**
   * Persist one or both queue-config segments (`PUT /server`), reusing the
   * `applyServerPut` cache-refresh + `incomplete-model-config` envelope handling.
   * Send only the changed segment(s).
   */
  updateQueueConfig(patch: {
    userMessageQueue?: OutboundApiServerConfig['userMessageQueue'];
    concurrencyQueue?: OutboundApiServerConfig['concurrencyQueue'];
  }): Promise<MutationResult>;
  /**
   * Persist the layered upstream proxy segment (`PUT /server` with `{ proxy }`,
   * upstream-proxy). Pass `undefined` to clear all global/provider layers. The
   * daemon preserves each untouched layer's write-only password.
   */
  updateProxyConfig(proxy: OutboundApiServerConfig['proxy'] | undefined): Promise<MutationResult>;
  listKeys(): Promise<OutboundApiKeyInfo[]>;
  createKey(name: string): Promise<CreateKeyResult>;
  revokeKey(id: string): Promise<MutationResult>;
  setKeyEnabled(id: string, enabled: boolean): Promise<MutationResult>;
}

// ── Accounts adapter (subscription token management) ──────────────────────────

/** Write-token result — status-only (the submitted token NEVER round-trips). */
export interface WriteTokensResult {
  success: boolean;
  status?: SubscriptionListEntry;
  message?: string;
}

/** Result of an OAuth `start` — the public authorize URL + an opaque session id. */
export interface StartOAuthResult {
  authUrl: string;
  sessionId: string;
}

/**
 * Result of an active-account token refresh. `ok` is the daemon's HONEST refresh
 * outcome (false → no refresh token / upstream refresh failed); `status` is the
 * re-read token-free entry. `success` is false only on a transport/HTTP error.
 */
export interface RefreshResult {
  success: boolean;
  ok?: boolean;
  status?: SubscriptionListEntry;
  message?: string;
}

/**
 * Token-free codex loopback sign-in status (app-parity-2 child 5). The daemon
 * captures + persists the token entirely server-side; this poll body NEVER carries
 * a token (`message` is a loopback/exchange failure reason on `error`).
 */
export interface CodexOAuthStatus {
  state: 'pending' | 'done' | 'error';
  message?: string;
}

/**
 * `agent.accounts` — the subscription-account surface. `writeTokens` serializes
 * ONLY the per-provider allowlisted fields (deny-by-default) and reads back only
 * the sanitized status. `startOAuth`/`completeOAuth` drive the daemon's two-phase
 * interactive OAuth login for the OAuth-capable providers (claude/gemini); the
 * submitted code crosses IN only — the minted token never round-trips back.
 */
export interface AgentAccountsApi {
  list(): Promise<AccountsListResponse>;
  /** Replace the ACTIVE account's credential (token-paste parity). */
  writeTokens(payload: AccountTokenInput): Promise<WriteTokensResult>;
  /**
   * APPEND a new account (+ activate it) with an optional label. The only path
   * that adds a second manual account (the generic write replaces the active one).
   */
  appendTokens(payload: AccountTokenInput, label?: string): Promise<WriteTokensResult>;
  setActive(providerId: SubscriptionProviderId, id: string): Promise<MutationResult>;
  removeAccount(providerId: SubscriptionProviderId, accountId: string): Promise<MutationResult>;
  /** Rename one account's label (label-only; no token touched). */
  renameAccount(
    providerId: SubscriptionProviderId,
    accountId: string,
    label: string,
  ): Promise<MutationResult>;
  /** Set one account's scheduling priority (subscription-account-scheduling;
   *  secret-free, lower = higher precedence). */
  setAccountPriority(
    providerId: SubscriptionProviderId,
    accountId: string,
    priority: number,
  ): Promise<MutationResult>;
  /** Set (or CLEAR, with `undefined`) one account's per-account proxy override
   *  (upstream-proxy). The proxy password is masked on read + preserved write-only. */
  setAccountProxy(
    providerId: SubscriptionProviderId,
    accountId: string,
    proxy: ProxyConfig | undefined,
  ): Promise<MutationResult>;
  /** Set (or CLEAR, with `undefined`) one account's `supportedModels`
   *  (subscription-account-model-map) — an array allow-list (skip-only) or an
   *  object logical→actual remap. Secret-free (model ids only). */
  setAccountSupportedModels(
    providerId: SubscriptionProviderId,
    accountId: string,
    supportedModels: string[] | Record<string, string> | undefined,
  ): Promise<MutationResult>;
  /** Refresh the ACTIVE account's OAuth token (claude/codex/gemini only). */
  refreshProvider(providerId: SubscriptionProviderId): Promise<RefreshResult>;
  clearProvider(providerId: SubscriptionProviderId): Promise<MutationResult>;
  startOAuth(providerId: SubscriptionProviderId): Promise<StartOAuthResult>;
  completeOAuth(
    providerId: SubscriptionProviderId,
    input: { sessionId: string; code: string; label?: string },
  ): Promise<WriteTokensResult>;
  /**
   * Poll a codex loopback sign-in's status (app-parity-2 child 5). codex is
   * loopback+poll (not code-paste): `startOAuth('codex')` arms the daemon loopback,
   * the browser completes the redirect, and this polls the token-free status until
   * `done`/`error`. The token is captured + persisted entirely daemon-side.
   */
  pollCodexOAuth(sessionId: string): Promise<CodexOAuthStatus>;
  /**
   * Import the daemon machine's external CLI login (~/.claude/.credentials.json
   * / ~/.codex/auth.json) as a new managed account (external-cli-sync). The
   * read + append happen entirely daemon-side; the response is status-only.
   */
  importExternalCli(providerId: 'claude' | 'codex', label?: string): Promise<MutationResult>;
}

// ── Code CLI launch adapter (dashboard parity) ────────────────────────────────

/** One launchable CLI + whether its binary is on the daemon host's PATH. */
export interface CliStatus {
  id: string;
  displayName: string;
  command: string;
  installed: boolean;
  /** Has a known global install command (the card shows an Install button). */
  installable: boolean;
}

/** A running launch (token-free — the route token rides only the terminal env). */
export interface CliSession {
  id: string;
  cli: string;
  providerId: string;
  model: string;
  startedAt: string;
}

/** Result of a launch — sessionId + the resolved provider/model, or a failure. */
export interface CliLaunchResult {
  success: boolean;
  sessionId?: string;
  providerId?: string;
  model?: string;
  message?: string;
}

/**
 * `agent.cli` — the Code CLI launch surface. `launch` opens an external terminal
 * (on the daemon host) running the CLI pointed at the daemon proxy; the route
 * token never crosses back to the dashboard (it rides only the terminal env).
 */
export interface AgentCliApi {
  list(): Promise<CliStatus[]>;
  /** Run the CLI's global install command on the daemon host (npm/curl). */
  install(cli: string): Promise<MutationResult>;
  launch(
    cli: string,
    input?: { cwd?: string; providerId?: string; model?: string },
  ): Promise<CliLaunchResult>;
  sessions(): Promise<CliSession[]>;
  stop(id: string): Promise<MutationResult>;
}
