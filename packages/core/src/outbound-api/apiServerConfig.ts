/**
 * apiServerConfig — load / save / default the outbound API server config
 * (`outbound-api-server`, design D4).
 *
 * The config (`{ enabled, networkBinding, endpoints, port }`) is persisted via
 * a small key/value store (the app SettingsService) under a single key, so it
 * survives restart. Defaults: disabled, loopback, four blank endpoints +
 * `useSubscription` OFF, default port. The per-endpoint shape is heterogeneous:
 * kind-mapped endpoints (`messages`/`responses`) carry a blank `modelMap` (one
 * key per declared kind); role-based endpoints (`chat`/`gemini`) carry blank
 * `defaultModel`/`backgroundModel`. NO legacy migration — `normalizeServerConfig`
 * drops unknown/legacy fields (incl. `visionModel`) and fills blanks. Shared by
 * the router and the bootstrap wiring so both read/write the same shape.
 *
 * @module outbound-api/apiServerConfig
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import { type AuditConfig, DEFAULT_AUDIT_CONFIG } from '@omnicross/contracts/audit-types';
import {
  WEBHOOK_DESTINATION_TYPES,
  WEBHOOK_EVENT_KINDS,
  type WebhookConfig,
  type WebhookDestination,
  type WebhookEventKind,
} from '@omnicross/contracts/webhook-types';

import { isKindMappedEndpoint, modelKindsForEndpoint } from './kindDetection';
import { DEFAULT_OUTBOUND_PORT } from './OutboundApiServer';
import type {
  AccountHealthConfig,
  AccountProbeConfig,
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  ModelPrefixTargets,
  ModelRef,
  OutboundApiServerConfig,
  OutboundEndpoint,
  OutboundProxyConfig,
  UserMessageQueueConfig,
} from './types';

/** The settings key the config persists under. */
export const OUTBOUND_API_SERVER_CONFIG_KEY = 'outboundApiServer.config';

/**
 * Frozen defaults for the user-message serial queue segment (SSOT). Note the
 * `waitTimeoutMs` default is **60000** — the office-hours draft's 30000 is
 * superseded by the user's拍板 / planning-context §COMMITTED.
 */
export const DEFAULT_USER_MESSAGE_QUEUE: UserMessageQueueConfig = {
  enabled: false,
  delayMs: 200,
  waitTimeoutMs: 60_000,
};

/** Frozen defaults for the per-key concurrency queue segment (SSOT). */
export const DEFAULT_CONCURRENCY_QUEUE: ConcurrencyQueueConfig = {
  maxQueueSizeFactor: 2,
  minQueueSize: 4,
  waitTimeoutMs: 60_000,
};

/**
 * Frozen defaults for the subscription account-health segment (SSOT). LEAD OQ1:
 * 529 overload cooldown ON by default, bounded 10 min.
 */
export const DEFAULT_ACCOUNT_HEALTH: AccountHealthConfig = {
  overloadCooldownEnabled: true,
  overloadCooldownMs: 10 * 60_000,
};

