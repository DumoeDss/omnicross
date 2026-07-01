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
  EndpointRoutingConfig,
  ModelRef,
  OutboundApiServerConfig,
  OutboundEndpoint,
} from './types';

/** The settings key the config persists under. */
export const OUTBOUND_API_SERVER_CONFIG_KEY = 'outboundApiServer.config';

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
 *  - role-based (`chat`/`gemini`): keep `defaultModel`/`backgroundModel` (coerce
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
  return {
    enabled: false,
    networkBinding: false,
    endpoints: ALL_ENDPOINTS.map(defaultEndpointConfig),
    port: DEFAULT_OUTBOUND_PORT,
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
  return {
    enabled: raw.enabled === true,
    networkBinding: raw.networkBinding === true,
    endpoints: ALL_ENDPOINTS.map(
      (ep) => byEndpoint.get(ep) ?? defaultEndpointConfig(ep),
    ),
    port: raw.port ?? base.port,
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
  });
}
