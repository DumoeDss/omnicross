/**
 * useApiService.ts — the API Service page aggregator hook.
 *
 * Parallel-loads `GET /server` (editable config) + `GET /status` (live banner)
 * + `GET /keys` on mount, exposes the mutations wired to `agent.apiService`, and
 * holds the one-time `plaintextOnce` create-key reveal state.
 *
 * Edits drive off the `config` (kind-mapped endpoints' `modelMap`; role-based
 * endpoints' `defaultModel`/`backgroundModel`), never off the read-only
 * `status.endpoints[]` projection. After any successful write the hook re-reads
 * BOTH config + status so the editable surface and the live banner stay
 * consistent (the PUT returns only `{ server }`).
 *
 * An `incomplete-model-config` enable is a special non-success: the daemon
 * persists the partial config but refuses to start. The hook still refreshes so
 * the page's client-side "service can't start" banner reflects the persisted
 * state, and suppresses the raw error box (the banner is the actionable surface).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { agent } from '@/shared/agent';

import type {
  EndpointRoutingConfig,
  MutationResult,
  OutboundApiKeyCreated,
  OutboundApiKeyInfo,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
  OutboundKeyPolicyPatch,
  OutboundQueueStatus,
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
  keys: OutboundApiKeyInfo[];
  modelOptions: ModelRefOption[];
  busy: boolean;
  error: string | null;
  /** The one-time create-key reveal; cleared via `dismissCreatedKey`. */
  createdKey: OutboundApiKeyCreated | null;
  /** Live queue activity (`status.queueStatus`), or undefined when idle/absent. */
  queueStatus: OutboundQueueStatus | undefined;
  dismissCreatedKey: () => void;
  setEnabled: (enabled: boolean) => Promise<void>;
  setNetworkBinding: (networkBinding: boolean) => Promise<void>;
  updateEndpoint: (endpoint: EndpointRoutingConfig) => Promise<void>;
  createKey: (name: string) => Promise<boolean>;
  revokeKey: (id: string) => Promise<void>;
  setKeyEnabled: (id: string, enabled: boolean) => Promise<void>;
  setKeyMaxConcurrency: (id: string, maxConcurrency: number | null) => Promise<void>;
  setKeyPolicy: (id: string, policy: OutboundKeyPolicyPatch) => Promise<void>;
  updateQueueConfig: (patch: {
    userMessageQueue?: OutboundApiServerConfig['userMessageQueue'];
    concurrencyQueue?: OutboundApiServerConfig['concurrencyQueue'];
  }) => Promise<void>;
  updateProxyConfig: (proxy: OutboundApiServerConfig['proxy'] | undefined) => Promise<void>;
  updateWebhookConfig: (webhook: OutboundApiServerConfig['webhook'] | undefined) => Promise<void>;
  testWebhook: (destinationId: string) => Promise<WebhookTestResult>;
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
  const [keys, setKeys] = useState<OutboundApiKeyInfo[]>([]);
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<OutboundApiKeyCreated | null>(null);

  // Latest `busy` for the poll timer to read without re-arming the interval.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refreshAll = useCallback(async () => {
    const [cfg, st, ks] = await Promise.all([
      agent.apiService.getConfig(),
      agent.apiService.getStatus(),
      agent.apiService.listKeys(),
    ]);
    setConfig(cfg);
    setStatus(st);
    setKeys(ks);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const [cfg, st, ks, provs] = await Promise.all([
        agent.apiService.getConfig(),
        agent.apiService.getStatus(),
        agent.apiService.listKeys(),
        agent.llmConfig.getProviders().catch(() => [] as LLMProvider[]),
      ]);
      if (cancelled) return;
      setConfig(cfg);
      setStatus(st);
      setKeys(ks);
      setProviders(provs);
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
      void agent.apiService.getStatus().then((st) => {
        // Guard against a write landing between the fetch and the resolve.
        if (!busyRef.current && st) setStatus(st);
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
          // An incomplete-model-config enable persisted a partial config but did
          // not start the listener — refresh so the client-side "can't start"
          // banner (derived from `config`) lights up, and skip the raw error box.
          if (result.missing) {
            await refreshAll();
            return false;
          }
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

  const updateEndpoint = useCallback(
    async (endpoint: EndpointRoutingConfig) => {
      await runWrite(() => agent.apiService.updateEndpoint(endpoint));
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

  const modelOptions = useMemo(() => toModelOptions(providers), [providers]);
  const dismissCreatedKey = useCallback(() => setCreatedKey(null), []);

  return {
    loading,
    config,
    status,
    keys,
    modelOptions,
    busy,
    error,
    createdKey,
    queueStatus: status?.queueStatus,
    dismissCreatedKey,
    setEnabled,
    setNetworkBinding,
    updateEndpoint,
    createKey,
    revokeKey,
    setKeyEnabled,
    setKeyMaxConcurrency,
    setKeyPolicy,
    updateQueueConfig,
    updateProxyConfig,
    updateWebhookConfig,
    testWebhook,
  };
}
