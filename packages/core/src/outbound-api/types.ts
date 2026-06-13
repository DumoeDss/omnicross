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

/** The detected request role; precedence vision > background > default. */
export type RequestRole = 'vision' | 'background' | 'default';

/**
 * Per-endpoint routing config. Persisted independently of the global
 * "默认模型" settings tab; survives restart.
 */
export interface EndpointRoutingConfig {
  /** Which of the four endpoints this block configures. */
  endpoint: OutboundEndpoint;
  /** REQUIRED — model for normal (non-vision, non-background) requests. */
  defaultModel: ModelRef;
  /** REQUIRED — model for background/probe/small-task requests. */
  backgroundModel: ModelRef;
  /** OPTIONAL — model for requests carrying image/vision content. */
  visionModel?: ModelRef;
  /** Gates subscription-vs-BYO provider selection. Default FALSE. */
  useSubscription: boolean;
  /**
   * OPTIONAL per-endpoint "background model id" override list (human decision
   * after the proposal). When set, an incoming requested model id appearing in
   * this list is classified as the BACKGROUND role; otherwise the registry
   * small/haiku-class signal is the baseline. Empty/unset → registry signal
   * only. Compared against the requested model id (bare or `providerId,modelId`).
   */
  backgroundModelIds?: string[];
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
