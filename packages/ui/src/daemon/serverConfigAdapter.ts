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
  AccountAllowanceSchedulingStatus,
  AllowanceSchedulingConfig,
  AgentApiServiceApi,
  CreateKeyResult,
  GenerateVoucherResult,
  MutationResult,
  VoucherGenerateInput,
  WebhookTestResult,
} from './types';
import type {
  AuditRecord,
  AccountRouteActivityResponse,
  BillingDeliveryStatus,
  EndpointRoutingConfig,
  GatewayBinding,
  ImagesCapabilityStatus,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundKeyPolicyPatch,
  OutboundPermissionId,
  OverloadCounterResponse,
  SearchDiagnosticsSnapshot,
  SearchServerConfig,
  SearchTestResult,
  VoucherCreated,
  VoucherInfo,
} from './types-server';

/** The `PUT /server` response: the persisted config, echoed back. */
interface ServerPutResponse {
  server: OutboundApiServerConfig;
}

/** The admin-read presence markers; view-only and never persisted as config. */
const SEARCH_MARKER_KEYS = ['apiKeyConfigured', 'basicAuthPasswordConfigured'] as const;

/** Deep-copy a provider entry without the admin-read marker fields. */
function stripSearchEntryMarkers<T extends Record<string, unknown>>(entry: T): T {
  const out = { ...entry };
  for (const marker of SEARCH_MARKER_KEYS) delete out[marker];
  return out;
}

/**
 * Build the FULL `search` segment for a PUT (search-settings-ui).
 *
 * `mergeServerConfig` layer-replaces the section (`patch.search ??
 * current.search`), so a segment missing a top-level member would WIPE it: a
 * missing member is backfilled from the last-loaded masked config (trap #1,
 * same discipline as `endpoints`). `providers` is the caller's COMPLETE
 * intended set — the model builds it from the full masked read, so an entry
 * ABSENT from it is a deliberate removal (removal is how a configuration
 * including its secret is deleted; re-merging cached entries here would
 * resurrect it). Markers are stripped on the way out; secret fields ride only
 * when the caller set them (write-only — a masked read contributes none).
 */
function fullSearchSegment(
  cached: SearchServerConfig | undefined,
  incoming: SearchServerConfig,
): SearchServerConfig {
  const providers: SearchServerConfig['providers'] = {};
  for (const [id, entry] of Object.entries(incoming.providers ?? {})) {
    if (entry === null || entry === undefined) continue;
    providers[id as keyof SearchServerConfig['providers']] =
      stripSearchEntryMarkers(entry as unknown as Record<string, unknown>) as never;
  }
  return {
    modes: incoming.modes ?? cached?.modes ?? { codex: 'off', responses: 'native', anthropic: 'native' },
    providers,
    egress: incoming.egress ?? cached?.egress ?? { allowedPrivateHosts: [] },
    policy: incoming.policy ?? cached?.policy ?? { fallbackEnabled: true },
  };
}

function fail(err: unknown, fallback: string): MutationResult {
  return { success: false, message: err instanceof Error ? err.message : fallback };
}

