/**
 * UsageFilterBar.tsx — provider / API-key attribute filters for the Usage
 * Stats views (usage-filter). Options come from a WIDE by-api-key query made
 * by the page (daemon-resolved labels); the key list narrows to the chosen
 * provider. Pure presentation.
 */

import React from 'react';

import { Select } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

import { keyOptionsForProvider, type UsageFilterOptions } from '../hooks/usageStatsLogic';

interface UsageFilterBarProps {
  options: UsageFilterOptions;
  providerFilter: string;
  apiKeyFilter: string;
  /** Cycle mode pins the provider to the cycle account's; the select hides. */
  providerLocked: boolean;
  onProviderChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
}

export function UsageFilterBar({
  options,
  providerFilter,
  apiKeyFilter,
  providerLocked,
  onProviderChange,
  onApiKeyChange,
}: UsageFilterBarProps) {
  const t = useTranslation();
  const keyOptions = React.useMemo(
    () => keyOptionsForProvider(options, providerLocked ? '' : providerFilter),
    [options, providerFilter, providerLocked],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {providerLocked ? null : (
        <Select
          size="sm"
          className="h-7 w-44 text-xs"
          value={providerFilter}
          onChange={onProviderChange}
          options={[
            { value: '', label: t('usageStats.filterAllProviders') },
            ...options.providers.map((id) => ({ value: id, label: id })),
          ]}
          aria-label={t('usageStats.filterProvider')}
        />
      )}
      <Select
        size="sm"
        className="h-7 w-52 text-xs"
        value={apiKeyFilter}
        onChange={onApiKeyChange}
        disabled={keyOptions.length === 0}
        options={[
          { value: '', label: t('usageStats.filterAllKeys') },
          ...keyOptions.map((k) => ({ value: k.apiKeyId, label: k.label })),
        ]}
        aria-label={t('usageStats.filterKey')}
      />
    </div>
  );
}
