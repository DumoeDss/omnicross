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

import type {
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

export interface UseAccountsResult {
  loading: boolean;
  data: AccountsListResponse;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  writeTokens: (payload: AccountTokenInput) => Promise<{ success: boolean; message?: string }>;
  /** Append a new account (+ activate) with an optional label. */
  appendTokens: (
    payload: AccountTokenInput,
    label?: string,
  ) => Promise<{ success: boolean; message?: string }>;
  setActive: (providerId: SubscriptionProviderId, id: string) => Promise<void>;
  removeAccount: (providerId: SubscriptionProviderId, accountId: string) => Promise<void>;
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
  ) => Promise<{ success: boolean; message?: string }>;
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

  const refresh = useCallback(async () => {
    const next = await agent.accounts.list();
    setData(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const next = await agent.accounts.list();
      if (!cancelled) {
        setData(next);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  // Token-free passthrough poll (the dialog owns the polling loop + the "waiting"
  // UI). Does NOT toggle `busy` (it runs in the background while the dialog is open).
  const pollCodexOAuth = useCallback(
    (sessionId: string): Promise<CodexOAuthStatus> => agent.accounts.pollCodexOAuth(sessionId),
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
    clearError,
    refresh,
    writeTokens,
    appendTokens,
    setActive,
    removeAccount,
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