/** Fill + range-CLAMP the account-health segment to the frozen defaults. */
export function normalizeAccountHealth(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AccountHealthConfig {
  const ah = raw?.accountHealth;
  return {
    overloadCooldownEnabled: ah?.overloadCooldownEnabled !== false,
    overloadCooldownMs: clampNumber(
      ah?.overloadCooldownMs,
      60_000,
      3_600_000,
      DEFAULT_ACCOUNT_HEALTH.overloadCooldownMs,
    ),
  };
}

/**
 * Frozen defaults for the scheduled account-probe segment (SSOT,
 * subscription-account-probe #8). Default OFF (zero regression); a 15-min cadence,
 * multi-account-only, short timeout, small rolling history, staggered — every knob
 * a load-safety valve (see `AccountProbeConfig`).
 */
export const DEFAULT_ACCOUNT_PROBE: AccountProbeConfig = {
  enabled: false,
  intervalMs: 15 * 60_000,
  onlyMultiAccount: true,
  timeoutMs: 5_000,
  historySize: 10,
  staggerMs: 500,
};

/** Fill + range-CLAMP the account-probe segment to the frozen defaults. */
export function normalizeAccountProbe(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AccountProbeConfig {
  const ap = raw?.accountProbe;
  return {
    enabled: ap?.enabled === true,
    intervalMs: clampNumber(ap?.intervalMs, 60_000, 86_400_000, DEFAULT_ACCOUNT_PROBE.intervalMs),
    onlyMultiAccount: ap?.onlyMultiAccount !== false,
    timeoutMs: clampNumber(ap?.timeoutMs, 1_000, 60_000, DEFAULT_ACCOUNT_PROBE.timeoutMs),
    historySize: Math.trunc(
      clampNumber(ap?.historySize, 1, 200, DEFAULT_ACCOUNT_PROBE.historySize),
    ),
    staggerMs: clampNumber(ap?.staggerMs, 0, 60_000, DEFAULT_ACCOUNT_PROBE.staggerMs),
  };
}

/**
 * Fill + range-CLAMP the request-audit segment to the frozen defaults
 * (request-audit-log, design D2). Lenient like the other segment normalizers:
 * `enabled`/`captureBodies`/`trustForwardedFor` coerce to booleans (default
 * false), `maxBodyBytes` clamps to `[256, 1_048_576]`, `retentionDays` clamps to
 * `[1, 365]`. Default (all-off) ⇒ no capture ⇒ zero regression.
 */
export function normalizeAudit(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): AuditConfig {
  const a = raw?.audit;
  return {
    enabled: a?.enabled === true,
    captureBodies: a?.captureBodies === true,
    maxBodyBytes: Math.trunc(
      clampNumber(a?.maxBodyBytes, 256, 1_048_576, DEFAULT_AUDIT_CONFIG.maxBodyBytes),
    ),
    retentionDays: Math.trunc(
      clampNumber(a?.retentionDays, 1, 365, DEFAULT_AUDIT_CONFIG.retentionDays),
    ),
    trustForwardedFor: a?.trustForwardedFor === true,
  };
}

/** Valid structured proxy types. */
const PROXY_TYPES: readonly string[] = ['http', 'https', 'socks5'];

/**
 * Validate ONE `ProxyConfig` (upstream-proxy). Returns the cleaned descriptor or
 * `undefined` (drop) when malformed. Lenient like the other segment normalizers:
 *  - `{ url }`        — a non-empty string URL (trimmed).
 *  - structured       — `type` ∈ {http,https,socks5} + non-empty `host` + a
 *                       finite integer `port` in `1..65535`. `username`/`password`
 *                       are non-empty-string-or-omit (may be `enc:`/`$ENV` at load
 *                       — the secret box decrypts afterwards).
 * Never throws.
 */
export function normalizeProxyConfig(raw: unknown): ProxyConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] === 'string' && r['url'].trim().length > 0) {
    return { url: r['url'].trim() };
  }
  const type = r['type'];
  const host = r['host'];
  const port = r['port'];
  if (
    typeof type === 'string' &&
    PROXY_TYPES.includes(type) &&
    typeof host === 'string' &&
    host.trim().length > 0 &&
    typeof port === 'number' &&
    Number.isFinite(port) &&
    port >= 1 &&
    port <= 65535
  ) {
    const out: ProxyConfig = {
      type: type as 'http' | 'https' | 'socks5',
      host: host.trim(),
      port: Math.trunc(port),
    };
    if (typeof r['username'] === 'string' && r['username'].length > 0) out.username = r['username'];
    if (typeof r['password'] === 'string' && r['password'].length > 0) out.password = r['password'];
    return out;
  }
  return undefined;
}

/**
 * Validate the optional `proxy` segment (upstream-proxy). Drops malformed entries
 * (a bad `global` or a bad `byProvider[*]` value/key is dropped, never thrown).
 * Returns `undefined` when nothing valid remains — a missing/empty proxy segment
 * stays ABSENT (zero-config = direct fetch; unlike `accountHealth`, no default is
 * synthesized).
 */
export function normalizeProxySegment(raw: unknown): OutboundProxyConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: OutboundProxyConfig = {};
  const global = normalizeProxyConfig(r['global']);
  if (global) out.global = global;
  if (r['byProvider'] && typeof r['byProvider'] === 'object') {
    const byProvider: Record<string, ProxyConfig> = {};
    for (const [key, value] of Object.entries(r['byProvider'] as Record<string, unknown>)) {
      if (!key.trim()) continue;
      const cfg = normalizeProxyConfig(value);
      if (cfg) byProvider[key] = cfg;
    }
    if (Object.keys(byProvider).length > 0) out.byProvider = byProvider;
  }
  return out.global || out.byProvider ? out : undefined;
}

