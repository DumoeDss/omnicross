/**
 * useUsageFilterOptions.ts — loads the PROVIDER / KEY filter options once on
 * mount (usage-filter): a WIDE (unfiltered) by-api-key query over the last 30
 * days, from which distinct providers and labelled keys are derived. A failure
 * degrades to empty options (the selects show only their "all" choices) rather
 * than an error banner — the filter is an enhancement, not a load-bearing view.
 */

import { useEffect, useState } from 'react';

import { getUsageByApiKey } from '@/daemon/usagePricingAdapter';

import { buildFilterOptions, type UsageFilterOptions } from './usageStatsLogic';

const DAY_MS = 86_400_000;

export interface UseUsageFilterOptionsResult {
  options: UsageFilterOptions;
  loading: boolean;
}

export function useUsageFilterOptions(): UseUsageFilterOptionsResult {
  const [options, setOptions] = useState<UsageFilterOptions>({ providers: [], keys: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const now = Date.now();
        const rows = await getUsageByApiKey({ startTs: now - 30 * DAY_MS, endTs: now });
        if (cancelled) return;
        setOptions(buildFilterOptions(rows));
      } catch {
        /* empty options — the filter bar simply has nothing to narrow to */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { options, loading };
}
