/**
 * types-server.ts — hand-mirrored daemon admin-API DTOs for the API Service page
 * (server config + live status + named-key CRUD).
 *
 * These mirror the daemon's `outbound-api/types.ts` wire shapes (verified in
 * recon). They are re-typed here (not imported from the daemon) so the app stays
 * a standalone HTTP client with no daemon source dependency.
 */

// ── Server config (GET/PUT /admin/api/server) ────────────────────────────────

/** The four endpoint ids, 1:1 with the four wire-format ingress parsers. */
export type OutboundEndpointId = 'chat' | 'responses' | 'messages' | 'gemini';
/** Named-key authorization vocabulary; Images is not a text routing endpoint. */
export type OutboundPermissionId = OutboundEndpointId | 'images';

export type AccountRouteSessionSource =
  | 'session-header'
  | 'thread-header'
  | 'body-session-id'
  | 'body-thread-id'
  | 'prompt-cache-key'
  | 'content-fingerprint'
  | 'api-key-fallback'
  | 'none';

export type AccountRouteAffinity = 'new' | 'sticky' | 'switched' | 'untracked';

/** Metadata-only recent subscription routing record from the daemon. */
export interface AccountRouteActivityRecord {
  id: string;
  ts: number;
  durationMs: number;
  providerId: string;
  accountId: string;
  endpoint: 'responses' | 'messages';
  sessionKey?: string;
  sessionSource: AccountRouteSessionSource;
  model: string;
  status: number;
  affinity: AccountRouteAffinity;
  previousAccountId?: string;
  /**
   * Post-hoc error observed inside the (200) stream — e.g. a Codex
   * `response.failed` server-overload event. Present only when the daemon
   * annotated the row after the fact; absent on healthy responses. Older
   * daemons never set this.
   */
  streamError?: string;
}

export interface AccountRouteActivityResponse {
  /** False when the connected daemon does not expose the activity endpoint. */
  available: boolean;
  records: AccountRouteActivityRecord[];
  capacity: number;
  collectedAt: number;
}

/** Metadata-only per-account tally of Codex server-overload events. */
export interface OverloadCounterEntry {
  providerId: string;
  accountId: string;
  endpoint: 'responses' | 'messages';
  /** Lifetime count of overload events for this key. */
  count: number;
  firstTs: number;
  lastTs: number;
  /** Most-recent-first epoch-ms events (bounded), the sparkline's source. */
  recent: number[];
}

export interface OverloadCounterResponse {
  /** False when the connected daemon does not expose the overload endpoint. */
  available: boolean;
  entries: OverloadCounterEntry[];
  collectedAt: number;
}

/** A `"providerId,modelId"` model reference. */
export type ModelRef = string;

/** Bound-account behavior; pool fallback is an explicit opt-in. */
export type BoundAccountFallbackPolicy = 'strict' | 'pool';
export type GatewayBindingFallback = 'next' | 'fail';
export type GatewayBindingKeyScope = 'all' | 'selected';
export type GatewayBindingModelMode = 'passthrough' | 'mapped';

export interface GatewayModelMapping {
  source: string;
  target: ModelRef;
}

export type GatewayBindingTarget =
  | { kind: 'account'; providerId: string; accountId: string }
  | { kind: 'account-group'; providerId: string; group: string }
  | { kind: 'account-pool'; providerId: string }
  | { kind: 'provider'; providerId: string; keyId?: string };

export interface GatewayBinding {
  id: string;
  name: string;
  enabled: boolean;
  keyScope?: GatewayBindingKeyScope;
  apiKeyIds?: string[];
  endpoint: OutboundEndpointId;
  target: GatewayBindingTarget;
  priority?: number;
  fallback: GatewayBindingFallback;
  modelMode?: GatewayBindingModelMode;
  modelMappings?: GatewayModelMapping[];
  modelMap?: Record<string, ModelRef>;
  models?: ModelRef[];
  dispatchMode?: 'list' | 'prefix';
  prefixTargets?: { claude?: ModelRef; gpt?: ModelRef; gemini?: ModelRef };
  defaultModel?: ModelRef;
  backgroundModel?: ModelRef;
  backgroundModelIds?: string[];
}

