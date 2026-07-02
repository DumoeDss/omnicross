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

/** The persisted server config (`{ server: ... }` from `GET /server`). */
export interface OutboundApiServerConfig {
  enabled: boolean;
  networkBinding: boolean;
  endpoints: EndpointRoutingConfig[];
  port?: number;
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
