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

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { AuditConfig } from '@omnicross/contracts/audit-types';
import type { HealthReport } from '@omnicross/contracts/health-logging-types';
import type { WebhookConfig } from '@omnicross/contracts/webhook-types';

import type { Logger } from '../ports/logger';
import type { ProviderConfigSource } from '../ports/provider-config-source';
import type { ProviderProxy } from '../provider-proxy';
import type { ProviderProxyDeps } from '../provider-proxy';

import type { KeySpendReader } from './keySpendTracker';

/** The four endpoints, 1:1 with the four wire-format ingress parsers. */
export type OutboundEndpoint = 'chat' | 'responses' | 'messages' | 'gemini';

/** A `"providerId,modelId"` model reference (mirrors `RouterConfig` vocab). */
export type ModelRef = string;

/** The detected request role; precedence background > default. */
export type RequestRole = 'background' | 'default';

/**
 * Dispatch mode for the list-mapped `chat` endpoint (openai-chat-bridge #11).
 *  - `'list'` (default): the client requests one of the endpoint's configured
 *    `models` refs by modelId — the exact current behavior (zero regression).
 *  - `'prefix'`: the requested model's NAME PREFIX (`claude-*` / `gpt-*` /
 *    `gemini-*`) selects a configured target from {@link ModelPrefixTargets},
 *    on a single `/v1/chat/completions` — a routing convenience over the same
 *    conversion machinery. An unmatched prefix is a clear per-request error.
 */
export type ChatDispatchMode = 'list' | 'prefix';

/**
 * Prefix → target `"providerId,modelId"` ref map for the `chat` endpoint's
 * `dispatchMode: 'prefix'` (openai-chat-bridge #11). Each target may be a
 * subscription (e.g. `claude,claude-sonnet-4-5`) or a BYO ref — the same ref
 * vocabulary the list mode uses. Absent prefixes are simply unroutable in prefix
 * mode. The vocabulary is the three core prefixes (claude / gpt / gemini);
 * additional prefixes (deepseek, …) are an additive-later extension.
 */
export interface ModelPrefixTargets {
  claude?: ModelRef;
  gpt?: ModelRef;
  gemini?: ModelRef;
}

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
  /**
   * List-mapped endpoint (`chat`) dispatch mode (openai-chat-bridge #11). Absent
   * ⇒ `'list'` (default) — routing is byte-identical to before this change. Only
   * `'prefix'` changes behavior (route by model-name prefix via `prefixTargets`).
   */
  dispatchMode?: ChatDispatchMode;
  /**
   * List-mapped endpoint (`chat`) prefix → target map, consumed ONLY when
   * `dispatchMode === 'prefix'` (openai-chat-bridge #11). Ignored in list mode.
   */
  prefixTargets?: ModelPrefixTargets;
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

/**
 * Subscription account-health segment (subscription-account-health, LEAD OQ1).
 * Persisted + strictly validated like the queue segments; applied to the shared
 * `SubscriptionAccountHealth` tracker at daemon boot.
 *  - `overloadCooldownEnabled` default **true** — a 529 places the account in
 *    overload cooldown (ON by default; CRS ships it off).
 *  - `overloadCooldownMs`      default **600000** (10 min), valid `60000..3600000`.
 */
export interface AccountHealthConfig {
  overloadCooldownEnabled: boolean;
  overloadCooldownMs: number;
}

/**
 * Scheduled account-probe segment (subscription-account-probe, #8 health-cron).
 * The active complement to #2's passive health machine: a cheap, staggered,
 * default-OFF background probe that discovers a dead/expired account BEFORE real
 * traffic does. Persisted + range-clamped like `accountHealth`; consumed by the
 * daemon `AccountHealthProbeScheduler` (an `unref()`ed interval — omnicross has
 * no cron dep). ALL knobs are load-safety valves:
 *  - `enabled`          default **false** (zero regression — no probes, no /health
 *                       boolean, byte-identical when off).
 *  - `intervalMs`       default **900000** (15 min), valid `60000..86400000`.
 *  - `onlyMultiAccount` default **true** — probe only providers with ≥2 accounts
 *                       (where #2 health-gating actually matters; a single-account
 *                       provider is never probed — #2 keeps it schedulable anyway).
 *  - `timeoutMs`        default **5000** per upstream probe, valid `1000..60000`.
 *  - `historySize`      default **10** rolling per-account records, valid `1..200`.
 *  - `staggerMs`        default **500** gap between consecutive probes, valid
 *                       `0..60000` (so N accounts never fire N simultaneous GETs).
 */
export interface AccountProbeConfig {
  enabled: boolean;
  intervalMs: number;
  onlyMultiAccount: boolean;
  timeoutMs: number;
  historySize: number;
  staggerMs: number;
}

