/**
 * Shared contract types for the outbound API server (`outbound-api-server`).
 *
 * The outbound server is a SEPARATE long-lived HTTP listener (distinct from the
 * resident loopback `ProviderProxy`) that authenticates external callers via
 * named API keys and routes their requests through the EXISTING `provider-proxy`
 * ingress parsers + transformer — there is exactly one conversion stack.
 *
 * These types are kept in their own module so the server, router, auth, rate
 * limiter, role detection, and route resolver can share shapes without circular
 * imports.
 *
 * @module outbound-api/types
 */

import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { ProviderProxy } from '../provider-proxy';
import type { ProviderProxyDeps } from '../provider-proxy';

/** The four endpoints, 1:1 with the four wire-format ingress parsers. */
export type OutboundEndpoint = 'chat' | 'responses' | 'messages' | 'gemini';

/** A `"providerId,modelId"` model reference (mirrors `RouterConfig` vocab). */
export type ModelRef = string;

/** The detected request role; precedence background > default. */
export type RequestRole = 'background' | 'default';

/**
 * SSOT of the canonical model KINDS per kind-mapped endpoint.
 *
 * The `messages` (Claude Code) and `responses` (Codex) endpoints route by model
 * KIND rather than role: the user configures one upstream ref per kind, and an
 * incoming versioned client id (`claude-opus-4-8-2026xxxx`) is classified to its
 * kind (`opus`) so CLI upgrades need no reconfig. `chat`/`gemini` are NOT in this
 * map — they keep the role-based (`default`/`background`) config.
 */
export const ENDPOINT_MODEL_KINDS = {
  messages: ['fable', 'opus', 'sonnet', 'haiku'],
  responses: ['codex', 'mini'],
} as const;

/** The endpoints that route by model kind (`messages` | `responses`). */
export type KindMappedEndpoint = keyof typeof ENDPOINT_MODEL_KINDS;
/** Claude Code (`messages`) kinds. */
export type MessagesModelKind = (typeof ENDPOINT_MODEL_KINDS)['messages'][number];
/** Codex (`responses`) kinds. */
export type ResponsesModelKind = (typeof ENDPOINT_MODEL_KINDS)['responses'][number];
/** Any canonical model kind across the kind-mapped endpoints. */
export type ModelKind = MessagesModelKind | ResponsesModelKind;

/**
 * Per-endpoint routing config. Persisted independently of the global
 * "默认模型" settings tab; survives restart.
 *
 * The shape is HETEROGENEOUS by endpoint class:
 *  - kind-mapped (`messages`/`responses`): `modelMap` (kind → ref) is authoritative;
 *    everything else is unused.
 *  - list-mapped (`chat`): `models` (a list of refs) is authoritative — the
 *    client requests one of the listed modelIds directly (`GET /v1/models`
 *    serves the list); no default/background roles.
 *  - role-based (`gemini`): `defaultModel`/`backgroundModel` (+ optional
 *    `backgroundModelIds`) are authoritative.
 */
export interface EndpointRoutingConfig {
  /** Which of the four endpoints this block configures. */
  endpoint: OutboundEndpoint;
  /**
   * Kind-mapped endpoints (`messages`/`responses`): model KIND → `"providerId,modelId"`.
   * Keys are the endpoint's declared {@link ENDPOINT_MODEL_KINDS}.
   */
  modelMap?: Record<string, ModelRef>;
  /**
   * List-mapped endpoint (`chat`): the `"providerId,modelId"` refs this endpoint
   * serves. The ref's modelId is the model name the client requests and the name
   * `GET /v1/models` advertises; a request whose `model` is not in the list is
   * rejected per-request (404-style). Empty ⇒ endpoint unused.
   */
  models?: ModelRef[];
  /** Role-based endpoint (`gemini`): model for normal requests. */
  defaultModel?: ModelRef;
  /** Role-based endpoint (`gemini`): model for background/probe requests. */
  backgroundModel?: ModelRef;
  /** Gates subscription-vs-BYO provider selection. Default FALSE. */
  useSubscription: boolean;
  /**
   * OPTIONAL "background model id" override list (role-based `gemini` only).
   * When set, an incoming requested model id appearing in this list is
   * classified as the BACKGROUND role; otherwise the registry small/haiku-class
   * signal is the baseline. Empty/unset → registry signal only. Compared against
   * the requested model id (bare or `providerId,modelId`).
   */
  backgroundModelIds?: string[];
}

/**
 * User-message serial-queue segment (per-upstream-account 防风控). Frozen
 * defaults + valid ranges (SSOT + clamp in `apiServerConfig`):
 *  - `enabled`       default **false** (opt-in).
 *  - `delayMs`       default **200**, valid `0..10000` — min gap between one
 *                    account's serialized requests.
 *  - `waitTimeoutMs` default **60000**, valid `1000..300000` — a waiter past
 *                    this rejects (wire → 503).
 */
