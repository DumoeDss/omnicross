/**
 * useAccounts.ts — the Accounts / Subscriptions page aggregator hook.
 *
 * Loads `GET /accounts` (token-free status + sanitized per-provider account
 * lists) on mount and exposes the write / set-active / remove / clear mutations
 * wired to `agent.accounts`. Writes are status-only — the submitted token never
 * round-trips; on a successful write the hook re-reads `GET /accounts` so the
 * status + account list reflect the new state.
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

import {
  allowanceKey,
  mergeAllowances,
  probeAndReloadCodexAllowance,
} from '../allowanceLogic';

import type {
  AccountAllowanceSnapshot,
  AccountBatchInput,
  AccountConnectionTestResult,
  AccountManagementPatch,
  AccountProbeRecord,
  AccountsListResponse,
  AccountTokenInput,
  CodexOAuthStatus,
  ProxyConfig,
  RefreshResult,
  StartOAuthResult,
  SubscriptionProviderId,
} from '@/daemon/types';

const EMPTY: AccountsListResponse = {
  accounts: [],
  providerAccounts: { claude: [], codex: [], gemini: [], opencodego: [] },
};

/** Keep request-driven account metadata and passive Codex allowance observations live. */
const ACCOUNT_READ_MODEL_POLL_MS = 30_000;