/**
 * Layered upstream-proxy segment (upstream-proxy). Global + per-provider proxy
 * config for outbound EGRESS to upstreams (NOT the inbound listener). Resolved
 * with precedence account > provider > global > env; the per-account layer lives
 * on the account entry (`SubscriptionAccountEntry.proxy`), not here. Absent ⇒ no
 * proxy at these layers (direct fetch). `byProvider` keys are subscription
 * provider ids (`claude`/`codex`/`gemini`/`opencodego`) or `'byo'`. A `ProxyConfig`
 * `password` is a SECRET — encrypted at rest + masked in the admin GET.
 */
export interface OutboundProxyConfig {
  /** Applies to every upstream unless a more specific layer overrides. */
  global?: ProxyConfig;
  /** Per-provider override, keyed by subscription provider id or `'byo'`. */
  byProvider?: Record<string, ProxyConfig>;
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
  /**
   * Subscription account-health segment. Optional in the persisted shape;
   * `normalizeServerConfig` always fills it with the frozen defaults. Applied to
   * the shared health tracker at daemon boot (change takes effect on restart).
   */
  accountHealth?: AccountHealthConfig;
  /**
   * Scheduled account-probe segment (subscription-account-probe #8). Optional in
   * the persisted shape; `normalizeServerConfig` always fills it with the frozen
   * defaults (enabled:false). Read by the daemon `AccountHealthProbeScheduler` at
   * boot; a change takes effect on restart. Default-off ⇒ no scheduler runs.
   */
  accountProbe?: AccountProbeConfig;
  /**
   * Layered upstream-proxy segment (upstream-proxy). Optional; when absent no
   * global/provider proxy applies (direct egress). `normalizeServerConfig` drops
   * malformed entries but does NOT synthesize a default (a missing proxy segment
   * stays absent — zero-config = direct fetch).
   */
  proxy?: OutboundProxyConfig;
  /**
   * Webhook notification segment (webhook-notifications). Optional; when absent
   * (or `enabled:false`) the emit sink is never wired ⇒ `emitWebhookEvent` is a
   * no-op ⇒ byte-identical zero regression. `normalizeServerConfig` drops
   * malformed destinations but does NOT synthesize a default (a missing webhook
   * segment stays absent). A destination `secret` is encrypted at rest + masked
   * in admin views.
   */
  webhook?: WebhookConfig;
  /**
   * Request-audit segment (request-audit-log). Optional; when absent (or
   * `enabled:false`) no capture config or sink is wired ⇒ the capture hook does
   * nothing ⇒ byte-identical zero regression. `normalizeServerConfig` always
   * fills it with the frozen defaults (enabled:false). Read by the daemon at boot
   * + admin PUT to (un)register the core sink + capture config; a change takes
   * effect immediately (hot-reloaded like `webhook`). Carries NO secret.
   */
  audit?: AuditConfig;
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
  // ── Key-policy envelope (outbound-key-policy). All optional; a policy-less key
  //    carries none of these and behaves exactly as before this change. ────────
  /** Fixed-mode absolute expiry (epoch ms). */
  expiresAt?: number | null;
  /** Expiry mode; absent ⇒ `'fixed'`. */
  activationMode?: OutboundKeyActivationMode;
  /** Activation-mode lifetime in days. */
  activationDays?: number | null;
  /** First-use activation stamp (epoch ms); written once, surfaced read-only. */
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
  // ── Per-key model restriction (outbound-key-policy #6). All optional; the
  //    master gate is `enableModelRestriction` — false/unset ⇒ no check. ────────
  /** Master switch: when false/unset the model list is inert (no restriction). */
  enableModelRestriction?: boolean;
  /** Restriction mode; absent ⇒ `'blacklist'` (CRS-parity). */
  restrictionMode?: OutboundKeyModelRestrictionMode;
  /** The model-id list the mode acts on (bare modelIds; empty allowlist denies all). */
  restrictedModels?: string[];
  /**
   * The key's OWN accumulated spend (outbound-key-policy), surfaced by the admin
   * so an operator sees spend-vs-limit. Present only when the host wired a spend
   * reader. Leak-safe: each key carries only ITS own numbers — the same data the
   * key's holder already sees in a 402 body.
   */
  spend?: { dailyUsd: number; weeklyUsd: number; totalUsd: number };
}

/** Expiry mode for an outbound key: fixed absolute vs first-use activation. */
export type OutboundKeyActivationMode = 'fixed' | 'activation';

/**
 * Per-key model-restriction mode (outbound-key-policy #6). `blacklist` denies the
 * listed models; `allowlist` permits ONLY the listed models (an empty allowlist
 * denies everything — a deliberate "disabled by model" state).
 */