/**
 * Per-endpoint routing config (the editable shape from `GET /server`).
 *
 * HETEROGENEOUS by endpoint class (mirrors mkm-core's `EndpointRoutingConfig` —
 * PINNED to `@omnicross/core/outbound-api`; update here in lockstep):
 *  - kind-mapped (`messages`/`responses`): `modelMap` (kind → `"providerId,modelId"`)
 *    is authoritative; `defaultModel`/`backgroundModel` are unused.
 *  - list-mapped (`chat`): `models` (a list of refs) is authoritative — the
 *    refs' modelIds are the names `GET /v1/models` advertises.
 *  - role-based (`gemini`): `defaultModel`/`backgroundModel` (+ optional
 *    `backgroundModelIds`) are authoritative; `modelMap` is unused.
 *
 * The legacy `visionModel` field is REMOVED (model-kind-mapping).
 */
export interface EndpointRoutingConfig {
  endpoint: OutboundEndpointId;
  /**
   * Kind-mapped endpoints (`messages`/`responses`): model KIND → `"providerId,modelId"`.
   * Keys are the endpoint's declared kinds (see `ENDPOINT_MODEL_KINDS`).
   */
  modelMap?: Record<string, ModelRef>;
  /** List-mapped endpoint (`chat`): the refs this endpoint serves. */
  models?: ModelRef[];
  dispatchMode?: 'list' | 'prefix';
  prefixTargets?: { claude?: ModelRef; gpt?: ModelRef; gemini?: ModelRef };
  /** Role-based endpoint (`gemini`): model for normal requests. */
  defaultModel?: ModelRef;
  /** Role-based endpoint (`gemini`): model for background/probe requests. */
  backgroundModel?: ModelRef;
  /** Gates subscription-vs-BYO provider selection. Default false. */
  useSubscription: boolean;
  /** Subscription mode: bind one specific account id; blank ⇒ account pool. */
  boundAccountId?: string;
  /** When bound account cannot serve: strict failure (default) or pool fallback. */
  boundAccountFallbackPolicy?: BoundAccountFallbackPolicy;
  /** Provider mode: bind one specific BYO key id; blank ⇒ default key / key pool. */
  boundKeyId?: string;
  /** When the bound provider key is unavailable: strict failure or key-pool fallback. */
  boundKeyFallbackPolicy?: BoundAccountFallbackPolicy;
  /** Optional per-endpoint background-model id override list (role-based only). */
  backgroundModelIds?: string[];
}

/**
 * Per-account serial queue config (`userMessageQueue`) — mirrored from
 * `planning-context.md` §COMMITTED interfaces §1 (omnicross-user-queue-concurrency).
 * OPTIONAL so a pre-upgrade daemon response still type-checks; the queue card
 * falls back to the frozen defaults `{ enabled:false, delayMs:200, waitTimeoutMs:60000 }`.
 * Valid ranges: `delayMs` 0..10000, `waitTimeoutMs` 1000..300000.
 */
export interface OutboundUserMessageQueueConfig {
  enabled: boolean;
  delayMs: number;
  waitTimeoutMs: number;
}

/**
 * Per-key concurrency queue config (`concurrencyQueue`) — mirrored from
 * `planning-context.md` §COMMITTED §1. Frozen defaults
 * `{ maxQueueSizeFactor:2, minQueueSize:4, waitTimeoutMs:60000 }`. Each key's max
 * queue depth = `max(limit * maxQueueSizeFactor, minQueueSize)`. Valid ranges:
 * `maxQueueSizeFactor` 1..10, `minQueueSize` 1..100, `waitTimeoutMs` 1000..300000.
 */
export interface OutboundConcurrencyQueueConfig {
  maxQueueSizeFactor: number;
  minQueueSize: number;
  waitTimeoutMs: number;
}

/**
 * Upstream proxy descriptor (upstream-proxy) — mirrors the daemon `ProxyConfig`.
 * Either a full proxy `url` or a structured form. On a GET the `password` is
 * ALWAYS masked (dropped from the structured form / stripped from the url), so a
 * value read back never carries the secret; a PUT with the password omitted
 * preserves the stored one (write-only).
 */
export type ProxyConfig =
  | { url: string }
  | {
      type: 'http' | 'https' | 'socks5';
      host: string;
      port: number;
      username?: string;
      password?: string;
    };

