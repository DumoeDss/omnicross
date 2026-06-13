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
 * `defaultModel`/`backgroundModel`/`visionModel` are `"providerId,modelId"` refs.
 */
export interface EndpointRoutingConfig {
  endpoint: OutboundEndpointId;
  /** Model for normal (non-vision, non-background) requests. */
  defaultModel: ModelRef;
  /** Model for background/probe/small-task requests. */
  backgroundModel: ModelRef;
  /** Optional model for requests carrying image/vision content. */
  visionModel?: ModelRef;
  /** Gates subscription-vs-BYO provider selection. Default false. */
  useSubscription: boolean;
  /** Optional per-endpoint background-model id override list. */
  backgroundModelIds?: string[];
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
 * The status `endpoints` projection (READ-ONLY). NOTE the field is `model`, not
 * `defaultModel` — edits must drive off `GET /server`, never this projection.
 */
export interface OutboundStatusEndpoint {
  endpoint: OutboundEndpointId;
  model: ModelRef;
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
