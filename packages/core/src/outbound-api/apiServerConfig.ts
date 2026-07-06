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

import { isKindMappedEndpoint, modelKindsForEndpoint } from './kindDetection';
import { DEFAULT_OUTBOUND_PORT } from './OutboundApiServer';
import type {
  ConcurrencyQueueConfig,
  EndpointRoutingConfig,
  ModelRef,
  OutboundApiServerConfig,
  OutboundEndpoint,
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
    return { endpoint, models, useSubscription };
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
  return {
    enabled: raw.enabled === true,
    networkBinding: raw.networkBinding === true,
    endpoints: ALL_ENDPOINTS.map(
      (ep) => byEndpoint.get(ep) ?? defaultEndpointConfig(ep),
    ),
    port: raw.port ?? base.port,
    userMessageQueue: queues.userMessageQueue,
    concurrencyQueue: queues.concurrencyQueue,
  };
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
  });
}