export interface UserMessageQueueConfig {
  enabled: boolean;
  delayMs: number;
  waitTimeoutMs: number;
}

/**
 * Per-key concurrency-queue segment (排队而非硬拒). Frozen defaults + valid
 * ranges (SSOT + clamp in `apiServerConfig`):
 *  - `maxQueueSizeFactor` default **2**, valid `1..10` — per-key max queued =
 *    `max(limit*factor, minQueueSize)`.
 *  - `minQueueSize`       default **4**, valid `1..100` — floor of the above.
 *  - `waitTimeoutMs`      default **60000**, valid `1000..300000` — a waiter
 *    past this rejects (wire → 429).
 */
export interface ConcurrencyQueueConfig {
  maxQueueSizeFactor: number;
  minQueueSize: number;
  waitTimeoutMs: number;
}

/** The persisted server config. */
export interface OutboundApiServerConfig {
  /** When false the listener never binds (off by default). */
  enabled: boolean;
  /** When true the listener binds `0.0.0.0` (LAN) instead of `127.0.0.1`. */
  networkBinding: boolean;
  /** Per-endpoint routing config, one per endpoint (4 entries). */
  endpoints: EndpointRoutingConfig[];
  /** Persisted port (fixed default; falls back to ephemeral on EADDRINUSE). */
  port?: number;
  /**
   * User-message serial queue segment. Optional in the persisted shape;
   * `normalizeServerConfig` always fills it with the frozen defaults, so a
   * normalized config carries it.
   */
  userMessageQueue?: UserMessageQueueConfig;
  /**
   * Per-key concurrency queue segment. Optional in the persisted shape;
   * `normalizeServerConfig` always fills it with the frozen defaults.
   */
  concurrencyQueue?: ConcurrencyQueueConfig;
}

/** A live status snapshot the Settings tab renders. */
export interface OutboundApiServerStatus {
  running: boolean;
  /** Actual bound port (0 when not running). */
  port: number;
  /** Loopback base URL (always present when running). */
  loopbackUrl: string | null;
  /** LAN base URL (present only when network binding is on). */
  lanUrl: string | null;
  /** The four format endpoint URLs (loopback). */
  formats: OutboundFormatUrls | null;
  /** The four format endpoint URLs over the LAN (only when network binding on). */
  lanFormats: OutboundFormatUrls | null;
}

/** The four format endpoint URLs for one base. */
export interface OutboundFormatUrls {
  chat: string;
  responses: string;
  messages: string;
  gemini: string;
}

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
   * Per-key concurrency ceiling for the outbound concurrency gate. Absent or
   * `0` = unlimited (the gate is bypassed entirely for this key).
   */
  maxConcurrency?: number;
}

/** The one-time create result; `plaintextOnce` is shown exactly once. */
export interface OutboundApiKeyCreated {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  plaintextOnce: string;
}

/**
 * Structural subset of the DB the outbound server needs — the named-key CRUD
 * surface. Kept structural so the server module does not depend on the full
 * `DbRpc`.
 */
export interface OutboundKeyDbRow {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /**
   * Per-key concurrency ceiling. Absent/`0` = unlimited = the concurrency gate
   * is bypassed for this key. Persisted by the daemon (`omnicross-uqc-daemon`).
   */
  maxConcurrency?: number;
}

export interface OutboundKeyDb {
  outboundApiKeysList(): Promise<OutboundKeyDbRow[]>;
  outboundApiKeysGetByHash(hash: string): Promise<OutboundKeyDbRow | null>;
  outboundApiKeysCreate(input: {
    id: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    createdAt?: number;
  }): Promise<OutboundKeyDbRow>;
  outboundApiKeysRevoke(id: string): Promise<boolean>;
  outboundApiKeysTouchLastUsed(id: string): Promise<boolean>;
  outboundApiKeysSetEnabled(id: string, enabled: boolean): Promise<boolean>;
  /**
   * Set (or clear) a key's per-key concurrency ceiling. `null` clears the field
   * → unlimited (gate bypassed). Mirrors `outboundApiKeysSetEnabled`; returns
   * `false` when the key is missing/revoked. Implemented by the daemon
   * (`omnicross-uqc-daemon`); test fakes implement it inline.
   */
  outboundApiKeysSetMaxConcurrency(
    id: string,
    maxConcurrency: number | null,
  ): Promise<boolean>;
}

/**
 * App-session-scoped dependencies the outbound server needs. The resident
 * `ProviderProxy` is shared so the new listener mints routes on the SAME route
 * map and reuses the SAME ingress parsers + transformer.
 */
export interface OutboundApiDeps {
  readonly db: OutboundKeyDb;
  readonly llmConfig: ProviderConfigSource;
  /** The resident proxy — shared for route minting + ingress dispatch. */
  readonly providerProxy: ProviderProxy;
  /** The proxy's app-session deps (reused verbatim for `routeRequest`). */
  readonly proxyDeps: ProviderProxyDeps;
}