export type OutboundKeyModelRestrictionMode = 'blacklist' | 'allowlist';

/**
 * The settable key-policy envelope (`outboundApiKeysSetPolicy`). Every field is
 * three-way: a value SETS, explicit `null` CLEARS, and OMISSION keeps the stored
 * value (mirrors the `maxConcurrency` write contract). `activatedAt` is NOT here
 * — it is written once by `outboundApiKeysMarkActivated`, never operator-set.
 * The #6/#9 children extend this shape; do not drift the frozen fields.
 */
export interface OutboundKeyPolicy {
  expiresAt?: number | null;
  activationMode?: OutboundKeyActivationMode | null;
  activationDays?: number | null;
  dailyCostLimitUsd?: number | null;
  totalCostLimitUsd?: number | null;
  weeklyCostLimitUsd?: number | null;
  rateLimitMaxRequests?: number | null;
  rateLimitWindowMs?: number | null;
  // Per-key model restriction (#6). Three-way like the rest of the envelope.
  enableModelRestriction?: boolean | null;
  restrictionMode?: OutboundKeyModelRestrictionMode | null;
  restrictedModels?: string[] | null;
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
  // ── Key-policy envelope (outbound-key-policy). All optional/nullable; existing
  //    rows (+ tests) parse unchanged and a row with none behaves as before. ────
  /** Fixed-mode absolute expiry (epoch ms). */
  expiresAt?: number | null;
  /** Expiry mode; absent ⇒ `'fixed'`. */
  activationMode?: OutboundKeyActivationMode;
  /** Activation-mode lifetime in days. */
  activationDays?: number | null;
  /** First-use activation stamp (epoch ms); written ONCE on first successful use. */
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
  // ── Per-key model restriction (outbound-key-policy #6). All optional; existing
  //    rows parse unchanged and a row with `enableModelRestriction` off behaves
  //    exactly as before. ───────────────────────────────────────────────────────
  /** Master switch; false/unset ⇒ no model check (zero-regression gate). */
  enableModelRestriction?: boolean;
  /** Restriction mode; absent ⇒ `'blacklist'`. */
  restrictionMode?: OutboundKeyModelRestrictionMode;
  /** The model-id list the mode acts on (bare modelIds). */
  restrictedModels?: string[];
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
  /**
   * Set (or clear) a key's policy envelope (expiry / activation window / cost
   * limits / per-key rate) in one write (outbound-key-policy). Each field is
   * three-way — a value sets, explicit `null` clears, omission keeps — mirroring
   * `outboundApiKeysSetMaxConcurrency`. Returns `false` when the key is
   * missing/revoked. Does NOT touch `activatedAt`.
   */
  outboundApiKeysSetPolicy(id: string, policy: OutboundKeyPolicy): Promise<boolean>;
  /**
   * Stamp the one-time first-use activation (`activatedAt`) for an
   * activation-mode key. Best-effort like `outboundApiKeysTouchLastUsed`; a
   * no-op returning `false` when the key is missing/revoked or already
   * activated (the original stamp is never overwritten — activation is
   * idempotent).
   */
  outboundApiKeysMarkActivated(id: string, activatedAt: number): Promise<boolean>;
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
  /**
   * OPTIONAL unauthenticated `/health` provider (daemon-health-endpoint, D1
   * secondary mount). When wired (by the daemon bootstrap — core NEVER imports
   * daemon), the server serves `GET|HEAD /health` (+ `/healthz`) BEFORE its
   * per-request key-auth, so an orchestrator can probe the TRAFFIC port. Absent
   * ⇒ `/health` is not mounted and falls through to normal auth (byte-identical
   * zero-regression for embedders that do not wire it).
   */
  readonly healthReportProvider?: () => HealthReport;
  /**
   * OPTIONAL per-key spend reader (outbound-key-policy). When wired (by the
   * daemon bootstrap), a key carrying a cost limit is checked against its
   * accumulated spend before dispatch (→ 402). Absent ⇒ NO cost-quota check runs
   * (byte-identical zero-regression for embedders/tests that do not wire it, and
   * for every policy-less key regardless).
   */
  readonly keySpendTracker?: KeySpendReader;
  /**
   * OPTIONAL injected logger (configurable-logging). When wired (by the daemon
   * bootstrap), the server's OWN lifecycle lines (listen/stop/error) + the relay
   * dispatch-error route through it — so they honor the configured level / format
   * / file sink. Absent ⇒ the legacy `console.*` fallback (byte-identical for
   * embedders/tests that do not wire it).
   */
  readonly logger?: Logger;
}
