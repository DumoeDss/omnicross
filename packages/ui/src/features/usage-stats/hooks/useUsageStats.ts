/**
 * useUsageStats.ts — the Usage Stats page aggregator hook (`useApiService`
 * precedent: page data is hook-local state, not Zustand).
 *
 * Holds the range selection (presets today/7d/30d + custom date pair) and
 * parallel-loads the three usage endpoints on every range change with a
 * SINGLE loading/error state (`loadUsageData` fails the whole load on any
 * partial failure — no silent partial data). `reload` retries the same range.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  computeCustomRange,
  computePresetRange,
  loadUsageData,
  type RangePreset,
  type UsageData,
} from './usageStatsLogic';

import type { UsageDateRange } from '@/daemon/types-usage-pricing';

export interface UseUsageStatsResult {
  preset: RangePreset;
  setPreset: (preset: RangePreset) => void;
  customFrom: string;
  customTo: string;
  setCustomFrom: (v: string) => void;
  setCustomTo: (v: string) => void;
  /** Null only while a custom range is incomplete/invalid. */
  range: UsageDateRange | null;
  loading: boolean;
  error: string | null;
  data: UsageData | null;
  reload: () => void;
}

export function useUsageStats(): UseUsageStatsResult {
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageData | null>(null);
  // Bumped by `reload` to re-run the load effect for the same range.
  const [reloadTick, setReloadTick] = useState(0);

  const range = useMemo<UsageDateRange | null>(() => {
    if (preset === 'custom') return computeCustomRange(customFrom, customTo);
    return computePresetRange(preset, Date.now());
    // reloadTick re-anchors `now` for presets on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, reloadTick]);

  useEffect(() => {
    if (!range) {
      // Incomplete/invalid custom range: any in-flight load was just cancelled
      // by the previous effect's cleanup, so clear the transient states here —
      // otherwise the page is stuck on `loading` forever.
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await loadUsageData(range);
        if (cancelled) return;
        setData(result);
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
  }, [range]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return {
    preset,
    setPreset,
    customFrom,
    customTo,
    setCustomFrom,
    setCustomTo,
    range,
    loading,
    error,
    data,
    reload,
  };
}
