/**
 * useUsageTrend.ts — loads the token/cost trend for the picker's range at a
 * chosen bucket granularity. The bucket defaults to `autoBucketForRange(range)`
 * and re-syncs to it whenever the range changes; a manual granularity toggle
 * wins until the range changes again (then it snaps back to auto). A null range
 * (incomplete custom pick) loads nothing — mirrors `useUsageStats`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getUsageTimeSeries } from '@/daemon/usagePricingAdapter';

import { autoBucketForRange } from './usageStatsLogic';

import type {
  UsageDateRange,
  UsageTimeBucket,
  UsageTimeSeriesBucket,
} from '@/daemon/types-usage-pricing';

export interface UseUsageTrendResult {
  series: UsageTimeSeriesBucket[] | null;
  bucket: UsageTimeBucket;
  setBucket: (bucket: UsageTimeBucket) => void;
  autoBucket: UsageTimeBucket;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useUsageTrend(range: UsageDateRange | null): UseUsageTrendResult {
  const autoBucket = useMemo<UsageTimeBucket>(
    () => (range ? autoBucketForRange(range) : 'day'),
    [range],
  );

  // Manual override for the CURRENT range; cleared on range change so the
  // bucket re-syncs to `autoBucket`.
  const [override, setOverride] = useState<UsageTimeBucket | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [range]);

  const bucket = override ?? autoBucket;

  const [series, setSeries] = useState<UsageTimeSeriesBucket[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!range) {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await getUsageTimeSeries(range, bucket);
        if (cancelled) return;
        setSeries(result);
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
  }, [range, bucket, reloadTick]);

  const setBucket = useCallback((next: UsageTimeBucket) => setOverride(next), []);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  return { series, bucket, setBucket, autoBucket, loading, error, reload };
}