/**
 * Layered global + per-provider proxy segment (`server.proxy`). `byProvider` keys
 * are subscription provider ids (`claude`/`codex`/`gemini`/`opencodego`) or `'byo'`.
 * Absent ⇒ no global/provider proxy configured (direct egress).
 */
export interface OutboundProxyConfig {
  global?: ProxyConfig;
  byProvider?: Record<string, ProxyConfig>;
}

/** Webhook destination type (webhook-notifications) — v1: custom + feishu. */
export type WebhookDestinationType = 'custom' | 'feishu';

/** Webhook event kinds a destination filter may select. */
export type WebhookEventKind =
  | 'account.recovery'
  | 'account.anomaly'
  | 'key.quotaWarning'
  | 'key.quotaExceeded'
  | 'server.error'
  | 'test';

/**
 * One webhook destination (webhook-notifications). On a GET the `secret` is
 * masked (a sentinel signals presence); a PUT omitting/masking it preserves the
 * stored value (write-only).
 */
export interface WebhookDestination {
  id: string;
  type: WebhookDestinationType;
  url: string;
  secret?: string;
  events?: WebhookEventKind[];
  enabled: boolean;
}

/** The `server.webhook` segment (webhook-notifications). Absent ⇒ inert. */
export interface WebhookConfig {
  enabled: boolean;
  destinations: WebhookDestination[];
}

/** The `server.audit` segment (request-audit-log) — mirrors the daemon `AuditConfig`. */
export interface AuditConfig {
  /** Master switch; false/absent ⇒ no capture (zero regression). */
  enabled: boolean;
  /** Capture request/response bodies too (redacted and optionally truncated). */
  captureBodies: boolean;
  /** Per-body truncation cap in bytes; `-1` means unlimited. */
  maxBodyBytes: number;
  /** TTL retention in days. */
  retentionDays: number;
  /** Merge streaming text deltas in a captured response body (default false). */
  compactStreamingBodies: boolean;
  /** Trust `X-Forwarded-For` for the client IP (anti-spoof; default false). */
  trustForwardedFor: boolean;
}

/** The `server.billing` segment (billing-event-stream) — mirrors the daemon `BillingConfig`. */
export interface BillingConfig {
  /** Master switch; false/absent ⇒ no publish (zero regression). */
  enabled: boolean;
  /** POST target for built-in delivery; absent ⇒ ledger-only mode (append, no push). */
  endpoint?: string;
  /** HMAC signing key — a SECRET (masked on GET). */
  secret?: string;
  /** Stop re-POSTing an undelivered event after this age (ms). */
  maxRetryAgeMs: number;
}

/** The `server.fingerprint` segment (subscription-client-fingerprint #7). */
export interface FingerprintConfig {
  /** Master switch; false/absent ⇒ no capture/replay ⇒ byte-identical outbound. */
  enabled: boolean;
  /** Operator UA baseline for un-captured accounts (never a fabricated stainless). */
  ua?: string;
}

/** Default-off allowance-aware subscription account scheduling policy. */
export interface AllowanceSchedulingConfig {
  enabled: boolean;
  demoteAtPercent: number;
  pauseAtPercent: number;
  priorityPenalty: number;
}

export type AllowanceSchedulingAction = 'normal' | 'demote' | 'pause' | 'ignore';

/** Secret-free record of an applied demotion/pause scheduling decision. */
export interface AllowanceSchedulingDecision {
  providerId: 'claude' | 'codex' | 'gemini' | 'opencodego';
  accountId: string;
  action: AllowanceSchedulingAction;
  reason:
    | 'policy-disabled'
    | 'provider-unsupported'
    | 'snapshot-missing'
    | 'snapshot-not-fresh'
    | 'below-threshold'
    | 'demote-threshold'
    | 'pause-threshold';
  basePriority: number;
  effectivePriority: number;
  schedulable: boolean;
  usedPercent?: number;
  observedAt?: string;
  resumeAt?: string;
  decidedAt: string;
}

export interface AccountAllowanceSchedulingStatus {
  config: AllowanceSchedulingConfig;
  history: AllowanceSchedulingDecision[];
}

/** The `server.voucher` segment (voucher-redemption #9). */
export interface VoucherConfig {
  /** Master switch; false/absent ⇒ redeem endpoint inert + no admin generate. */
  enabled: boolean;
}

