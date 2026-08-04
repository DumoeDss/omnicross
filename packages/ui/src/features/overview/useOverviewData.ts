import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadOverviewSources } from './overviewData';
import type { OverviewSource, OverviewSources } from './overviewModel';

function loadingSource<T>(previous?: OverviewSource<T>): OverviewSource<T> {
  return {
    state: 'loading',
    ...(previous?.data === undefined ? {} : { data: previous.data }),
  };
}

function loadingSources(previous?: OverviewSources): OverviewSources {
  return {
    gateway: {
      config: loadingSource(previous?.gateway.config),
      status: loadingSource(previous?.gateway.status),
      keys: loadingSource(previous?.gateway.keys),
      version: loadingSource(previous?.gateway.version),
    },
    accounts: loadingSource(previous?.accounts),
    allowances: loadingSource(previous?.allowances),
    usage: loadingSource(previous?.usage),
    integrations: loadingSource(previous?.integrations),
    audit: loadingSource(previous?.audit),
  };
}

export interface UseOverviewDataResult {
  sources: OverviewSources;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
}

export function useOverviewData(): UseOverviewDataResult {
  const [sources, setSources] = useState<OverviewSources>(() => loadingSources());
  const [refreshTick, setRefreshTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSources((previous) => loadingSources(previous));
    setRefreshing(true);
    void loadOverviewSources().then((next) => {
      if (cancelled) return;
      setSources(next);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(() => setRefreshTick((value) => value + 1), []);
  const loading = useMemo(
    () => Object.values({
      config: sources.gateway.config,
      status: sources.gateway.status,
      keys: sources.gateway.keys,
      accounts: sources.accounts,
      allowances: sources.allowances,
      usage: sources.usage,
      integrations: sources.integrations,
      audit: sources.audit,
    }).some((source) => source.state === 'loading'),
    [sources],
  );

  return { sources, loading, refreshing, refresh };
}