/**
 * Validate ONE webhook destination (webhook-notifications). Returns the cleaned
 * descriptor or `undefined` (drop) when malformed — lenient like the proxy
 * normalizer, never throws:
 *  - `id`   — a non-empty trimmed string.
 *  - `type` — ∈ {custom, feishu}.
 *  - `url`  — a non-empty trimmed string.
 *  - `secret` — non-empty-string-or-omit (may be `enc:`/`$ENV` at load — the
 *               settings-store secret box decrypts afterwards).
 *  - `events` — kept only when a non-empty array of known kinds (unknown kinds
 *               dropped); an absent/empty filter means "all kinds".
 *  - `enabled` — coerced boolean (default true — a destination in the list is on
 *                unless explicitly disabled).
 */
export function normalizeWebhookDestination(raw: unknown): WebhookDestination | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'string' ? r['id'].trim() : '';
  const url = typeof r['url'] === 'string' ? r['url'].trim() : '';
  const type = r['type'];
  if (!id || !url || typeof type !== 'string' || !WEBHOOK_DESTINATION_TYPES.includes(type as never)) {
    return undefined;
  }
  const out: WebhookDestination = {
    id,
    type: type as WebhookDestination['type'],
    url,
    enabled: r['enabled'] !== false,
  };
  if (typeof r['secret'] === 'string' && r['secret'].length > 0) out.secret = r['secret'];
  if (Array.isArray(r['events'])) {
    const events = r['events'].filter(
      (e): e is WebhookEventKind => typeof e === 'string' && WEBHOOK_EVENT_KINDS.includes(e as never),
    );
    if (events.length > 0) out.events = events;
  }
  return out;
}

/**
 * Validate the optional `webhook` segment (webhook-notifications). Drops
 * malformed destinations; `enabled` defaults false. Returns `undefined` when the
 * segment is absent/non-object — a missing webhook segment stays ABSENT (no sink
 * wired ⇒ zero regression), unlike `accountHealth` no default is synthesized. A
 * present segment with `enabled` present OR any valid destination is kept.
 */
export function normalizeWebhookSegment(raw: unknown): WebhookConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const destinations: WebhookDestination[] = [];
  if (Array.isArray(r['destinations'])) {
    for (const entry of r['destinations']) {
      const d = normalizeWebhookDestination(entry);
      if (d) destinations.push(d);
    }
  }
  const enabled = r['enabled'] === true;
  if (!enabled && destinations.length === 0) return undefined;
  return { enabled, destinations };
}

/** Clamp a numeric to `[min, max]`, falling back to `fallback` when non-finite. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Fill + range-CLAMP the two queue segments to the frozen defaults. Lenient:
 * out-of-range persisted numerics are clamped to the nearest bound, never
 * thrown — strict validation is the daemon admin PUT's job. `enabled` coerces
 * to a boolean (default false).
 */
export function normalizeQueueSegments(raw: Partial<OutboundApiServerConfig> | undefined | null): {
  userMessageQueue: UserMessageQueueConfig;
  concurrencyQueue: ConcurrencyQueueConfig;
} {
  const umq = raw?.userMessageQueue;
  const cq = raw?.concurrencyQueue;
  return {
    userMessageQueue: {
      enabled: umq?.enabled === true,
      delayMs: clampNumber(umq?.delayMs, 0, 10_000, DEFAULT_USER_MESSAGE_QUEUE.delayMs),
      waitTimeoutMs: clampNumber(
        umq?.waitTimeoutMs,
        1000,
        300_000,
        DEFAULT_USER_MESSAGE_QUEUE.waitTimeoutMs,
      ),
    },
    concurrencyQueue: {
      maxQueueSizeFactor: clampNumber(
        cq?.maxQueueSizeFactor,
        1,
        10,
        DEFAULT_CONCURRENCY_QUEUE.maxQueueSizeFactor,
      ),
      minQueueSize: clampNumber(cq?.minQueueSize, 1, 100, DEFAULT_CONCURRENCY_QUEUE.minQueueSize),
      waitTimeoutMs: clampNumber(
        cq?.waitTimeoutMs,
        1000,
        300_000,
        DEFAULT_CONCURRENCY_QUEUE.waitTimeoutMs,
      ),
    },
  };
}

/** Structural subset of the settings store the config loader needs. */
export interface ApiServerSettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

const ALL_ENDPOINTS: OutboundEndpoint[] = ['chat', 'responses', 'messages', 'gemini'];

