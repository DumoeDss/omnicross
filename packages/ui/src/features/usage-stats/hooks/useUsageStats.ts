/**
 * useUsageStats.ts — the Usage Stats page aggregator hook (`useApiService`
 * precedent: page data is hook-local state, not Zustand).
 *
 * Owns the WHOLE query selection:
 *  - the range MODE — `date` (presets today/7d/30d + custom date pair) or
 *    `cycle` (one billable cycle of one subscription account; cycles load from
 *    the allowance boundary ledger, so vendor-side resets and reset cards are
 *    segmented without manual date bookkeeping);
 *  - the attribute FILTERS — provider and downstream API key, threaded into
 *    every usage query (usage-filter).
 *
 * Parallel-loads the three usage endpoints for the effective range+filter with
 * a SINGLE loading/error state (a partial failure fails the whole load — no
 * silent partial data); `reload` retries the same selection.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getAllowanceCycles } from '@/daemon/usagePricingAdapter';

import type { AccountAllowanceCycle, UsageQueryFilter } from '@/daemon/types-usage-pricing';

import {
  computeCustomRange,
  computePresetRange,
  cycleAccountKey as accountKeyOf,
  cycleId as makeCycleId,
  cycleRange,
  loadUsageData,
  type RangePreset,
  type UsageData,
} from './usageStatsLogic';

import type { UsageDateRange } from '@/daemon/types-usage-pricing';

/** How the query window is chosen. */
export type UsageRangeMode = 'date' | 'cycle';

export interface UseUsageStatsResult {
  mode: UsageRangeMode;
  setMode: (mode: UsageRangeMode) => void;
  /** Date-mode selection. */
  preset: RangePreset;
  setPreset: (preset: RangePreset) => void;
  customFrom: string;
  customTo: string;
  setCustomFrom: (v: string) => void;
  setCustomTo: (v: string) => void;
  /** Cycle-mode selection (all accounts' cycles, newest first per account). */
  cycles: AccountAllowanceCycle[] | null;
  cyclesLoading: boolean;
  cyclesError: string | null;
  reloadCycles: () => void;
  cycleAccountKey: string;
  setCycleAccountKey: (key: string) => void;
  cycleId: string | null;
  setCycleId: (id: string | null) => void;
  /** Attribute filters ('' = no constraint). */
  providerFilter: string;
  setProviderFilter: (v: string) => void;
  apiKeyFilter: string;
  setApiKeyFilter: (v: string) => void;
  /** Null only when the effective selection has no queryable window. */
  range: UsageDateRange | null;
  /** The filter actually sent (null = none). In cycle mode the provider is the cycle account's. */
  filter: UsageQueryFilter | null;
  loading: boolean;
  error: string | null;
  data: UsageData | null;
  reload: () => void;
}

export function useUsageStats(): UseUsageStatsResult {
  const [mode, setMode] = useState<UsageRangeMode>('date');
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [apiKeyFilter, setApiKeyFilter] = useState('');

  // Cycles load once on mount and on `reloadCycles` (the boundary ledger only
  // grows at reset cadence — no need to poll it with the range views).
  const [cycles, setCycles] = useState<AccountAllowanceCycle[] | null>(null);
  const [cyclesLoading, setCyclesLoading] = useState(true);
  const [cyclesError, setCyclesError] = useState<string | null>(null);
  const [cyclesTick, setCyclesTick] = useState(0);
  const [cycleAccountKey, setCycleAccountKey] = useState('');
  const [cycleId, setCycleId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<UsageData | null>(null);
  // Bumped by `reload` to re-run the load effect for the same selection.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCyclesLoading(true);
    setCyclesError(null);
    void (async () => {
      try {
        const result = await getAllowanceCycles();
        if (cancelled) return;
        setCycles(result);
      } catch (err) {
        if (cancelled) return;
        // Older daemons have no cycles endpoint; "no cycle history" must not
        // look like a broken page — cycles stay null and the picker shows it.
        setCyclesError(err instanceof Error ? err.message : 'request failed');
      } finally {
        if (!cancelled) setCyclesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cyclesTick]);

  // The account whose cycles the picker lists: the explicitly chosen one, else
  // the newest cycle's account (cycles are newest-first per account).
  const accountCycles = useMemo<AccountAllowanceCycle[]>(() => {
    if (!cycles || cycles.length === 0) return [];
    const key = cycleAccountKey !== '' ? cycleAccountKey : accountKeyOf(cycles[0]);
    return cycles.filter((c) => accountKeyOf(c) === key);
  }, [cycles, cycleAccountKey]);

  const selectedCycle = useMemo<AccountAllowanceCycle | null>(() => {
    if (accountCycles.length === 0) return null;
    return accountCycles.find((c) => makeCycleId(c) === cycleId) ?? accountCycles[0];
  }, [accountCycles, cycleId]);

  const range = useMemo<UsageDateRange | null>(() => {
    if (mode === 'cycle') {
      return selectedCycle ? cycleRange(selectedCycle, Date.now()) : null;
    }
    if (preset === 'custom') return computeCustomRange(customFrom, customTo);
    return computePresetRange(preset, Date.now());
    // reloadTick re-anchors `now` for presets/ongoing cycles on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, preset, customFrom, customTo, selectedCycle, reloadTick]);

  const filter = useMemo<UsageQueryFilter | null>(() => {
    const effective: UsageQueryFilter = {};
    if (mode === 'cycle' && selectedCycle) {
      // The cycle belongs to one provider's account; the provider filter is
      // pinned to it (the key filter still narrows within the provider).
      effective.providerId = selectedCycle.providerId;
    } else if (providerFilter !== '') {
      effective.providerId = providerFilter;
    }
    if (apiKeyFilter !== '') effective.apiKeyId = apiKeyFilter;
    return effective.providerId !== undefined || effective.apiKeyId !== undefined
      ? effective
      : null;
  }, [mode, selectedCycle, providerFilter, apiKeyFilter]);

  useEffect(() => {
    if (!range) {
      // Incomplete/invalid selection: any in-flight load was just cancelled
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
        const result = await loadUsageData(range, filter ?? undefined);
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
  }, [range, filter]);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  const reloadCycles = useCallback(() => setCyclesTick((n) => n + 1), []);

  return {
    mode,
    setMode,
    preset,
    setPreset,
    customFrom,
    customTo,
    setCustomFrom,
    setCustomTo,
    cycles,
    cyclesLoading,
    cyclesError,
    reloadCycles,
    cycleAccountKey:
      cycleAccountKey !== '' && accountCycles.length > 0
        ? cycleAccountKey
        : accountCycles.length > 0
          ? accountKeyOf(accountCycles[0])
          : '',
    setCycleAccountKey,
    cycleId: selectedCycle ? makeCycleId(selectedCycle) : null,
    setCycleId,
    providerFilter,
    setProviderFilter,
    apiKeyFilter,
    setApiKeyFilter,
    range,
    filter,
    loading,
    error,
    data,
    reload,
  };
}
