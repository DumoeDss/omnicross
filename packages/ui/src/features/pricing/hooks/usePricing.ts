/**
 * usePricing.ts — the Pricing page aggregator hook (`useApiService`
 * precedent: hook-local state).
 *
 * Owns: the entry list (+ re-GET after every successful mutation, matching
 * the daemon design note), the search filter, save/delete mutations gated by
 * client-side validation (mirroring the daemon's rules), the fetch-latest
 * flow (busy state → appliedCount notice → conflict handoff), and the
 * conflict-dialog state machine (decisions default SKIP, bulk set-all,
 * stateless echo submit body, a FAILED submit keeps the dialog + decisions
 * intact, `staleCount` surfaced distinctly).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  deletePricing,
  fetchLatestPricing,
  getPricing,
  resolvePricingConflicts,
  upsertPricing,
} from '@/daemon/usagePricingAdapter';

import {
  buildResolutions,
  filterEntries,
  initDecisions,
  setAllDecisions,
  setDecision,
  type ConflictAction,
} from './pricingLogic';

import type { PricingConflict, PricingEntry, PricingEntryInput } from '@/daemon/types-usage-pricing';

/** A transient header notice (success / info / the staleCount warning). */
export interface PricingNotice {
  kind: 'success' | 'info' | 'warning' | 'error';
  /** i18n key, interpolated with `params`. */
  messageKey: string;
  params?: Record<string, unknown>;
}

export interface ConflictDialogState {
  conflicts: PricingConflict[];
  decisions: Record<string, ConflictAction>;
  submitting: boolean;
  /** Raw daemon error message of the last failed submit, if any. */
  submitError: string | null;
}

export interface UsePricingResult {
  loading: boolean;
  error: string | null;
  entries: PricingEntry[];
  filtered: PricingEntry[];
  search: string;
  setSearch: (v: string) => void;
  busy: boolean;
  fetching: boolean;
  notice: PricingNotice | null;
  dismissNotice: () => void;
  reload: () => Promise<void>;
  /** Returns true on success (callers close their editor). */
  saveEntry: (input: PricingEntryInput) => Promise<boolean>;
  removeEntry: (providerId: string, modelId: string) => Promise<void>;
  fetchLatest: () => Promise<void>;
  conflictDialog: ConflictDialogState | null;
  setConflictDecision: (key: string, action: ConflictAction) => void;
  setAllConflictDecisions: (action: ConflictAction) => void;
  submitConflicts: () => Promise<void>;
  cancelConflicts: () => void;
}