/** Card type: credit adds USD, renewal extends expiry. */
export type VoucherType = 'credit' | 'renewal';
/** Card lifecycle. */
export type VoucherStatus = 'unredeemed' | 'redeemed' | 'revoked';

/** Admin-safe voucher DTO from `GET /admin/api/voucher` (NEVER the code hash). */
export interface VoucherInfo {
  id: string;
  codePrefix: string;
  type: VoucherType;
  creditUsd?: number;
  renewalDays?: number;
  maxTotalCostLimitUsd?: number;
  maxExpiryDays?: number;
  status: VoucherStatus;
  createdAt: number;
  redeemedAt?: number;
  redeemedByKeyId?: string;
  /** Whether the grant has been applied to the key (redeemed cards only). */
  grantApplied?: boolean;
  grantedTotalCostLimitUsd?: number;
  grantedExpiresAt?: number;
  revokedAt?: number;
}

/** The one-time generate result — `plaintextOnce` is shown exactly once. */
export interface VoucherCreated {
  id: string;
  codePrefix: string;
  type: VoucherType;
  createdAt: number;
  plaintextOnce: string;
}

/** Aggregate delivery status from `GET /admin/api/billing-status` (billing-event-stream). */
export interface BillingDeliveryStatus {
  total: number;
  delivered: number;
  pending: number;
}

/** One audit record returned by `GET /admin/api/audit` (request-audit-log). */
export interface AuditRecord {
  id: string;
  ts: number;
  keyId?: string | null;
  ip?: string;
  ua?: string;
  method: string;
  path: string;
  model?: string;
  provider?: string;
  status: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
  /** Derived conversation-session key (a digest) grouping the turns of one chat. */
  sessionKey?: string;
  /** Whether a captured body exists in the per-session store for this record. */
  hasBody?: boolean;
  /** Only a pre-sharding record still carries a body inline. */
  requestBody?: string;
  responseBody?: string;
}

/** Metadata-only aggregate returned by `GET /admin/api/audit/stats`. */
export interface AuditStats {
  requestCount: number;
  errorCount: number;
  complete: boolean;
}

export interface ImageApiLimits {
  maxJsonBytes: number;
  maxMultipartBytes: number;
  maxFileBytes: number;
  maxTotalInputBytes: number;
  maxFiles: number;
  maxFields: number;
  maxParts: number;
  maxHeaderPairs: number;
  maxFieldNameBytes: number;
  maxFieldValueBytes: number;
  maxPixels: number;
  maxRawBytes: number;
  maxOutputBytes: number;
  maxTotalOutputBytes: number;
  maxSpoolBytes: number;
  maxRedirects: number;
  maxRemoteUrlBytes: number;
  maxRemoteHeaderBytes: number;
  remoteConnectTimeoutMs: number;
  remoteTotalTimeoutMs: number;
}

export interface ImagesServerConfig {
  enabled: boolean;
  provider: 'codex-subscription';
  defaultModel: string;
  modelAliases: Record<string, string>;
  account: { id?: string; group?: string; fallback: 'strict' | 'pool' };
  queue: {
    maxConcurrentJobsPerAccount: number;
    maxQueuedJobs: number;
    queueTimeoutMs: number;
    generationTimeoutMs: number;
  };
  temporary: {
    maxActiveScopes: number;
    maxTotalBytes: number;
    maxTenantBytes: number;
    staleAfterMs: number;
    cleanupIntervalMs: number;
  };
  limits: ImageApiLimits;
  references: {
    ttlMs: number;
    maxArtifactBytes: number;
    maxTotalBytes: number;
    maxTenantBytes: number;
    maxEntries: number;
    maxCalls: number;
    maxResponses: number;
    maxTombstones: number;
    tombstoneTtlMs: number;
    cleanupIntervalMs: number;
    /** Write-only custom root. Admin reads omit the path. */
    storageRoot?: string;
    /** Safe admin-read marker; strip before writing the strict config segment. */
    storageRootConfigured?: boolean;
  };
  remote: { enabled: boolean };
  evidenceTtlMs: number;
}

// ── Search config (the masked `server.search` segment) ───────────────────────

