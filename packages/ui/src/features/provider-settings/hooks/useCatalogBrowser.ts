import { useMemo, useState } from 'react';

import type {
  LLMProvider,
  ProviderModelDiscoveryEntry,
} from '@shared/llm-config';

import type { ModelCatalogFilterKey } from '../types';
import {
  buildAutoGroupsFromCatalog,
  MODEL_FILTER_DEFS,
} from '../utils';

/**
 * Manages catalog browsing, filtering, and grouping for model discovery results.
 */
export function useCatalogBrowser(
  selectedProvider: LLMProvider | null,
  discoveryModels: ProviderModelDiscoveryEntry[],
  showManageModels: boolean,
) {
  const [catalogSearchTerm, setCatalogSearchTerm] = useState('');
  const [catalogFilter, setCatalogFilter] = useState<ModelCatalogFilterKey>('all');
  const [catalogCollapsedGroups, setCatalogCollapsedGroups] = useState<Record<string, boolean>>({});

  // Reset catalog state when model management panel closes
  const [prevShowManage, setPrevShowManage] = useState(showManageModels);
  const [prevProviderId, setPrevProviderId] = useState(selectedProvider?.id);
  if (prevShowManage !== showManageModels || prevProviderId !== selectedProvider?.id) {
    setPrevShowManage(showManageModels);
    setPrevProviderId(selectedProvider?.id);
    if (!showManageModels) {
      setCatalogSearchTerm('');
      setCatalogFilter('all');
      setCatalogCollapsedGroups({});
    }
  }

  const selectedCatalogFilterDef = useMemo(() => {
    return MODEL_FILTER_DEFS.find((def) => def.key === catalogFilter) ?? MODEL_FILTER_DEFS[0];
  }, [catalogFilter]);

  const filteredDiscoveryModels = useMemo(() => {
    const term = catalogSearchTerm.trim().toLowerCase();
    if (!discoveryModels.length) return [];
    return discoveryModels.filter((model) => {
      const searchMatch =
        !term ||
        model.name?.toLowerCase().includes(term) ||
        model.id.toLowerCase().includes(term) ||
        (model.description?.toLowerCase().includes(term) ?? false);
      const filterMatch = selectedCatalogFilterDef.predicate(model);
      return searchMatch && filterMatch;
    });
  }, [discoveryModels, catalogSearchTerm, selectedCatalogFilterDef]);

  const catalogGroups = useMemo(() => {
    if (!selectedProvider || !filteredDiscoveryModels.length) return [];
    return buildAutoGroupsFromCatalog(selectedProvider, filteredDiscoveryModels);
  }, [selectedProvider, filteredDiscoveryModels]);

  const toggleCatalogGroup = (groupId: string) => {
    setCatalogCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  return {
    catalogSearchTerm,
    setCatalogSearchTerm,
    catalogFilter,
    setCatalogFilter,
    catalogCollapsedGroups,
    toggleCatalogGroup,
    filteredDiscoveryModels,
    catalogGroups,
  };
}