export function usePricing(): UsePricingResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [notice, setNotice] = useState<PricingNotice | null>(null);
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null);

  /** Re-GET the list. THROWS on failure — mutation paths must not fake success. */
  const refreshList = useCallback(async () => {
    setEntries(await getPricing());
  }, []);

  /** Initial-load / retry-banner path: failures land in the page `error` state. */
  const reload = useCallback(async () => {
    setError(null);
    try {
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setLoading(false);
    }
  }, [refreshList]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => filterEntries(entries, search), [entries, search]);

  const saveEntry = useCallback(
    async (input: PricingEntryInput): Promise<boolean> => {
      setBusy(true);
      setNotice(null);
      try {
        await upsertPricing(input);
      } catch (err) {
        setNotice({
          kind: 'error',
          messageKey: 'pricing.saveFailed',
          params: { message: err instanceof Error ? err.message : 'request failed' },
        });
        setBusy(false);
        return false;
      }
      try {
        // Success (and editor close) ONLY after the list is actually re-read.
        await refreshList();
        setNotice({ kind: 'success', messageKey: 'pricing.saved' });
        return true;
      } catch (err) {
        setNotice({
          kind: 'error',
          messageKey: 'pricing.refreshFailed',
          params: { message: err instanceof Error ? err.message : 'request failed' },
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refreshList],
  );

  const removeEntry = useCallback(
    async (providerId: string, modelId: string) => {
      setBusy(true);
      setNotice(null);
      let deleted: boolean;
      try {
        deleted = await deletePricing(providerId, modelId);
      } catch (err) {
        setNotice({
          kind: 'error',
          messageKey: 'pricing.deleteFailed',
          params: { message: err instanceof Error ? err.message : 'request failed' },
        });
        setBusy(false);
        return;
      }
      try {
        await refreshList();
        // deleted:false = the row was already gone — informational, not an error.
        if (!deleted) setNotice({ kind: 'info', messageKey: 'pricing.alreadyDeleted' });
      } catch (err) {
        setNotice({
          kind: 'error',
          messageKey: 'pricing.refreshFailed',
          params: { message: err instanceof Error ? err.message : 'request failed' },
        });
      } finally {
        setBusy(false);
      }
    },
    [refreshList],
  );

  const fetchLatest = useCallback(async () => {
    setFetching(true);
    setNotice(null);
    let result;
    try {
      result = await fetchLatestPricing();
    } catch (err) {
      // Fetch failure: surface the daemon's message, table untouched.
      setNotice({
        kind: 'error',
        messageKey: 'pricing.fetchFailed',
        params: { message: err instanceof Error ? err.message : 'request failed' },
      });
      setFetching(false);
      return;
    }
    try {
      await refreshList();
      setNotice({
        kind: 'success',
        messageKey: 'pricing.fetchApplied',
        params: { count: result.appliedCount },
      });
    } catch (err) {
      // The fetch DID apply server-side; say the list refresh failed — never fake success.
      setNotice({
        kind: 'error',
        messageKey: 'pricing.refreshFailed',
        params: { message: err instanceof Error ? err.message : 'request failed' },
      });
    } finally {
      setFetching(false);
    }
    // Conflicts are real either way — hand them to the dialog.
    if (result.conflicts.length > 0) {
      setConflictDialog({
        conflicts: result.conflicts,
        decisions: initDecisions(result.conflicts),
        submitting: false,
        submitError: null,
      });
    }
  }, [refreshList]);

  const setConflictDecision = useCallback((key: string, action: ConflictAction) => {
    setConflictDialog((state) =>
      state ? { ...state, decisions: setDecision(state.decisions, key, action) } : state,
    );
  }, []);

  const setAllConflictDecisions = useCallback((action: ConflictAction) => {
    setConflictDialog((state) =>
      state ? { ...state, decisions: setAllDecisions(state.conflicts, action) } : state,
    );
  }, []);

  const submitConflicts = useCallback(async () => {
    let snapshot: ConflictDialogState | null = null;
    setConflictDialog((state) => {
      snapshot = state;
      return state ? { ...state, submitting: true, submitError: null } : state;
    });
    if (!snapshot) return;
    const { conflicts, decisions } = snapshot as ConflictDialogState;
    let result;
    try {
      result = await resolvePricingConflicts(buildResolutions(conflicts, decisions));
    } catch (err) {
      // Resolve FAILED: keep the dialog open with all decisions exactly as the
      // user left them.
      const message = err instanceof Error ? err.message : 'request failed';
      setConflictDialog((state) =>
        state ? { ...state, submitting: false, submitError: message } : state,
      );
      return;
    }
    // The resolution is applied server-side — close the dialog (re-submitting
    // would double-apply / go stale), but only claim success after a real
    // list re-read.
    setConflictDialog(null);
    try {
      await refreshList();
      setNotice(
        result.staleCount > 0
          ? {
              kind: 'warning',
              messageKey: 'pricing.resolvedWithStale',
              params: {
                overwritten: result.overwrittenCount,
                skipped: result.skippedCount,
                stale: result.staleCount,
              },
            }
          : {
              kind: 'success',
              messageKey: 'pricing.resolved',
              params: { overwritten: result.overwrittenCount, skipped: result.skippedCount },
            },
      );
    } catch (err) {
      // Resolution applied but the list re-read failed — never fake success.
      setNotice({
        kind: 'error',
        messageKey: 'pricing.refreshFailed',
        params: { message: err instanceof Error ? err.message : 'request failed' },
      });
    }
  }, [refreshList]);

  const cancelConflicts = useCallback(() => setConflictDialog(null), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    loading,
    error,
    entries,
    filtered,
    search,
    setSearch,
    busy,
    fetching,
    notice,
    dismissNotice,
    reload,
    saveEntry,
    removeEntry,
    fetchLatest,
    conflictDialog,
    setConflictDecision,
    setAllConflictDecisions,
    submitConflicts,
    cancelConflicts,
  };
}