/** Who executes a search for one protocol frontend. */
export type SearchFrontendMode = 'native' | 'managed' | 'off';
export type SearchFrontendName = 'codex' | 'responses' | 'anthropic';
export type SearchFrontendModes = Record<SearchFrontendName, SearchFrontendMode>;

/** Tavily: key required, host overridable. */
export interface TavilyProviderConfig {
  /** Write-only on PUT (string sets, blank/omitted keeps); never in a read. */
  apiKey?: string | null;
  /** Admin-read marker; strip before writing. */
  apiKeyConfigured?: boolean;
  apiHost?: string;
}
/** Jina: key optional — the entry alone enables the keyless provider. */
export interface JinaProviderConfig {
  /** Write-only on PUT; JSON `null` explicitly clears this optional key. */
  apiKey?: string | null;
  /** Admin-read marker; strip before writing. */
  apiKeyConfigured?: boolean;
  apiHost?: string;
}
/** SearXNG: host required; Basic-auth pair optional, password secret. */
export interface SearxngProviderConfig {
  apiHost?: string;
  basicAuthUsername?: string;
  /** Write-only on PUT; JSON `null` explicitly clears this optional secret. */
  basicAuthPassword?: string | null;
  /** Admin-read marker; strip before writing. */
  basicAuthPasswordConfigured?: boolean;
}
/** Zhipu and Z.AI: one wire contract, two ids. */
export interface ZhipuProviderConfig {
  /** Write-only on PUT (string sets, blank/omitted keeps); never in a read. */
  apiKey?: string | null;
  /** Admin-read marker; strip before writing. */
  apiKeyConfigured?: boolean;
  apiHost?: string;
}

/**
 * The masked admin view of `server.search.providers`. The daemon NEVER sends
 * `apiKey` / `basicAuthPassword` values — only the `*Configured` markers (the
 * Images `storageRootConfigured` convention). Every marker is an admin-read
 * projection; strip it before writing the segment back.
 */
export interface SearchApiProviderConfigs {
  tavily?: TavilyProviderConfig;
  jina?: JinaProviderConfig;
  searxng?: SearxngProviderConfig;
  zhipu?: ZhipuProviderConfig;
  'z.ai'?: ZhipuProviderConfig;
}

/**
 * The masked `search` segment as the admin GET/PUT-echo carries it. Secrets are
 * write-only: the adapter rebuilds the FULL segment on PUT from the last loaded
 * (masked) config and the daemon preserves omitted/blanked stored secrets.
 */
export interface SearchServerConfig {
  modes: SearchFrontendModes;
  providers: SearchApiProviderConfigs;
  egress: { allowedPrivateHosts: string[] };
  policy: {
    preferred?: string;
    allowed?: string[];
    fallbackEnabled: boolean;
    maxAttempts?: number;
  };
}

/** One offline diagnostics row (the doctor's projection, secret-free). */
export interface SearchDoctorRow {
  providerId: string;
  source: 'builtin' | 'host';
  kind: 'api' | 'http' | 'local-browser' | 'native';
  capabilities: {
    requiresApiKey: boolean;
    supportsCancellation: boolean;
    supportsUrlRead: boolean;
    supportsRegion: boolean;
    supportsLanguage: boolean;
    supportsTimeRange: boolean;
    maxResults?: number;
  };
  /** Present only on `unconfigured` rows. */
  status?: 'healthy' | 'degraded' | 'blocked' | 'failed' | 'unconfigured';
  /** What is missing, for an `unconfigured` row. Never echoes a value. */
  reason?: string;
}

/** `GET /admin/api/search/diagnostics` body (`null` on an older daemon). */
export interface SearchDiagnosticsSnapshot {
  rows: SearchDoctorRow[];
  /** Effective modes: codex from the live config, the rest as bootstrapped. */
  modes: SearchFrontendModes;
  applySemantics: { codex: 'immediate'; rest: 'restart' };
}

/** The sanitized error shape a test diagnostic may carry (never a secret). */
export interface SearchErrorShape {
  code: string;
  message: string;
  providerId?: string;
  retryable?: boolean;
  details?: Record<string, string>;
}

/** One per-provider fixed-query test outcome (status only — never results). */
export interface SearchTestResult {
  providerId: string;
  status: 'healthy' | 'degraded' | 'blocked' | 'failed';
  checkedAt?: string;
  reason?: string;
  error?: SearchErrorShape;
  /** Present on healthy/degraded outcomes. */
  resultCount?: number;
}