/** A blank kind→ref map (every declared kind set to `''`) for an endpoint. */
function blankModelMap(endpoint: 'messages' | 'responses'): Record<string, ModelRef> {
  const modelMap: Record<string, ModelRef> = {};
  for (const kind of modelKindsForEndpoint(endpoint)) modelMap[kind] = '';
  return modelMap;
}

/**
 * A blank routing config for one endpoint (subscription OFF by default). The
 * shape depends on the endpoint class: kind-mapped → blank `modelMap`;
 * role-based → blank `defaultModel`/`backgroundModel`.
 */
function defaultEndpointConfig(endpoint: OutboundEndpoint): EndpointRoutingConfig {
  if (isKindMappedEndpoint(endpoint)) {
    return { endpoint, modelMap: blankModelMap(endpoint), useSubscription: false };
  }
  if (endpoint === 'chat') {
    return { endpoint, models: [], useSubscription: false };
  }
  return {
    endpoint,
    defaultModel: '',
    backgroundModel: '',
    useSubscription: false,
  };
}

/**
 * Validate the optional `chat` prefix-target map (openai-chat-bridge #11). Keeps
 * ONLY the three known prefixes (`claude`/`gpt`/`gemini`) whose value is a
 * non-empty trimmed `"providerId,modelId"` string; drops everything else. Returns
 * `undefined` when nothing valid remains (a prefix-mode chat endpoint with no
 * targets simply routes nothing until configured). Never throws.
 */
