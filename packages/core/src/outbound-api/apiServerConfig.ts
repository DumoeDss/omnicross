/**
 * apiServerConfig — load / save / default the outbound API server config
 * (`outbound-api-server`, design D4).
 *
 * The config (`{ enabled, networkBinding, endpoints, port }`) is persisted via
 * a small key/value store (the app SettingsService) under a single key, so it
 * survives restart. Defaults: disabled, loopback, four endpoints with empty
 * models + `useSubscription` OFF, default port. Shared by the router and the
 * bootstrap wiring so both read/write the same shape.
 *
 * @module outbound-api/apiServerConfig
 */

import { DEFAULT_OUTBOUND_PORT } from './OutboundApiServer';
import type {
  EndpointRoutingConfig,
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

/** A blank routing config for one endpoint (subscription OFF by default). */
function defaultEndpointConfig(endpoint: OutboundEndpoint): EndpointRoutingConfig {
  return {
    endpoint,
    defaultModel: '',
    backgroundModel: '',
    useSubscription: false,
  };
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
      byEndpoint.set(e.endpoint, {
        endpoint: e.endpoint,
        defaultModel: e.defaultModel ?? '',
        backgroundModel: e.backgroundModel ?? '',
        visionModel: e.visionModel,
        useSubscription: e.useSubscription === true,
        backgroundModelIds: e.backgroundModelIds,
      });
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