/** One sanitized interactive-query result (untrusted input — render as text). */
export interface SearchQueryResultItem {
  title: string;
  url: string;
  content: string;
}

/**
 * `POST /admin/api/search/query` result body (search-settings-tab): the
 * doctor-classified diagnostic PLUS the sanitized results (≤5, per-field caps
 * applied daemon-side before serialization). `results`/`resultCount` are
 * present only on the success arm; a failure carries the diagnostic only.
 */
export interface SearchQueryResult {
  diagnostic: SearchTestResult;
  resultCount?: number;
  results?: SearchQueryResultItem[];
}

/** The persisted server config (`{ server: ... }` from `GET /server`). */
export interface OutboundApiServerConfig {
  enabled: boolean;
  networkBinding: boolean;
  endpoints: EndpointRoutingConfig[];
  /** Resource-centric routes; absent on older daemons. */
  bindings?: GatewayBinding[];
  port?: number;
  /** Per-account serial queue (OPTIONAL — absent on a pre-upgrade daemon). */
  userMessageQueue?: OutboundUserMessageQueueConfig;
  /** Per-key concurrency queue (OPTIONAL — absent on a pre-upgrade daemon). */
  concurrencyQueue?: OutboundConcurrencyQueueConfig;
  /** Allowance-aware account scheduling. Optional for compatibility with older daemons. */
  allowanceScheduling?: AllowanceSchedulingConfig;
  /**
   * Layered upstream proxy (upstream-proxy). OPTIONAL — absent on a pre-upgrade
   * daemon or when no proxy is configured. Passwords are masked on GET.
   */
  proxy?: OutboundProxyConfig;
  /**
   * Webhook notifications (webhook-notifications). OPTIONAL — absent on a
   * pre-upgrade daemon or when unconfigured. Destination secrets are masked on GET.
   */
  webhook?: WebhookConfig;
  /**
   * Request audit (request-audit-log). OPTIONAL — absent on a pre-upgrade daemon.
   * Carries no secret. `normalizeServerConfig` always fills it (enabled:false).
   */
  audit?: AuditConfig;
  /**
   * Billing event stream (billing-event-stream). OPTIONAL — absent on a
   * pre-upgrade daemon. The HMAC secret is masked on GET.
   * `normalizeServerConfig` always fills it (enabled:false).
   */
  billing?: BillingConfig;
  /**
   * Client fingerprint (subscription-client-fingerprint #7). OPTIONAL — absent on
   * a pre-upgrade daemon. Carries no secret. `normalizeServerConfig` always fills
   * it (enabled:false). A change takes effect on daemon restart.
   */
  fingerprint?: FingerprintConfig;
  /**
   * Voucher redemption (voucher-redemption #9). OPTIONAL — absent on a pre-upgrade
   * daemon. Carries no secret. `normalizeServerConfig` always fills it
   * (enabled:false). When enabled, the key-self-serve `POST /redeem` endpoint +
   * the admin generate/revoke surface are active.
   */
  voucher?: VoucherConfig;
  /** Default-off Images policy; absent only on older daemons. */
  images?: ImagesServerConfig;
  /**
   * Search runtime config (search-settings-ui). OPTIONAL — absent only on
   * pre-Phase-1 daemons. Provider secrets are MASKED on GET (presence markers
   * only); the daemon preserves stored secrets for omitted/blanked fields on PUT.
   */
  search?: SearchServerConfig;
}

// ── Live status (GET /admin/api/status) ──────────────────────────────────────

/** The four format endpoint URLs for one base. */
export interface OutboundFormatUrls {
  chat: string;
  responses: string;
  messages: string;
  gemini: string;
}

/**
 * The status `endpoints` projection (READ-ONLY). Class-aware — kind-mapped
 * endpoints (`messages`/`responses`) carry a `kinds` summary of their `modelMap`;
 * role-based endpoints (`chat`/`gemini`) carry a single `model` (the
 * `defaultModel`). Edits must drive off `GET /server`, never this projection.
 */
