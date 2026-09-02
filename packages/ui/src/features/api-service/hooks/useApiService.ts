/**
 * useApiService.ts — the API Service page aggregator hook.
 *
 * Parallel-loads `GET /server` (editable config) + `GET /status` (live banner)
 * + `GET /keys` on mount, exposes the mutations wired to `agent.apiService`, and
 * holds the one-time `plaintextOnce` create-key reveal state.
 *
 * Edits drive off the `config` (the downstream routes), never off the read-only
 * `status.endpoints[]` projection. After any successful write the hook re-reads
 * BOTH config + status so the editable surface and the live banner stay
 * consistent (the PUT returns only `{ server }`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';

import { agent } from '@/shared/agent';

import type {
  AccountAllowanceSchedulingStatus,
  AccountsListResponse,
  AuditRecord,
  BillingDeliveryStatus,
  EndpointRoutingConfig,
  GatewayBinding,
  ImagesCapabilityStatus,
  MutationResult,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundKeyPolicyPatch,
  OutboundPermissionId,
  OutboundQueueStatus,
  SearchDiagnosticsSnapshot,
  SearchServerConfig,
  SearchTestOutcome,
  VoucherCreated,
  VoucherGenerateInput,
  VoucherInfo,
  WebhookTestResult,
} from '@/daemon/types';
import type { LLMProvider } from '@shared/llm-config';

/** A `{ value:"providerId,modelId", label }` option for the model pickers. */
export interface ModelRefOption {
  value: string;
  label: string;
}

export interface UseApiServiceResult {
  loading: boolean;
  config: OutboundApiServerConfig | null;
  status: OutboundApiServerStatus | null;
  imageCapability: ImagesCapabilityStatus | null;
  keys: OutboundApiKeyInfo[];
  modelOptions: ModelRefOption[];
  /** Subscription accounts (per-provider) for the subscription-mode account picker. */
  accounts: AccountsListResponse;
  busy: boolean;
  error: string | null;
  /** The one-time create-key reveal; cleared via `dismissCreatedKey`. */
  createdKey: OutboundApiKeyCreated | null;
  /** Live queue activity (`status.queueStatus`), or undefined when idle/absent. */
  queueStatus: OutboundQueueStatus | undefined;
  dismissCreatedKey: () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
  setNetworkBinding: (networkBinding: boolean) => Promise<void>;
  updateBindings: (bindings: GatewayBinding[]) => Promise<void>;
  createKey: (name: string) => Promise<boolean>;
  /** Reveal a key's stored plaintext (view-key affordance); no state mutation. */
  revealKey: (id: string) => Promise<{ success: boolean; key?: string; message?: string }>;
  revokeKey: (id: string) => Promise<void>;
  /** Permanently remove a key row (hard delete); refreshes the key list. */
  deleteKey: (id: string) => Promise<void>;
  setKeyEnabled: (id: string, enabled: boolean) => Promise<void>;
  setKeyMaxConcurrency: (id: string, maxConcurrency: number | null) => Promise<void>;
  setKeyPermissions: (id: string, permissions: OutboundPermissionId[]) => Promise<void>;
  setKeyPolicy: (id: string, policy: OutboundKeyPolicyPatch) => Promise<void>;
  updateQueueConfig: (patch: {
    userMessageQueue?: OutboundApiServerConfig['userMessageQueue'];
    concurrencyQueue?: OutboundApiServerConfig['concurrencyQueue'];
  }) => Promise<void>;
  updateImagesConfig: (
    config: NonNullable<OutboundApiServerConfig['images']>,
  ) => Promise<void>;
  /** Secret-free search diagnostics; null on a daemon that predates the endpoint. */
  searchDiagnostics: SearchDiagnosticsSnapshot | null;
  /** Persist the full search segment (layer-replaced; secrets write-only). */
  updateSearchConfig: (search: NonNullable<OutboundApiServerConfig['search']>) => Promise<void>;
  /** Run the daemon's fixed-query live test for one provider (non-mutating). */
  testSearchProvider: (providerId: string) => Promise<SearchTestOutcome>;
  updateAllowanceSchedulingConfig: (
    config: NonNullable<OutboundApiServerConfig['allowanceScheduling']>,
  ) => Promise<void>;
  getAllowanceSchedulingStatus: () => Promise<AccountAllowanceSchedulingStatus | null>;
  updateProxyConfig: (proxy: OutboundApiServerConfig['proxy'] | undefined) => Promise<void>;
  updateWebhookConfig: (webhook: OutboundApiServerConfig['webhook'] | undefined) => Promise<void>;
  testWebhook: (destinationId: string) => Promise<WebhookTestResult>;
  updateAuditConfig: (audit: OutboundApiServerConfig['audit'] | undefined) => Promise<void>;
  queryAudit: (query: {
    keyId?: string;
    from?: number;
    to?: number;
    limit?: number;
  }) => Promise<AuditRecord[]>;
  compactAudit: () => Promise<{ days: number; shards: number; savedBytes: number }>;
  updateBillingConfig: (billing: OutboundApiServerConfig['billing'] | undefined) => Promise<void>;
  queryBillingStatus: () => Promise<BillingDeliveryStatus>;
  updateFingerprintConfig: (
    fingerprint: OutboundApiServerConfig['fingerprint'] | undefined,
  ) => Promise<void>;
  /** Redemption cards (voucher-redemption #9). */
  vouchers: VoucherInfo[];
  /** The one-time generated-code reveal; cleared via `dismissCreatedVoucher`. */
  createdVoucher: VoucherCreated | null;
  dismissCreatedVoucher: () => void;
  updateVoucherConfig: (
    voucher: OutboundApiServerConfig['voucher'] | undefined,
  ) => Promise<void>;
  generateVoucher: (input: VoucherGenerateInput) => Promise<boolean>;
  revokeVoucher: (id: string) => Promise<void>;
}

