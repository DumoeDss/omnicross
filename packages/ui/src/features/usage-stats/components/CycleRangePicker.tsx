/**
 * CycleRangePicker.tsx — the `cycle` range mode's picker: an account select
 * (only when more than one account has cycles) plus a cycle select listing that
 * account's billable cycles newest-first. Pure presentation; selection state
 * lives in `useUsageStats`.
 */

import React from 'react';

import i18n from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

import {
  cycleAccountKey,
  cycleId as makeCycleId,
  formatCycleRangeLabel,
} from '../hooks/usageStatsLogic';

import type { AccountAllowanceCycle } from '@/daemon/types-usage-pricing';

interface CycleRangePickerProps {
  /** Every account's cycles (the daemon returns them newest-first per account). */
  cycles: AccountAllowanceCycle[] | null;
  /** Currently listed account key ('' while nothing is selected). */
  accountKey: string;
  cycleId: string | null;
  loading: boolean;
  error: string | null;
  onAccountChange: (key: string) => void;
  onCycleChange: (id: string) => void;
  onReload: () => void;
}

export function CycleRangePicker({
  cycles,
  accountKey,
  cycleId,
  loading,
  error,
  onAccountChange,
  onCycleChange,
  onReload,
}: CycleRangePickerProps) {
  const t = useTranslation();
  const locale = i18n.language || 'en';

  const accounts = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ key: string; label: string }> = [];
    for (const cycle of cycles ?? []) {
      const key = cycleAccountKey(cycle);
      if (seen.has(key)) continue;
      seen.add(key);
      // Account labels live on the Accounts page's surface; here a provider +
      // short account id keeps the option unambiguous without that coupling.
      out.push({
        key,
        label: `${cycle.providerId} · ${cycle.accountId.slice(0, 8)}`,
      });
    }
    return out;
  }, [cycles]);

  const accountCycles = React.useMemo(
    () => (cycles ?? []).filter((c) => cycleAccountKey(c) === accountKey),
    [cycles, accountKey],
  );

  if (error && !cycles) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{t('usageStats.cyclesUnavailable')}</span>
        <Button size="sm" variant="outline" onClick={onReload}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (loading && !cycles) {
    return <span className="text-xs text-muted-foreground">{t('common.loading')}</span>;
  }

  if (!cycles || cycles.length === 0) {
    return <span className="text-xs text-muted-foreground">{t('usageStats.cyclesEmpty')}</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {accounts.length > 1 ? (
        <Select
          size="sm"
          className="h-7 w-56 text-xs"
          value={accountKey}
          onChange={onAccountChange}
          options={accounts.map((a) => ({ value: a.key, label: a.label }))}
          aria-label={t('usageStats.cycleAccount')}
        />
      ) : null}
      <Select
        size="sm"
        className="h-7 w-64 text-xs"
        value={cycleId ?? ''}
        onChange={onCycleChange}
        disabled={accountCycles.length === 0}
        options={accountCycles.map((c) => ({
          value: makeCycleId(c),
          label: formatCycleRangeLabel(c, locale, t('usageStats.cycleOngoing')),
        }))}
        aria-label={t('usageStats.cycleSelect')}
      />
    </div>
  );
}