export interface OutboundStatusEndpoint {
  endpoint: OutboundEndpointId;
  /** Role-based (`gemini`) projected default model. */
  model?: ModelRef;
  /** Kind-mapped (`messages`/`responses`) kind → ref summary. */
  kinds?: Record<string, ModelRef>;
  /** List-mapped (`chat`) configured model refs. */
  models?: ModelRef[];
  useSubscription: boolean;
}

/**
 * Live queue-status snapshot (planning-context §COMMITTED §4). Each array carries
 * ONLY entries with current activity (empty array = nothing queued). Absent
 * entirely when the server is not running or the daemon is pre-upgrade.
 */
export interface OutboundQueueStatus {
  /** Per-provider serial-queue state (only providers with a holder/waiters). */
  serial: Array<{ providerId: string; holding: boolean; waiting: number }>;
  /** Per-key concurrency-gate state (only keys with active/waiting requests). */
  concurrency: Array<{ apiKeyId: string; active: number; waiting: number }>;
}

export interface ImageEndpointUrls {
  generations: string;
  edits: string;
}

export interface ImageRuntimeResourceStatus {
  queue: {
    activeJobs: number;
    waitingJobs: number;
    activeAccounts: number;
    waitingAccounts: number;
    waitingTenants: number;
    maxConcurrentJobsPerAccount: number;
    maxQueuedJobs: number;
    accepting: boolean;
    shuttingDown: boolean;
  };
  temporary: {
    activeScopes: number;
    totalBytes: number;
    tenantCount: number;
    maxActiveScopes: number;
    maxTotalBytes: number;
    maxTenantBytes: number;
  };
  storage: {
    mounts: number;
    retiredMounts: number;
    referenceEntries: number;
    referenceBytes: number;
    referenceTombstones: number;
    stateCalls: number;
    stateResponses: number;
    stateTombstones: number;
    pendingReferenceDeletes: number;
    maxReferenceEntries: number;
    maxReferenceBytes: number;
    maxTenantReferenceBytes: number;
    maxStateCalls: number;
    maxStateResponses: number;
  };
}

export interface ImagesCapabilityStatus {
  configured: {
    enabled: boolean;
    provider: 'codex-subscription';
    model: string;
    remoteUrlsEnabled: boolean;
    referenceTtlMs: number;
  };
  effective: {
    available: boolean;
    reason: string | null;
    evidence: { verifiedAt: number; ageMs: number; expiresAt?: number } | null;
    features: {
      available: boolean;
      models: string[];
      generate: boolean;
      edit: boolean;
      maskEdit: boolean;
      maxInputImages: number;
      maxOutputImages: number;
      streaming: boolean;
      maxPartialImages: number;
      transparentBackground: boolean;
      flexibleSizes: boolean;
      outputFormats: string[];
      qualityLevels: string[];
      moderationModes: string[];
      outputCompression: { supported: false } | {
        supported: true;
        formats: string[];
        min: number;
        max: number;
      };
      responsesTool: boolean;
      multiTurnEdit: boolean;
      supportsFileId: boolean;
      supportsImageUrl: boolean;
    };
  };
  runtime: {
    disposed: boolean;
    generationId: string;
    drainingCount: number;
    draining: Array<{
      generationId: string;
      enabled: boolean;
      httpLeases: number;
      hostedLeases: number;
    }>;
    resources?: ImageRuntimeResourceStatus;
  };
  endpoints: ImageEndpointUrls | null;
  lanEndpoints: ImageEndpointUrls | null;
}

/** Live status snapshot (`GET /admin/api/status`). */
export interface OutboundApiServerStatus {
  running: boolean;
  /** Actual bound port (0 when not running). */
  port: number;
  loopbackUrl: string | null;
  lanUrl: string | null;
  formats: OutboundFormatUrls | null;
  lanFormats: OutboundFormatUrls | null;
  /** Additive Images URLs; absent on older daemons and while disabled. */
  images?: ImageEndpointUrls;
  lanImages?: ImageEndpointUrls;
  /** Read-only per-endpoint projection (see `OutboundStatusEndpoint`). */
  endpoints: OutboundStatusEndpoint[];
  /**
   * Live queue activity (planning-context §COMMITTED §4). OPTIONAL — the daemon
   * spreads it into `GET /status` only when the server is running; a pre-upgrade
   * daemon omits it and the status view stays silent.
   */
  queueStatus?: OutboundQueueStatus;
  /** Additive metadata-only Images runtime summary. */
  imageRuntime?: {
    enabled: boolean;
    generationId: string;
    drainingCount: number;
    resources?: ImageRuntimeResourceStatus;
  };
}