export function normalizePrefixTargets(raw: unknown): ModelPrefixTargets | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: ModelPrefixTargets = {};
  for (const key of ['claude', 'gpt', 'gemini'] as const) {
    const v = r[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out.claude || out.gpt || out.gemini ? out : undefined;
}

/**
 * Normalize ONE persisted endpoint block to the current heterogeneous shape,
 * dropping legacy/unknown fields with NO migration:
 *  - kind-mapped (`messages`/`responses`): keep ONLY the declared-kind `modelMap`
 *    (unknown kind keys dropped, missing kinds filled `''`, non-string values
 *    coerced to `''`); drop `defaultModel`/`backgroundModel`/`visionModel`/
 *    `backgroundModelIds`.
 *  - list-mapped (`chat`): keep `models` (string entries only, blanks dropped);
 *    drop `defaultModel`/`backgroundModel`/`backgroundModelIds`/`modelMap`.
 *  - role-based (`gemini`): keep `defaultModel`/`backgroundModel` (coerce
 *    non-string → `''`) and `backgroundModelIds` when it is an array; drop
 *    `modelMap`/`visionModel`.
 */
function normalizeEndpointConfig(e: EndpointRoutingConfig): EndpointRoutingConfig {
  const endpoint = e.endpoint;
  const useSubscription = e.useSubscription === true;
  if (isKindMappedEndpoint(endpoint)) {
    const rawMap =
      e.modelMap && typeof e.modelMap === 'object'
        ? (e.modelMap as Record<string, unknown>)
        : {};
    const modelMap: Record<string, ModelRef> = {};
    for (const kind of modelKindsForEndpoint(endpoint)) {
      const v = rawMap[kind];
      modelMap[kind] = typeof v === 'string' ? v : '';
    }
    return { endpoint, modelMap, useSubscription };
  }
  if (endpoint === 'chat') {
    const models = Array.isArray(e.models)
      ? e.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    const config: EndpointRoutingConfig = { endpoint, models, useSubscription };
    // openai-chat-bridge #11: `dispatchMode` defaults to `'list'` — carried ONLY
    // when explicitly `'prefix'` (any other/absent value is list, and a blank
    // list-mode chat config stays byte-identical). `prefixTargets` keeps only the
    // valid string refs for the three known prefixes; carried only in prefix mode.
    if (e.dispatchMode === 'prefix') {
      config.dispatchMode = 'prefix';
      const targets = normalizePrefixTargets(e.prefixTargets);
      if (targets) config.prefixTargets = targets;
    }
    return config;
  }
  const config: EndpointRoutingConfig = {
    endpoint,
    defaultModel: typeof e.defaultModel === 'string' ? e.defaultModel : '',
    backgroundModel: typeof e.backgroundModel === 'string' ? e.backgroundModel : '',
    useSubscription,
  };
  if (Array.isArray(e.backgroundModelIds)) {
    config.backgroundModelIds = e.backgroundModelIds;
  }
  return config;
}

/** The default server config: disabled, loopback, four blank endpoints. */
export function defaultServerConfig(): OutboundApiServerConfig {
  const queues = normalizeQueueSegments(undefined);
  return {
    enabled: false,
    networkBinding: false,
    endpoints: ALL_ENDPOINTS.map(defaultEndpointConfig),
    port: DEFAULT_OUTBOUND_PORT,
    userMessageQueue: queues.userMessageQueue,
    concurrencyQueue: queues.concurrencyQueue,
    accountHealth: normalizeAccountHealth(undefined),
    accountProbe: normalizeAccountProbe(undefined),
    audit: normalizeAudit(undefined),
  };
}

/**
 * Normalize a (possibly partial / legacy) persisted config to the full shape:
 * ensure all four endpoints exist, `useSubscription` defaults OFF, and a port
 * is present.
 */
export function normalizeServerConfig(
  raw: Partial<OutboundApiServerConfig> | undefined | null,
): OutboundApiServerConfig {
  const base = defaultServerConfig();
  if (!raw) return base;
  const byEndpoint = new Map<OutboundEndpoint, EndpointRoutingConfig>();
  for (const e of raw.endpoints ?? []) {
    if (e && ALL_ENDPOINTS.includes(e.endpoint)) {
      byEndpoint.set(e.endpoint, normalizeEndpointConfig(e));
    }
  }
  const queues = normalizeQueueSegments(raw);
  const config: OutboundApiServerConfig = {
    enabled: raw.enabled === true,
    networkBinding: raw.networkBinding === true,
    endpoints: ALL_ENDPOINTS.map(
      (ep) => byEndpoint.get(ep) ?? defaultEndpointConfig(ep),
    ),
    port: raw.port ?? base.port,
    userMessageQueue: queues.userMessageQueue,
    concurrencyQueue: queues.concurrencyQueue,
    accountHealth: normalizeAccountHealth(raw),
    accountProbe: normalizeAccountProbe(raw),
    audit: normalizeAudit(raw),
  };
  // Proxy segment is only carried when valid — absent stays absent (direct fetch).
  const proxy = normalizeProxySegment(raw.proxy);
  if (proxy) config.proxy = proxy;
  // Webhook segment is only carried when valid — absent stays absent (no sink).
  const webhook = normalizeWebhookSegment(raw.webhook);
  if (webhook) config.webhook = webhook;
  return config;
}

/** Load the persisted config (normalized), defaulting on a missing/blank key. */
export async function loadServerConfig(
  store: ApiServerSettingsStore,
): Promise<OutboundApiServerConfig> {
  const raw = await store.get<Partial<OutboundApiServerConfig>>(
    OUTBOUND_API_SERVER_CONFIG_KEY,
  );
  return normalizeServerConfig(raw);
}

/** Persist the config. */
export async function saveServerConfig(
  store: ApiServerSettingsStore,
  config: OutboundApiServerConfig,
): Promise<void> {
  await store.set(OUTBOUND_API_SERVER_CONFIG_KEY, config);
}

/** Apply a partial patch to a config, returning the merged whole. */
export function mergeServerConfig(
  current: OutboundApiServerConfig,
  patch: Partial<OutboundApiServerConfig>,
): OutboundApiServerConfig {
  return normalizeServerConfig({
    enabled: patch.enabled ?? current.enabled,
    networkBinding: patch.networkBinding ?? current.networkBinding,
    endpoints: patch.endpoints ?? current.endpoints,
    port: patch.port ?? current.port,
    userMessageQueue: patch.userMessageQueue ?? current.userMessageQueue,
    concurrencyQueue: patch.concurrencyQueue ?? current.concurrencyQueue,
    accountHealth: patch.accountHealth ?? current.accountHealth,
    accountProbe: patch.accountProbe ?? current.accountProbe,
    audit: patch.audit ?? current.audit,
    // Proxy is layer-replaced (not deep-merged): a PUT carrying `proxy` swaps the
    // whole segment; omitting it keeps the current one. `undefined` on both ⇒ absent.
    proxy: patch.proxy ?? current.proxy,
    // Webhook is layer-replaced too (a PUT carrying `webhook` swaps the whole
    // segment; omitting it keeps the current one). `undefined` on both ⇒ absent.
    webhook: patch.webhook ?? current.webhook,
  });
}
