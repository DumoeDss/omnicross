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

/** A `"providerId,modelId"` model reference. */
export type ModelRef = string;

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
  /** Role-based endpoint (`gemini`): model for normal requests. */
  defaultModel?: ModelRef;
  /** Role-based endpoint (`gemini`): model for background/probe requests. */
  backgroundModel?: ModelRef;
  /** Gates subscription-vs-BYO provider selection. Default false. */
  useSubscription: boolean;
  /** Optional per-endpoint background-model id override list (role-based only). */
  backgroundModelIds?: string[];
}

/**
 * One incomplete kind-mapped endpoint and the kinds it is missing — mirrors
 * mkm-core's `EndpointModelConfigError`. Returned by the daemon's enable PUT when
 * a kind-mapped endpoint lacks required mappings (the "service can't start"
 * envelope, `{ error: { code: 'incomplete-model-config', missing } }`).
 */
export interface OutboundModelConfigError {
  endpoint: OutboundEndpointId;
  missingKinds: string[];
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

/** The persisted server config (`{ server: ... }` from `GET /server`). */
export interface OutboundApiServerConfig {
  enabled: boolean;
  networkBinding: boolean;
  endpoints: EndpointRoutingConfig[];
  port?: number;
  /** Per-account serial queue (OPTIONAL — absent on a pre-upgrade daemon). */
  userMessageQueue?: OutboundUserMessageQueueConfig;
  /** Per-key concurrency queue (OPTIONAL — absent on a pre-upgrade daemon). */
  concurrencyQueue?: OutboundConcurrencyQueueConfig;
  /**
   * Layered upstream proxy (upstream-proxy). OPTIONAL — absent on a pre-upgrade
   * daemon or when no proxy is configured. Passwords are masked on GET.
   */
  proxy?: OutboundProxyConfig;
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

/** Live status snapshot (`GET /admin/api/status`). */
export interface OutboundApiServerStatus {
  running: boolean;
  /** Actual bound port (0 when not running). */
  port: number;
  loopbackUrl: string | null;
  lanUrl: string | null;
  formats: OutboundFormatUrls | null;
  lanFormats: OutboundFormatUrls | null;
  /** Read-only per-endpoint projection (see `OutboundStatusEndpoint`). */
  endpoints: OutboundStatusEndpoint[];
  /**
   * Live queue activity (planning-context §COMMITTED §4). OPTIONAL — the daemon
   * spreads it into `GET /status` only when the server is running; a pre-upgrade
   * daemon omits it and the status view stays silent.
   */
  queueStatus?: OutboundQueueStatus;
}

// ── Named keys (GET/POST /admin/api/keys + revoke/enabled) ────────────────────

/** A stored key DTO (never carries the plaintext secret). */
export interface OutboundApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
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
  plaintextOnce: string;
}
