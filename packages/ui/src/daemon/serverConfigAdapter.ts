/**
 * serverConfigAdapter.ts — the daemon ⇄ API Service page adapter (design D2).
 *
 * Wires the page to `GET/PUT /admin/api/server` + `GET /admin/api/status` + the
 * named-key resource (`GET/POST /admin/api/keys` + revoke/enabled). Mirrors
 * `llmConfigAdapter`'s allowlist + `{ success:false }`-never-fake-success pattern.
 *
 * TWO LOAD-BEARING TRAPS (design "Riskiest honesty traps"):
 *   1. `PUT /server` does NOT deep-merge endpoints — `mergeServerConfig` does
 *      `patch.endpoints ?? current.endpoints` (wholesale replace). So
 *      `updateEndpoint(one)` rebuilds the FULL endpoints array from the cached
 *      last-loaded config (replacing just the edited entry) before the PUT, or
 *      the other endpoints' models are silently wiped.
 *   2. Edits drive off `GET /server`'s `EndpointRoutingConfig` (`defaultModel`),
 *      NEVER off `GET /status`'s read-only `endpoints[].model` projection.
 *
 * `setEnabled`/`setNetworkBinding`/`updateEndpoint` follow the PUT with a fresh
 * `GET /status` (the PUT returns only `{ server }`) so the live banner refreshes;
 * that re-fetch is the caller's job via `getStatus()` — the mutations return
 * `{ success }` and the hook re-reads status + config after a successful write.
 */

import { adminClient } from './adminClient';
import type {
  AgentApiServiceApi,
  CreateKeyResult,
  MutationResult,
} from './types';
import type {
  EndpointRoutingConfig,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundModelConfigError,
} from './types-server';

/**
 * The `PUT /server` response. On an incomplete-config enable the daemon returns
 * HTTP 200 with an `error` envelope (`incomplete-model-config`) alongside the
 * persisted partial config — NOT a non-2xx — so the adapter can read `missing`
 * (a 4xx would collapse to just `error.message` through `adminClient`).
 */
interface ServerPutResponse {
  server: OutboundApiServerConfig;
  error?: { code: string; missing?: OutboundModelConfigError[] };
}

function fail(err: unknown, fallback: string): MutationResult {
  return { success: false, message: err instanceof Error ? err.message : fallback };
}

/**
 * Build the daemon `PUT /server` body for one endpoint edit by rebuilding the
 * FULL endpoints array from `current` (trap #1). Only the entry matching
 * `next.endpoint` is replaced; the rest pass through unchanged.
 */
function rebuildEndpoints(
  current: OutboundApiServerConfig,
  next: EndpointRoutingConfig,
): EndpointRoutingConfig[] {
  let replaced = false;
  const merged = current.endpoints.map((e) => {
    if (e.endpoint === next.endpoint) {
      replaced = true;
      return next;
    }
    return e;
  });
  // If the endpoint was somehow absent from the cached config, append it rather
  // than silently dropping the edit.
  if (!replaced) merged.push(next);
  return merged;
}

export function createApiServiceAdapter(): AgentApiServiceApi {
  // The last-loaded server config — the source of truth for the full-array
  // rebuild (trap #1). Edits never drive off `/status` (trap #2).
  let cachedConfig: OutboundApiServerConfig | null = null;

  /**
   * Interpret a `PUT /server` response: always refresh the cache from the
   * returned (possibly partial) config, then map the `incomplete-model-config`
   * envelope to a `{ success:false, missing }` result the page surfaces as the
   * "service can't start" prompt. Any other shape is a plain success.
   */
  function applyServerPut(data: ServerPutResponse): MutationResult {
    cachedConfig = data.server;
    if (data.error?.code === 'incomplete-model-config') {
      return { success: false, message: data.error.code, missing: data.error.missing ?? [] };
    }
    return { success: true };
  }

  return {
    async getConfig(): Promise<OutboundApiServerConfig | null> {
      try {
        const data = await adminClient.get<{ server: OutboundApiServerConfig }>('/server');
        cachedConfig = data.server;
        return data.server;
      } catch {
        return null;
      }
    },

    async getStatus(): Promise<OutboundApiServerStatus | null> {
      try {
        return await adminClient.get<OutboundApiServerStatus>('/status');
      } catch {
        return null;
      }
    },

    async setEnabled(enabled: boolean): Promise<MutationResult> {
      try {
        const data = await adminClient.put<ServerPutResponse>('/server', { enabled });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update server state');
      }
    },

    async setNetworkBinding(networkBinding: boolean): Promise<MutationResult> {
      try {
        const data = await adminClient.put<ServerPutResponse>('/server', { networkBinding });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update network binding');
      }
    },

    async updateEndpoint(endpoint: EndpointRoutingConfig): Promise<MutationResult> {
      try {
        // Always rebuild off a FRESH config so a concurrent edit elsewhere is not
        // clobbered; fall back to the cache only when the re-read fails.
        let base = cachedConfig;
        try {
          const data = await adminClient.get<{ server: OutboundApiServerConfig }>('/server');
          base = data.server;
          cachedConfig = data.server;
        } catch {
          // keep `base = cachedConfig`
        }
        if (!base) return { success: false, message: 'server config not loaded' };
        const endpoints = rebuildEndpoints(base, endpoint);
        const data = await adminClient.put<ServerPutResponse>('/server', { endpoints });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update endpoint routing');
      }
    },

    async listKeys(): Promise<OutboundApiKeyInfo[]> {
      try {
        const data = await adminClient.get<{ keys: OutboundApiKeyInfo[] }>('/keys');
        return data.keys ?? [];
      } catch {
        return [];
      }
    },

    async createKey(name: string): Promise<CreateKeyResult> {
      try {
        const created = await adminClient.post<OutboundApiKeyCreated>('/keys', { name });
        return { success: true, created };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to create key' };
      }
    },

    async revokeKey(id: string): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean }>(`/keys/${encodeURIComponent(id)}/revoke`);
        if (!data.ok) return { success: false, message: 'key not found' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to revoke key');
      }
    },

    async setKeyEnabled(id: string, enabled: boolean): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean; enabled: boolean }>(
          `/keys/${encodeURIComponent(id)}/enabled`,
          { enabled },
        );
        if (!data.ok) return { success: false, message: 'key not found' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to update key state');
      }
    },
  };
}