/** Build `"providerId,modelId"` options from the daemon provider list. */
function toModelOptions(providers: LLMProvider[]): ModelRefOption[] {
  const opts: ModelRefOption[] = [];
  for (const p of providers) {
    for (const modelId of p.models ?? []) {
      opts.push({ value: `${p.id},${modelId}`, label: `${p.id} / ${modelId}` });
    }
  }
  return opts;
}

export function useApiService(): UseApiServiceResult {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<OutboundApiServerConfig | null>(null);
  const [status, setStatus] = useState<OutboundApiServerStatus | null>(null);
  const [imageCapability, setImageCapability] = useState<ImagesCapabilityStatus | null>(null);
  const [searchDiagnostics, setSearchDiagnostics] = useState<SearchDiagnosticsSnapshot | null>(null);
  const [keys, setKeys] = useState<OutboundApiKeyInfo[]>([]);
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [accounts, setAccounts] = useState<AccountsListResponse>({
    accounts: [],
    providerAccounts: { claude: [], codex: [], gemini: [], opencodego: [] },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<OutboundApiKeyCreated | null>(null);
  const [vouchers, setVouchers] = useState<VoucherInfo[]>([]);
  const [createdVoucher, setCreatedVoucher] = useState<VoucherCreated | null>(null);

  // Latest `busy` for the poll timer to read without re-arming the interval.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refreshAll = useCallback(async () => {
    const [cfg, st, imageStatus, ks, vs, searchDiag] = await Promise.all([
      agent.apiService.getConfig(),
      agent.apiService.getStatus(),
      agent.apiService.getImagesCapability(),
      agent.apiService.listKeys(),
      agent.apiService.listVouchers(),
      agent.apiService.getSearchDiagnostics(),
    ]);
    setConfig(cfg);
    setStatus(st);
    setImageCapability(imageStatus);
    setKeys(ks);
    setVouchers(vs);
    setSearchDiagnostics(searchDiag);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // The Tauri webview can mount a fraction before its bundled daemon has
      // bound the admin port. Retry only that cold-start window; browser mode
      // keeps the existing fail-fast behavior when no daemon is running.
      const attempts = isTauri() ? 20 : 1;
      let cfg: OutboundApiServerConfig | null = null;
      let st: OutboundApiServerStatus | null = null;
      let imageStatus: ImagesCapabilityStatus | null = null;
      let ks: OutboundApiKeyInfo[] = [];
      let vs: VoucherInfo[] = [];
      let provs: LLMProvider[] = [];
      let searchDiag: SearchDiagnosticsSnapshot | null = null;
      let accts: AccountsListResponse = {
        accounts: [],
        providerAccounts: { claude: [], codex: [], gemini: [], opencodego: [] },
      };
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        [cfg, st, imageStatus, ks, vs, provs, searchDiag, accts] = await Promise.all([
          agent.apiService.getConfig(),
          agent.apiService.getStatus(),
          agent.apiService.getImagesCapability(),
          agent.apiService.listKeys(),
          agent.apiService.listVouchers(),
          agent.llmConfig.getProviders().catch(() => [] as LLMProvider[]),
          agent.apiService.getSearchDiagnostics(),
          agent.accounts.list().catch(() => accts),
        ]);
        if (cancelled || (cfg && st)) break;
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
      if (cancelled) return;
      setConfig(cfg);
      setStatus(st);
      setImageCapability(imageStatus);
      setKeys(ks);
      setVouchers(vs);
      setProviders(provs);
      setSearchDiagnostics(searchDiag);
      setAccounts(accts);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lightweight status-only poll (10s) so the queue-status readout reflects live
  // activity without a manual refresh. Only `status` is re-read (not config/keys),
  // and a poll is skipped while a write is in flight so it never clobbers an
  // in-progress mutation's own refresh. Runs only while the page is mounted.
  useEffect(() => {
    const POLL_MS = 10_000;
    const id = window.setInterval(() => {
      if (busyRef.current) return;
      void Promise.all([
        agent.apiService.getStatus(),
        agent.apiService.getImagesCapability(),
      ]).then(([st, imageStatus]) => {
        // Guard against a write landing between the fetch and the resolve.
        if (!busyRef.current && st) {
          setStatus(st);
          setImageCapability(imageStatus);
        }
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Run a mutation, surface its failure honestly, then re-read config + status.
  const runWrite = useCallback(
    async (op: () => Promise<MutationResult>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await op();
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return false;
        }
        await refreshAll();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [refreshAll],
  );

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      await runWrite(() => agent.apiService.setEnabled(enabled));
    },
    [runWrite],
  );

  const setNetworkBinding = useCallback(
    async (networkBinding: boolean) => {
      await runWrite(() => agent.apiService.setNetworkBinding(networkBinding));
    },
    [runWrite],
  );


  const createKey = useCallback(async (name: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.createKey(name);
      if (!result.success) {
        setError(result.message);
        return false;
      }
      setCreatedKey(result.created);
      setKeys(await agent.apiService.listKeys());
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  // The reveal is a pure read (no config mutation) — like queryAudit, it does NOT
  // go through runWrite nor flip busy; the caller renders the returned key inline.
  const revealKey = useCallback(
    (id: string) => agent.apiService.revealKey(id),
    [],
  );

  const revokeKey = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.revokeKey(id);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteKey = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.deleteKey(id);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const setKeyEnabled = useCallback(async (id: string, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.setKeyEnabled(id, enabled);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const setKeyMaxConcurrency = useCallback(async (id: string, maxConcurrency: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.setKeyMaxConcurrency(id, maxConcurrency);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const setKeyPermissions = useCallback(async (
    id: string,
    permissions: OutboundPermissionId[],
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.setKeyPermissions(id, permissions);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const setKeyPolicy = useCallback(async (id: string, policy: OutboundKeyPolicyPatch) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.setKeyPolicy(id, policy);
      if (!result.success) setError(result.message ?? 'request failed');
      setKeys(await agent.apiService.listKeys());
    } finally {
      setBusy(false);
    }
  }, []);

  const updateQueueConfig = useCallback(
    async (patch: {
      userMessageQueue?: OutboundApiServerConfig['userMessageQueue'];
      concurrencyQueue?: OutboundApiServerConfig['concurrencyQueue'];
    }) => {
      await runWrite(() => agent.apiService.updateQueueConfig(patch));
    },
    [runWrite],
  );

  const updateImagesConfig = useCallback(
    async (images: NonNullable<OutboundApiServerConfig['images']>) => {
      await runWrite(() => agent.apiService.updateImagesConfig(images));
    },
    [runWrite],
  );

  const updateSearchConfig = useCallback(
    async (search: SearchServerConfig) => {
      await runWrite(() => agent.apiService.updateSearchConfig(search));
    },
    [runWrite],
  );

  // The fixed-query search test does NOT go through `runWrite` (it mutates no
  // config, it probes a provider) — the card renders the returned diagnostic
  // inline (the webhook-test precedent).
  const testSearchProvider = useCallback(
    (providerId: string) => agent.apiService.testSearchProvider(providerId),
    [],
  );

  const updateBindings = useCallback(
    async (bindings: GatewayBinding[]) => {
      await runWrite(() => agent.apiService.updateBindings(bindings));
    },
    [runWrite],
  );

  const updateAllowanceSchedulingConfig = useCallback(
    async (allowanceScheduling: NonNullable<OutboundApiServerConfig['allowanceScheduling']>) => {
      await runWrite(() => agent.apiService.updateAllowanceSchedulingConfig(allowanceScheduling));
    },
    [runWrite],
  );

  const getAllowanceSchedulingStatus = useCallback(
    () => agent.apiService.getAllowanceSchedulingStatus(),
    [],
  );

  const updateProxyConfig = useCallback(
    async (proxy: OutboundApiServerConfig['proxy'] | undefined) => {
      await runWrite(() => agent.apiService.updateProxyConfig(proxy));
    },
    [runWrite],
  );

  const updateWebhookConfig = useCallback(
    async (webhook: OutboundApiServerConfig['webhook'] | undefined) => {
      await runWrite(() => agent.apiService.updateWebhookConfig(webhook));
    },
    [runWrite],
  );

  // The webhook test does NOT go through `runWrite` (it mutates no config, just
  // probes a destination) — the caller renders the returned outcome inline.
  const testWebhook = useCallback(
    (destinationId: string) => agent.apiService.testWebhook(destinationId),
    [],
  );

  const updateAuditConfig = useCallback(
    async (audit: OutboundApiServerConfig['audit'] | undefined) => {
      await runWrite(() => agent.apiService.updateAuditConfig(audit));
    },
    [runWrite],
  );

  // The audit query does NOT go through `runWrite` (it reads, mutates nothing) —
  // the viewer renders the returned records inline.
  const queryAudit = useCallback(
    (query: { keyId?: string; from?: number; to?: number; limit?: number }) =>
      agent.apiService.queryAudit(query),
    [],
  );

  // Compaction only rewrites CLOSED days, so it cannot race the live store and
  // does not go through `runWrite` either.
  const compactAudit = useCallback(() => agent.apiService.compactAudit(), []);

  const updateBillingConfig = useCallback(
    async (billing: OutboundApiServerConfig['billing'] | undefined) => {
      await runWrite(() => agent.apiService.updateBillingConfig(billing));
    },
    [runWrite],
  );

  // Read-only delivery status (reads, mutates nothing) — the indicator renders inline.
  const queryBillingStatus = useCallback(() => agent.apiService.queryBillingStatus(), []);

  const updateFingerprintConfig = useCallback(
    async (fingerprint: OutboundApiServerConfig['fingerprint'] | undefined) => {
      await runWrite(() => agent.apiService.updateFingerprintConfig(fingerprint));
    },
    [runWrite],
  );

  const updateVoucherConfig = useCallback(
    async (voucher: OutboundApiServerConfig['voucher'] | undefined) => {
      await runWrite(() => agent.apiService.updateVoucherConfig(voucher));
    },
    [runWrite],
  );

  const generateVoucher = useCallback(async (input: VoucherGenerateInput): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.generateVoucher(input);
      if (!result.success) {
        setError(result.message);
        return false;
      }
      setCreatedVoucher(result.created);
      setVouchers(await agent.apiService.listVouchers());
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  const revokeVoucher = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await agent.apiService.revokeVoucher(id);
      if (!result.success) setError(result.message ?? 'request failed');
      setVouchers(await agent.apiService.listVouchers());
    } finally {
      setBusy(false);
    }
  }, []);

  const modelOptions = useMemo(() => toModelOptions(providers), [providers]);
  const dismissCreatedKey = useCallback(() => setCreatedKey(null), []);
  const dismissCreatedVoucher = useCallback(() => setCreatedVoucher(null), []);

  return {
    loading,
    config,
    status,
    imageCapability,
    keys,
    modelOptions,
    accounts,
    busy,
    error,
    createdKey,
    queueStatus: status?.queueStatus,
    dismissCreatedKey,
    setEnabled,
    setNetworkBinding,
    updateBindings,
    createKey,
    revealKey,
    revokeKey,
    deleteKey,
    setKeyEnabled,
    setKeyMaxConcurrency,
    setKeyPermissions,
    setKeyPolicy,
    updateQueueConfig,
    updateImagesConfig,
    searchDiagnostics,
    updateSearchConfig,
    testSearchProvider,
    updateAllowanceSchedulingConfig,
    getAllowanceSchedulingStatus,
    updateProxyConfig,
    updateWebhookConfig,
    testWebhook,
    updateAuditConfig,
    queryAudit,
    compactAudit,
    updateBillingConfig,
    queryBillingStatus,
    updateFingerprintConfig,
    vouchers,
    createdVoucher,
    dismissCreatedVoucher,
    updateVoucherConfig,
    generateVoucher,
    revokeVoucher,
  };
}
