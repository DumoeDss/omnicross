/**
 * settingsStore (design D3) — a SINGLE-slice Zustand store exposing only
 * `useLlmProvidersData()` with the same `{ providers, loading, error, refresh,
 * updateProvider }` shape the upstream's composed multi-slice store exposes for
 * the Provider page. No credentials/media/audio/user-pref slices, no persist
 * middleware, no chat-store bridge.
 *
 * The fetcher calls `agent.llmConfig.getProviders()` (identical to upstream).
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { agent } from '@/shared/agent';

import type { LLMProvider } from '@shared/llm-config';

interface ProvidersState {
  providers: LLMProvider[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  updateProvider: (provider: LLMProvider) => void;
}

const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  loaded: false,
  async refresh() {
    set({ loading: true, error: null });
    try {
      const providers = await agent.llmConfig.getProviders();
      set({ providers, loading: false, loaded: true });
    } catch (err) {
      set({
        loading: false,
        loaded: true,
        error: err instanceof Error ? err.message : 'Failed to load providers',
      });
    }
  },
  updateProvider(provider) {
    set({ providers: get().providers.map((p) => (p.id === provider.id ? provider : p)) });
  },
}));

/**
 * The hook the ported page consumes. On first mount it kicks off a load (so the
 * page renders against the daemon without an explicit caller).
 */
export function useLlmProvidersData(): {
  providers: LLMProvider[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateProvider: (p: LLMProvider) => void;
} {
  const providers = useProvidersStore((s) => s.providers);
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);
  const loaded = useProvidersStore((s) => s.loaded);
  const refresh = useProvidersStore((s) => s.refresh);
  const updateProvider = useProvidersStore((s) => s.updateProvider);

  useEffect(() => {
    if (!loaded && !loading) void refresh();
    // run once on mount; refresh is stable (zustand action identity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { providers, loading, error, refresh, updateProvider };
}
