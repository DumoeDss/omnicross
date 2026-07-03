/**
 * useDashboardSummary.ts — loads the range-INDEPENDENT dashboard overview
 * (today/all-time totals, provider/key/account counts, server status) on mount
 * and on `reload`. Its own loading/error state so an overview failure doesn't
 * blank the range-driven tables (mirrors `useUsageStats`'s cancel-on-unmount +
 * reload-tick pattern).
 */

import { useCallback, useEffect, useState } from 'react';

import { getDashboardSummary } from '@/daemon/usagePricingAdapter';

import type { DashboardSummary } from '@/daemon/types-usage-pricing';

export interface UseDashboardSummaryResult {
  summary: DashboardSummary | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useDashboardSummary(): UseDashboardSummaryResult {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await getDashboardSummary();
        if (cancelled) return;
        setSummary(result);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'request failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return { summary, loading, error, reload };
}