export function createApiServiceAdapter(): AgentApiServiceApi {
  // The last-loaded server config — the source of truth for the full-array
  // rebuild (trap #1). Edits never drive off `/status` (trap #2).
  let cachedConfig: OutboundApiServerConfig | null = null;

  /** Refresh the cache from the config the daemon echoes back. */
  function applyServerPut(data: ServerPutResponse): MutationResult {
    cachedConfig = data.server;
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

    async deleteKey(id: string): Promise<MutationResult> {
      try {
        const data = await adminClient.delete<{ ok: boolean }>(
          `/keys/${encodeURIComponent(id)}`,
        );
        if (!data.ok) return { success: false, message: 'key not found' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to delete key');
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

    async revealKey(id: string): Promise<{ success: boolean; key?: string; message?: string }> {
      try {
        const data = await adminClient.get<{ key: string }>(
          `/keys/${encodeURIComponent(id)}/reveal`,
        );
        return { success: true, key: data.key ?? '' };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to reveal key' };
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

    async getImagesCapability(): Promise<ImagesCapabilityStatus | null> {
      try {
        return await adminClient.get<ImagesCapabilityStatus>('/images/capabilities');
      } catch {
        return null;
      }
    },

    async setKeyPermissions(id: string, permissions: OutboundPermissionId[]): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean; allowedEndpoints?: OutboundPermissionId[] }>(
          `/keys/${encodeURIComponent(id)}/permissions`,
          { permissions },
        );
        if (!data.ok) return { success: false, message: 'key not found or revoked' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to update key permissions');
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

    async updateImagesConfig(config): Promise<MutationResult> {
      try {
        const { storageRootConfigured: _storageRootConfigured, ...references } = config.references;
        const data = await adminClient.put<ServerPutResponse>('/server', {
          images: { ...config, references },
        });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update Images configuration');
      }
    },

    async updateBindings(bindings: GatewayBinding[]): Promise<MutationResult> {
      try {
        const data = await adminClient.put<ServerPutResponse>('/server', { bindings });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update gateway bindings');
      }
    },

    async updateSearchConfig(search: SearchServerConfig): Promise<MutationResult> {
      try {
        // search-settings-ui: LAYER-REPLACED segment — rebuild the FULL tree
        // from the last-loaded masked config so untouched providers survive,
        // strip the view-only markers, and let the daemon's write-only
        // preservation re-attach stored secrets for omitted/blanked fields.
        const data = await adminClient.put<ServerPutResponse>('/server', {
          search: fullSearchSegment(cachedConfig?.search, search),
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update search configuration');
      }
    },

    async getSearchDiagnostics(): Promise<SearchDiagnosticsSnapshot | null> {
      try {
        const data = await adminClient.get<{ diagnostics: SearchDiagnosticsSnapshot }>(
          '/search/diagnostics',
        );
        return data.diagnostics ?? null;
      } catch {
        // Compatibility seam: older daemons do not expose diagnostics. The
        // settings surface stays fully editable and labels the status area
        // unsupported instead of treating this as a page failure.
        //
        // Review round 1 (t1) disposition — deliberately KEPT catch-all, the
        // `getAllowanceSchedulingStatus` precedent: diagnostics are advisory
        // reads, so a transient 500 or auth failure reading as "unsupported"
        // costs only the status row (the editors and the test action remain
        // fully functional), while distinguishing it would need a third UI
        // state this page has no idiom for. Do not narrow without adding that
        // state.
        return null;
      }
    },

    async testSearchProvider(providerId: string): Promise<import('./types').SearchTestOutcome> {
      try {
        const data = await adminClient.post<{
          result: { diagnostic: SearchTestResult; resultCount?: number };
        }>('/search/test', { providerId });
        return {
          ok: true,
          result: {
            ...data.result.diagnostic,
            ...(data.result.resultCount !== undefined
              ? { resultCount: data.result.resultCount }
              : {}),
          },
        };
      } catch (err) {
        // Result-shaped failure, never a throw: an unconfigured/unknown
        // provider refusal renders inline like a blocked network outcome.
        return { ok: false, error: err instanceof Error ? err.message : 'search test failed' };
      }
    },

    async updateAllowanceSchedulingConfig(
      allowanceScheduling: AllowanceSchedulingConfig,
    ): Promise<MutationResult> {
      try {
        const data = await adminClient.put<ServerPutResponse>('/server', { allowanceScheduling });
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update allowance scheduling');
      }
    },

    async getAllowanceSchedulingStatus(): Promise<AccountAllowanceSchedulingStatus | null> {
      try {
        const data = await adminClient.get<{ scheduling: AccountAllowanceSchedulingStatus }>(
          '/accounts/allowances/scheduling',
        );
        return data.scheduling ?? null;
      } catch {
        // Compatibility seam: older daemons do not expose diagnostics. The
        // settings surface keeps the persisted policy editable and labels the
        // history as unavailable instead of treating this as a page failure.
        return null;
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
            maxBodyBytes: -1,
            retentionDays: 7,
            trustForwardedFor: false,
          },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update audit configuration');
      }
    },

    async compactAudit(): Promise<{ days: number; shards: number; savedBytes: number }> {
      try {
        const data = await adminClient.post<{ days?: number; shards?: number; savedBytes?: number }>(
          '/audit/compact',
        );
        return {
          days: data.days ?? 0,
          shards: data.shards ?? 0,
          savedBytes: data.savedBytes ?? 0,
        };
      } catch {
        return { days: 0, shards: 0, savedBytes: 0 };
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

    async queryAccountRouteActivity(query = {}): Promise<AccountRouteActivityResponse> {
      const params = new URLSearchParams();
      if (query.providerId) params.set('providerId', query.providerId);
      if (query.accountId) params.set('accountId', query.accountId);
      if (query.sessionKey) params.set('sessionKey', query.sessionKey);
      if (typeof query.limit === 'number') params.set('limit', String(query.limit));
      const qs = params.toString();
      try {
        const snapshot = await adminClient.get<Omit<AccountRouteActivityResponse, 'available'> & {
          available?: boolean;
        }>(
          qs ? `/accounts/route-activity?${qs}` : '/accounts/route-activity',
        );
        return { ...snapshot, available: snapshot.available ?? true };
      } catch {
        return { available: false, records: [], capacity: 300, collectedAt: Date.now() };
      }
    },

    async queryOverloadCounters(query = {}): Promise<OverloadCounterResponse> {
      const params = new URLSearchParams();
      if (query.providerId) params.set('providerId', query.providerId);
      if (query.accountId) params.set('accountId', query.accountId);
      const qs = params.toString();
      try {
        const snapshot = await adminClient.get<Omit<OverloadCounterResponse, 'available'> & {
          available?: boolean;
        }>(
          qs ? `/accounts/overload-counters?${qs}` : '/accounts/overload-counters',
        );
        return { ...snapshot, available: snapshot.available ?? true };
      } catch {
        // Older daemons lack the endpoint; surface unavailable rather than erroring.
        return { available: false, entries: [], collectedAt: Date.now() };
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

    async updateVoucherConfig(
      voucher: OutboundApiServerConfig['voucher'] | undefined,
    ): Promise<MutationResult> {
      try {
        // voucher-redemption #9: send the FULL segment; the daemon normalizes it.
        // `undefined` resets to defaults (disabled). Carries no secret.
        const data = await adminClient.put<ServerPutResponse>('/server', {
          voucher: voucher ?? { enabled: false },
        } as Partial<OutboundApiServerConfig>);
        return applyServerPut(data);
      } catch (err) {
        return fail(err, 'failed to update voucher configuration');
      }
    },

    async listVouchers(): Promise<VoucherInfo[]> {
      try {
        const data = await adminClient.get<{ vouchers: VoucherInfo[] }>('/voucher');
        return data.vouchers ?? [];
      } catch {
        return [];
      }
    },

    async generateVoucher(input: VoucherGenerateInput): Promise<GenerateVoucherResult> {
      try {
        const created = await adminClient.post<VoucherCreated>('/voucher', input);
        return { success: true, created };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to generate voucher' };
      }
    },

    async revokeVoucher(id: string): Promise<MutationResult> {
      try {
        const data = await adminClient.post<{ ok: boolean }>(
          `/voucher/${encodeURIComponent(id)}/revoke`,
        );
        if (!data.ok) return { success: false, message: 'voucher not revocable' };
        return { success: true };
      } catch (err) {
        return fail(err, 'failed to revoke voucher');
      }
    },
  };
}
