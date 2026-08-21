/**
 * useLiveThroughput — polls `GET /usage/throughput` so the Overview can show a
 * live request rate.
 *
 * Separate from `useOverviewData` on purpose: that hook loads its sources once
 * per mount/refresh, while a rate only means something if it keeps ticking. The
 * polling shape mirrors `features/upstreams/OverloadTrendView` (re-entrancy
 * guard, interval cleared on unmount), plus a `document.hidden` skip so a
 * backgrounded window stops asking.
 *
 * The daemon answers this from an in-memory sliding window, so the poll costs it
 * no disk I/O — unlike the range-query usage views, which re-parse the whole
 * event log per call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getUsageThroughput } from '@/daemon/usagePricingAdapter';

import type { OverviewSource } from './overviewModel';

import type { UsageThroughputResult } from '@/daemon/types-usage-pricing';

/** Poll cadence. Fast enough to feel live, slow enough to stay cheap. */
export const THROUGHPUT_POLL_MS = 5_000;

export interface UseLiveThroughputResult {
  source: OverviewSource<UsageThroughputResult>;
  refresh: () => void;
}

export function useLiveThroughput(): UseLiveThroughputResult {
  const [source, setSource] = useState<OverviewSource<UsageThroughputResult>>({ state: 'loading' });
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await getUsageThroughput();
      if (mounted.current) setSource({ state: 'ready', data });
    } catch (error) {
      // `getUsageThroughput` already degrades a missing endpoint into
      // `available: false`, so reaching here means the transport itself broke.
      if (mounted.current) {
        setSource({
          state: 'unavailable',
          message: error instanceof Error ? error.message : 'throughput read failed',
        });
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => {
      // A hidden tab cannot be read, so do not keep asking on its behalf. The
      // next visible tick refreshes it.
      if (typeof document !== 'undefined' && document.hidden) return;
      void load();
    }, THROUGHPUT_POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { source, refresh };
}