export interface UseAccountsResult {
  loading: boolean;
  data: AccountsListResponse;
  busy: boolean;
  error: string | null;
  allowances: AccountAllowanceSnapshot[];
  allowanceLoading: boolean;
  allowanceError: string | null;
  allowanceErrors: Record<string, string>;
  clearError: () => void;
  refresh: () => Promise<void>;
  refreshAllowances: () => Promise<{ success: boolean; message?: string }>;
  /** Force-refresh a single Claude account without replacing unrelated snapshots. */
  refreshAccountAllowance: (
    accountId: string,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Run one confirmed Luna request for a Codex account, then reload its passive snapshot. */
  refreshCodexAccountAllowance: (
    accountId: string,
  ) => Promise<{ success: boolean; message?: string }>;
  writeTokens: (payload: AccountTokenInput) => Promise<{ success: boolean; message?: string }>;
  /** Append a new account (+ activate) with an optional label. */
  appendTokens: (
    payload: AccountTokenInput,
    label?: string,
  ) => Promise<{ success: boolean; message?: string }>;
  setActive: (providerId: SubscriptionProviderId, id: string) => Promise<void>;
  removeAccount: (providerId: SubscriptionProviderId, accountId: string) => Promise<void>;
  patchAccount: (
    providerId: SubscriptionProviderId,
    accountId: string,
    patch: AccountManagementPatch,
  ) => Promise<{ success: boolean; message?: string }>;
  batchManage: (
    input: AccountBatchInput,
  ) => Promise<{ success: boolean; affected?: number; message?: string }>;
  testAccount: (
    providerId: SubscriptionProviderId,
    accountId: string,
  ) => Promise<AccountConnectionTestResult>;
  listAccountEvents: (
    providerId: SubscriptionProviderId,
    accountId: string,
  ) => Promise<{ success: boolean; events: AccountProbeRecord[]; message?: string }>;
  /** Rename one account's label (label-only). Returns success for inline feedback. */
  renameAccount: (
    providerId: SubscriptionProviderId,
    accountId: string,
    label: string,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Set one account's scheduling priority. Returns success for inline feedback. */
  setAccountPriority: (
    providerId: SubscriptionProviderId,
    accountId: string,
    priority: number,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Set (or clear, with `undefined`) one account's per-account proxy override. */
  setAccountProxy: (
    providerId: SubscriptionProviderId,
    accountId: string,
    proxy: ProxyConfig | undefined,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Set (or clear, with `undefined`) one account's `supportedModels`
   *  (subscription-account-model-map) — array allow-list or object remap. */
  setAccountSupportedModels: (
    providerId: SubscriptionProviderId,
    accountId: string,
    supportedModels: string[] | Record<string, string> | undefined,
  ) => Promise<{ success: boolean; message?: string }>;
  /** Refresh the active account's OAuth token. Returns the honest daemon outcome. */
  refreshProvider: (providerId: SubscriptionProviderId) => Promise<RefreshResult>;
  clearProvider: (providerId: SubscriptionProviderId) => Promise<void>;
  startOAuth: (providerId: SubscriptionProviderId) => Promise<StartOAuthResult | null>;
  completeOAuth: (
    providerId: SubscriptionProviderId,
    input: { sessionId: string; code: string; label?: string },
  ) => Promise<{ success: boolean; message?: string; sessionExpired?: boolean }>;
  /** Poll a codex loopback sign-in's token-free status (app-parity-2 child 5). */
  pollCodexOAuth: (sessionId: string) => Promise<CodexOAuthStatus>;
  cancelCodexOAuth: (sessionId: string) => Promise<{ success: boolean; message?: string }>;
  /** Import the daemon machine's external CLI login as a managed account. */
  importExternalCli: (
    providerId: 'claude' | 'codex',
  ) => Promise<{ success: boolean; message?: string }>;
}

export function useAccounts(): UseAccountsResult {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AccountsListResponse>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowances, setAllowances] = useState<AccountAllowanceSnapshot[]>([]);
  const [allowanceLoading, setAllowanceLoading] = useState(true);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const [allowanceErrors, setAllowanceErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const next = await agent.accounts.list();
    setData(next);
  }, []);

  const refreshAllowances = useCallback(async () => {
    setAllowanceLoading(true);
    const result = await agent.accounts.listAllowances();
    if (result.success) {
      setAllowances(result.allowances);
      setAllowanceError(null);
      setAllowanceErrors({});
    } else {
      // Preserve the last usable snapshots on an allowance-only failure.
      setAllowanceError(result.message ?? 'failed to load account allowances');
    }
    setAllowanceLoading(false);
    return result.success
      ? { success: true }
      : { success: false, message: result.message ?? 'failed to load account allowances' };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setAllowanceLoading(true);
      const [next, nextAllowances] = await Promise.all([
        agent.accounts.list(),
        agent.accounts.listAllowances(),
      ]);
      if (!cancelled) {
        setData(next);
        setLoading(false);
        if (nextAllowances.success) {
          setAllowances(nextAllowances.allowances);
          setAllowanceError(null);
        } else {
          setAllowanceError(nextAllowances.message ?? 'failed to load account allowances');
        }
        setAllowanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const pollReadModels = async () => {
      if (polling || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      polling = true;
      try {
        const [nextAccounts, nextAllowances] = await Promise.allSettled([
          agent.accounts.list(),
          agent.accounts.listAllowances(),
        ]);
        if (cancelled) return;
        if (nextAccounts.status === 'fulfilled') setData(nextAccounts.value);
        if (nextAllowances.status === 'fulfilled') {
          if (nextAllowances.value.success) {
            setAllowances(nextAllowances.value.allowances);
            setAllowanceError(null);
          } else {
            setAllowanceError(nextAllowances.value.message ?? 'failed to load account allowances');
          }
        }
      } finally {
        polling = false;
      }
    };

    const interval = globalThis.setInterval(() => void pollReadModels(), ACCOUNT_READ_MODEL_POLL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void pollReadModels();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const refreshAccountAllowance = useCallback(async (accountId: string) => {
    const key = allowanceKey('claude', accountId);
    setAllowanceErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const result = await agent.accounts.refreshAllowance('claude', accountId);
    if (!result.success) {
      const message = result.message ?? 'failed to refresh account allowance';
      setAllowanceErrors((current) => ({ ...current, [key]: message }));
      return { success: false, message };
    }
    setAllowances((current) => mergeAllowances(current, result.allowances));
    return { success: true };
  }, []);

  const writeTokens = useCallback(
    async (payload: AccountTokenInput) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.writeTokens(payload);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const appendTokens = useCallback(
    async (payload: AccountTokenInput, label?: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.appendTokens(payload, label);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const runWrite = useCallback(
    async (op: () => Promise<{ success: boolean; message?: string }>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await op();
        if (!result.success) setError(result.message ?? 'request failed');
        else await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const setActive = useCallback(
    async (providerId: SubscriptionProviderId, id: string) => {
      await runWrite(() => agent.accounts.setActive(providerId, id));
    },
    [runWrite],
  );

  const removeAccount = useCallback(
    async (providerId: SubscriptionProviderId, accountId: string) => {
      await runWrite(() => agent.accounts.removeAccount(providerId, accountId));
    },
    [runWrite],
  );

  const clearProvider = useCallback(
    async (providerId: SubscriptionProviderId) => {
      await runWrite(() => agent.accounts.clearProvider(providerId));
    },
    [runWrite],
  );

  const renameAccount = useCallback(
    async (providerId: SubscriptionProviderId, accountId: string, label: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.renameAccount(providerId, accountId, label);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const setAccountPriority = useCallback(
    async (providerId: SubscriptionProviderId, accountId: string, priority: number) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.setAccountPriority(providerId, accountId, priority);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const setAccountProxy = useCallback(
    async (providerId: SubscriptionProviderId, accountId: string, proxy: ProxyConfig | undefined) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.setAccountProxy(providerId, accountId, proxy);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const setAccountSupportedModels = useCallback(
    async (
      providerId: SubscriptionProviderId,
      accountId: string,
      supportedModels: string[] | Record<string, string> | undefined,
    ) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.setAccountSupportedModels(providerId, accountId, supportedModels);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const refreshProvider = useCallback(
    async (providerId: SubscriptionProviderId) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.refreshProvider(providerId);
        if (!result.success) setError(result.message ?? 'request failed');
        // Re-read even on ok:false so a status flip to 'expired' surfaces.
        await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const startOAuth = useCallback(
    async (providerId: SubscriptionProviderId): Promise<StartOAuthResult | null> => {
      setBusy(true);
      setError(null);
      try {
        // Returns ONLY the public authorize URL + an opaque sessionId (no secret).
        return await agent.accounts.startOAuth(providerId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to start sign-in');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const completeOAuth = useCallback(
    async (
      providerId: SubscriptionProviderId,
      input: { sessionId: string; code: string; label?: string },
    ) => {
      setBusy(true);
      setError(null);
      try {
        // Status-only: the minted token never round-trips. Refresh on success.
        const result = await agent.accounts.completeOAuth(providerId, input);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          // `sessionExpired` tells the caller the pending session is unusable, so
          // it can drop the inline panel instead of offering a dead retry.
          return { success: false, message: result.message, sessionExpired: result.sessionExpired };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Token-free passthrough poll (the dialog owns the polling loop + the "waiting"
  // UI). Does NOT toggle `busy` (it runs in the background while the dialog is open).
  const pollCodexOAuth = useCallback(
    (sessionId: string): Promise<CodexOAuthStatus> => agent.accounts.pollCodexOAuth(sessionId),
    [],
  );

  const patchAccount = useCallback(
    async (
      providerId: SubscriptionProviderId,
      accountId: string,
      patch: AccountManagementPatch,
    ) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.patchAccount(providerId, accountId, patch);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return result;
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const batchManage = useCallback(
    async (input: AccountBatchInput) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.batchManage(input);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return result;
        }
        await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const testAccount = useCallback(
    async (providerId: SubscriptionProviderId, accountId: string) => {
      const result = await agent.accounts.testAccount(providerId, accountId);
      // Probe outcome updates live health and the sanitized scheduling state.
      await refresh();
      return result;
    },
    [refresh],
  );

  const refreshCodexAccountAllowance = useCallback(
    async (accountId: string) => {
      const key = allowanceKey('codex', accountId);
      setAllowanceErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      const result = await probeAndReloadCodexAllowance(
        () => testAccount('codex', accountId),
        refreshAllowances,
      );
      if (!result.success) {
        setAllowanceErrors((current) => ({
          ...current,
          [key]: result.message ?? 'failed to refresh Codex allowance',
        }));
      }
      return result;
    },
    [refreshAllowances, testAccount],
  );

  const listAccountEvents = useCallback(
    (providerId: SubscriptionProviderId, accountId: string) =>
      agent.accounts.listAccountEvents(providerId, accountId),
    [],
  );

  const cancelCodexOAuth = useCallback(
    (sessionId: string) => agent.accounts.cancelCodexOAuth(sessionId),
    [],
  );

  const importExternalCli = useCallback(
    async (providerId: 'claude' | 'codex') => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.accounts.importExternalCli(providerId);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return { success: false, message: result.message };
        }
        await refresh();
        return { success: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    loading,
    data,
    busy,
    error,
    allowances,
    allowanceLoading,
    allowanceError,
    allowanceErrors,
    clearError,
    refresh,
    refreshAllowances,
    refreshAccountAllowance,
    refreshCodexAccountAllowance,
    writeTokens,
    appendTokens,
    setActive,
    removeAccount,
    patchAccount,
    batchManage,
    testAccount,
    listAccountEvents,
    renameAccount,
    setAccountPriority,
    setAccountProxy,
    setAccountSupportedModels,
    refreshProvider,
    clearProvider,
    startOAuth,
    completeOAuth,
    pollCodexOAuth,
    cancelCodexOAuth,
    importExternalCli,
  };
}
