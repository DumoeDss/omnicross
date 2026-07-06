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
  WebhookTestResult,
} from './types';
import type {
  AuditRecord,
  BillingDeliveryStatus,
  EndpointRoutingConfig,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundKeyPolicyPatch,
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

    async setKeyMaxConcurrency(id: string, maxConcurrency: number | null): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean; maxConcurrency?: number | null }>(
          `/keys/${encodeURIComponent(id)}/max-concurrency`,
          { maxConcurrency },
        );
        if (!data.ok) return { success: false, message: 'key not found' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to update key concurrency limit');
      }
    },

    async setKeyPolicy(id: string, policy: OutboundKeyPolicyPatch): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean }>(
          `/keys/${encodeURIComponent(id)}/policy`,
          policy,
        );
        if (!data.ok) return { success: false, message: 'key not found' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to update key policy');
      }
    },

    async updateQueueConfig(patch: {
      userMessageQueue?: OutboundApiServerConfig['userMessageQueue'];
      concurrencyQueue?: OutboundApiServerConfig['concurrencyQueue'];
    }): Promise<MutationResult> {
      try {
        // The server PUT accepts a partial patch and merges it, so the queue
        // segment(s) ride the existing merge path (unlike `endpoints`, these are
        // whole-object scalars — no full-array rebuild needed).
        const data = await adminClient.put<ServerPutResponse>('/server', patch);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update queue configuration');
      }
    },

    async updateProxyConfig(
      proxy: OutboundApiServerConfig['proxy'] | undefined,
    ): Promise<MutationResult> {
      try {
        // upstream-proxy: the caller (ProxySection) sends the FULL segment rebuilt
        // from the last-loaded (masked) config; the daemon preserves each untouched
        // layer's write-only password. `mergeServerConfig` replaces `proxy` wholesale
        // via `patch.proxy ?? current.proxy` — so an EMPTY object `{}` (not null/
        // undefined, which are nullish and would keep the current) is sent to CLEAR:
        // the daemon normalizes an empty proxy segment to absent (direct fetch).
        const data = await adminClient.put<ServerPutResponse>('/server', {
          proxy: proxy ?? {},
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update proxy configuration');
      }
    },

    async updateWebhookConfig(
      webhook: OutboundApiServerConfig['webhook'] | undefined,
    ): Promise<MutationResult> {
      try {
        // webhook-notifications: send the FULL segment rebuilt from the last-loaded
        // (masked) config; the daemon preserves each destination's write-only secret
        // when the patch masks/omits it. An empty `{ enabled:false, destinations:[] }`
        // (not undefined, which is nullish and keeps current) CLEARS it — the daemon
        // normalizes an empty webhook segment to absent (inert).
        const data = await adminClient.put<ServerPutResponse>('/server', {
          webhook: webhook ?? { enabled: false, destinations: [] },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update webhook configuration');
      }
    },

    async testWebhook(destinationId: string): Promise<WebhookTestResult> {
      try {
        const data = await adminClient.post<{ result: WebhookTestResult }>('/webhook-test', {
          destinationId,
        });
        return data.result;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'test failed' };
      }
    },

    async updateAuditConfig(
      audit: OutboundApiServerConfig['audit'] | undefined,
    ): Promise<MutationResult> {
      try {
        // request-audit-log: send the FULL segment; the daemon validates + normalizes
        // it. `undefined` resets to defaults (disabled). No secret round-trips.
        const data = await adminClient.put<ServerPutResponse>('/server', {
          audit: audit ?? {
            enabled: false,
            captureBodies: false,
            maxBodyBytes: 8192,
            retentionDays: 7,
            trustForwardedFor: false,
          },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update audit configuration');
      }
    },

    async queryAudit(query: {
      keyId?: string;
      from?: number;
      to?: number;
      limit?: number;
    }): Promise<AuditRecord[]> {
      try {
        const params = new URLSearchParams();
        if (query.keyId) params.set('keyId', query.keyId);
        if (typeof query.from === 'number') params.set('from', String(query.from));
        if (typeof query.to === 'number') params.set('to', String(query.to));
        if (typeof query.limit === 'number') params.set('limit', String(query.limit));
        const qs = params.toString();
        const data = await adminClient.get<{ records: AuditRecord[] }>(
          qs ? `/audit?${qs}` : '/audit',
        );
        return data.records ?? [];
      } catch {
        return [];
      }
    },

    async updateBillingConfig(
      billing: OutboundApiServerConfig['billing'] | undefined,
    ): Promise<MutationResult> {
      try {
        // billing-event-stream: send the FULL segment; the daemon validates +
        // normalizes it and PRESERVES the write-only HMAC secret when the patch
        // masks/omits it. `undefined` resets to defaults (disabled).
        const data = await adminClient.put<ServerPutResponse>('/server', {
          billing: billing ?? { enabled: false, maxRetryAgeMs: 24 * 60 * 60_000 },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update billing configuration');
      }
    },

    async queryBillingStatus(): Promise<BillingDeliveryStatus> {
      try {
        const data = await adminClient.get<{ status: BillingDeliveryStatus }>('/billing-status');
        return data.status ?? { total: 0, delivered: 0, pending: 0 };
      } catch {
        return { total: 0, delivered: 0, pending: 0 };
      }
    },

    async updateFingerprintConfig(
      fingerprint: OutboundApiServerConfig['fingerprint'] | undefined,
    ): Promise<MutationResult> {
      try {
        // subscription-client-fingerprint #7: send the FULL segment; the daemon
        // validates + normalizes it. `undefined` resets to defaults (disabled).
        // Carries no secret. A change takes effect on daemon restart.
        const data = await adminClient.put<ServerPutResponse>('/server', {
          fingerprint: fingerprint ?? { enabled: false },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update fingerprint configuration');
      }
    },
  };
}
