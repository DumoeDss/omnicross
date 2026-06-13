import { useEffect, useMemo, useState } from 'react';

import { agent } from '@/shared/agent';
import { useLlmProvidersData } from '@/shared/state/settingsStore';

import type { DaemonPresetView } from '@/daemon/types';
import type { ApiFormat, LLMProvider } from '@shared/llm-config';

import { useCatalogBrowser } from './useCatalogBrowser';
import { useModelManagement } from './useModelManagement';
import { useProviderForm } from './useProviderForm';

/** daemon preset apiFormat ('openai'|'anthropic'|'gemini') → UI ApiFormat. */
function presetUiFormat(fmt: DaemonPresetView['apiFormat']): ApiFormat {
  return fmt === 'gemini' ? 'google' : fmt;
}

/**
 * Synthesize a not-yet-added preset as a DISABLED, keyless provider row so the
 * catalog appears in the list just like a configured-but-disabled provider — the
 * user fills the key + flips enable inline to use it. The `__preset` marker tells
 * the form handlers to MATERIALIZE it (create the real daemon provider) on the
 * first key/enable; until then it is never sent to the daemon.
 */
function synthesizePresetRow(p: DaemonPresetView): LLMProvider {
  return {
    id: p.id,
    name: p.name,
    apiFormat: presetUiFormat(p.apiFormat),
    api_base_url: p.baseUrl,
    api_key: '',
    hasKey: false,
    models: p.models ?? [],
    enabled: false,
    presetId: p.presetId,
    __preset: true,
    // A catalog (preset) provider is BUILT-IN: it can be configured (key/enable)
    // but NOT renamed or deleted. `isSystem` gates the rename input + delete
    // button (ProviderDetails) and the delete guard (useProviderForm).
    isSystem: true,
  };
}

/**
 * Merge real daemon providers with the preset catalog so presets show as list
 * rows. Custom (non-preset) providers come first, then the catalog in its stable
 * order — each catalog slot is the REAL provider when already added (id match),
 * else a synthesized preset row. Materializing a preset therefore flips its row
 * in place (no reorder, no duplicate).
 */
function mergeWithPresets(real: LLMProvider[], presets: DaemonPresetView[]): LLMProvider[] {
  if (presets.length === 0) return real;
  const presetIds = new Set(presets.map((p) => p.id));
  const byId = new Map(real.map((p) => [p.id, p]));
  const custom = real.filter((p) => !presetIds.has(p.id));
  const catalog = presets.map((p) => {
    const existing = byId.get(p.id);
    // An ALREADY-ADDED preset (materialized) keeps its stored config but is still
    // built-in — the daemon doesn't return `isSystem`, so stamp it here so a
    // catalog provider can never be renamed/deleted (only user-added custom
    // providers can). A not-yet-added preset is synthesized (already isSystem).
    return existing
      ? { ...existing, isSystem: true, presetId: existing.presetId ?? p.presetId }
      : synthesizePresetRow(p);
  });
  return [...custom, ...catalog];
}

/**
 * Composition hook that assembles provider form, model management, and catalog browser.
 */
export function useProviderSettings() {
  const {
    providers: realProviders,
    loading: providersLoading,
    error: providersError,
    refresh: refreshProviders,
    updateProvider: updateProviderInCache,
  } = useLlmProvidersData();

  // Preset catalog (static) — fetched once and merged into the list as rows.
  const [presets, setPresets] = useState<DaemonPresetView[]>([]);
  useEffect(() => {
    let alive = true;
    void agent.llmConfig.getPresets().then((list) => {
      if (alive) setPresets(list ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  const providers = useMemo(
    () => mergeWithPresets(realProviders, presets),
    [realProviders, presets],
  );

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Auto-select first provider when none is explicitly selected
  const effectiveSelectedProviderId = selectedProviderId ?? (providers.length > 0 ? providers[0].id : null);

  const selectedProvider = useMemo(() => {
    return providers.find(p => p.id === effectiveSelectedProviderId) || null;
  }, [providers, effectiveSelectedProviderId]);

  // Secret re-entry signal (provider-storage-overlay): enabled providers that
  // report no stored key (`hasKey === false`) — e.g. after a machine/profile
  // change where the machine-local secrets did not travel. A `$VAR` env ref is
  // NOT a missing key (it round-trips as a non-empty api_key + hasKey true).
  const missingKeyProviderIds = useMemo(
    () => providers.filter(p => p.enabled && p.hasKey === false).map(p => p.id),
    [providers],
  );

  // ── Sub-hooks ───────────────────────────────────────────────────
  const form = useProviderForm(
    providers, effectiveSelectedProviderId, setSelectedProviderId,
    selectedProvider, refreshProviders, updateProviderInCache,
  );

  const models = useModelManagement(selectedProvider, updateProviderInCache);

  const catalog = useCatalogBrowser(
    selectedProvider, models.discoveryModels, models.showManageModels,
  );

  return {
    providers,
    providersLoading,
    providersError,
    searchTerm,
    setSearchTerm,
    selectedProviderId: effectiveSelectedProviderId,
    selectedProvider,
    missingKeyProviderIds,
    missingKeyCount: missingKeyProviderIds.length,
    ...form,
    ...models,
    ...catalog,
  };
}
