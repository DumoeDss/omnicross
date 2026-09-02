/**
 * useSearchSettings — the standalone Search page's own hook
 * (search-settings-tab, design D5). Everything search the API Service page's
 * aggregator used to carry, and nothing else.
 *
 * Mount-load `getConfig()` (which also primes the adapter's shared masked
 * cache — `fullSearchSegment` rebuilds from it on save) + the diagnostics
 * snapshot; saves go through the runWrite discipline (busy + honest error +
 * refresh-after-write); the interactive query is a direct non-mutating action
 * (the webhook-test precedent — the panel renders the returned outcome inline).
 */

import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';

import { agent } from '@/shared/agent';

import type {
  MutationResult,
  SearchDiagnosticsSnapshot,
  SearchQueryOutcome,
  SearchServerConfig,
} from '@/daemon/types';

export interface UseSearchSettingsResult {
  loading: boolean;
  /** The masked `search` segment; undefined when the daemon predates it. */
  config: SearchServerConfig | undefined;
  /** Secret-free diagnostics; null on a daemon that predates the endpoint. */
  diagnostics: SearchDiagnosticsSnapshot | null;
  busy: boolean;
  error: string | null;
  /** Persist the full search segment (layer-replaced; secrets write-only). */
  updateSearchConfig: (search: SearchServerConfig) => Promise<void>;
  /** Run the operator's query through one provider (non-mutating, direct). */
  runSearchQuery: (providerId: string, query: string) => Promise<SearchQueryOutcome>;
  /** Re-read the config + diagnostics (exposed for a manual refresh). */
  refresh: () => Promise<void>;
}

export function useSearchSettings(): UseSearchSettingsResult {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<SearchServerConfig | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<SearchDiagnosticsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    // getConfig() also primes the adapter's shared masked-config cache — the
    // save path's full-segment rebuild depends on it (trap #1 discipline).
    const [server, snapshot] = await Promise.all([
      agent.apiService.getConfig(),
      agent.apiService.getSearchDiagnostics(),
    ]);
    setConfig(server?.search);
    setDiagnostics(snapshot);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // The Tauri webview can mount a fraction before its bundled daemon has
      // bound the admin port (the useApiService cold-start precedent): retry
      // only that window; browser mode keeps fail-fast behavior.
      const attempts = isTauri() ? 20 : 1;
      let loaded = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const [server, snapshot] = await Promise.all([
          agent.apiService.getConfig(),
          agent.apiService.getSearchDiagnostics(),
        ]);
        if (cancelled) return;
        if (server) {
          setConfig(server.search);
          setDiagnostics(snapshot);
          loaded = true;
          break;
        }
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
      if (cancelled) return;
      if (!loaded) {
        setConfig(undefined);
        setDiagnostics(null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Run a save, surface its failure honestly, then re-read config +
  // diagnostics so the card states (and the pending-restart comparison) see
  // the persisted truth.
  const updateSearchConfig = useCallback(
    async (search: SearchServerConfig): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const result: MutationResult = await agent.apiService.updateSearchConfig(search);
        if (!result.success) {
          setError(result.message ?? 'request failed');
          return;
        }
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // The interactive query mutates nothing — it never flips `busy`; the panel
  // owns its testing state and renders the returned outcome inline.
  const runSearchQuery = useCallback(
    (providerId: string, query: string): Promise<SearchQueryOutcome> =>
      agent.apiService.runSearchQuery(providerId, query),
    [],
  );

  return {
    loading,
    config,
    diagnostics,
    busy,
    error,
    updateSearchConfig,
    runSearchQuery,
    refresh,
  };
}