// ── Named keys (GET/POST /admin/api/keys + revoke/enabled) ────────────────────

/** A stored key DTO (never carries the plaintext secret). */
export interface OutboundApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  /**
   * Whether the operator "view key" affordance is available — true only when a
   * reversible secret was persisted at creation. Absent on pre-upgrade daemon
   * responses and legacy hash-only rows (read as not revealable).
   */
  revealable?: boolean;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  kind?: 'client' | 'integration';
  allowedEndpoints?: OutboundPermissionId[];
  /** Explicit compatibility marker from upgraded daemons; never contains key material. */
  legacyPermissions?: boolean;
  loopbackOnly?: boolean;
  /**
   * Per-key outbound concurrency ceiling (planning-context §COMMITTED §2). Absent
   * or 0 = unlimited (the concurrency gate is bypassed for this key). OPTIONAL so a
   * pre-upgrade daemon response type-checks.
   */
  maxConcurrency?: number;
  // ── Key-policy envelope (outbound-key-policy). All optional/secret-free; a
  //    pre-upgrade daemon omits them (they read as absent = unset). ─────────────
  /** Fixed-mode absolute expiry (epoch ms). */
  expiresAt?: number | null;
  /** Expiry mode; absent ⇒ `'fixed'`. */
  activationMode?: 'fixed' | 'activation';
  /** Activation-mode lifetime in days. */
  activationDays?: number | null;
  /** First-use activation stamp (epoch ms); read-only (server-stamped). */
  activatedAt?: number | null;
  /** Daily USD cost cap. */
  dailyCostLimitUsd?: number | null;
  /** Lifetime USD cost cap. */
  totalCostLimitUsd?: number | null;
  /** Weekly USD cost cap. */
  weeklyCostLimitUsd?: number | null;
  /** Per-key rate-limit max requests per window (absent ⇒ 60; `0` ⇒ unlimited). */
  rateLimitMaxRequests?: number | null;
  /** Per-key rate-limit window (ms; absent ⇒ 60_000). */
  rateLimitWindowMs?: number | null;
  // ── Per-key model restriction (outbound-key-policy #6). All optional; a
  //    pre-upgrade daemon omits them (they read as absent = unset). ─────────────
  /** Master switch; false/unset ⇒ no model check. */
  enableModelRestriction?: boolean;
  /** Restriction mode; absent ⇒ `'blacklist'`. */
  restrictionMode?: 'blacklist' | 'allowlist';
  /** The model-id list the mode acts on (bare modelIds). */
  restrictedModels?: string[];
  /**
   * The key's OWN accumulated spend (outbound-key-policy), surfaced by the admin
   * so an operator sees spend-vs-limit. Present only when the daemon wired a
   * spend reader; leak-safe (this key's numbers only).
   */
  spend?: { dailyUsd: number; weeklyUsd: number; totalUsd: number };
}

/**
 * The settable key-policy patch (`POST /admin/api/keys/:id/policy`). Each field
 * is three-way: OMITTED keeps, `null` clears, a value sets. `activatedAt` is not
 * settable (server-stamped on first use).
 */
export interface OutboundKeyPolicyPatch {
  expiresAt?: number | null;
  activationMode?: 'fixed' | 'activation' | null;
  activationDays?: number | null;
  dailyCostLimitUsd?: number | null;
  totalCostLimitUsd?: number | null;
  weeklyCostLimitUsd?: number | null;
  rateLimitMaxRequests?: number | null;
  rateLimitWindowMs?: number | null;
  // Per-key model restriction (#6). Three-way like the rest of the patch.
  enableModelRestriction?: boolean | null;
  restrictionMode?: 'blacklist' | 'allowlist' | null;
  restrictedModels?: string[] | null;
}

/**
 * The one-time create result. `plaintextOnce` is the FULL client key, returned
 * exactly once — show it once, never store or re-fetch it.
 */
export interface OutboundApiKeyCreated {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  allowedEndpoints?: OutboundPermissionId[];
  plaintextOnce: string;
}
