/**
 * DateRangePicker.tsx — preset chips (today / 7d / 30d / custom) plus a pair
 * of native date inputs shown only for the custom preset. Pure presentation;
 * range state lives in `useUsageStats`.
 */

import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { RangePreset } from '../hooks/usageStatsLogic';

interface DateRangePickerProps {
  preset: RangePreset;
  customFrom: string;
  customTo: string;
  onPresetChange: (preset: RangePreset) => void;
  onCustomFromChange: (v: string) => void;
  onCustomToChange: (v: string) => void;
}

const PRESETS: Array<{ id: RangePreset; labelKey: string }> = [
  { id: 'today', labelKey: 'usageStats.rangeToday' },
  { id: '7d', labelKey: 'usageStats.range7d' },
  { id: '30d', labelKey: 'usageStats.range30d' },
  { id: 'custom', labelKey: 'usageStats.rangeCustom' },
];

export function DateRangePicker({
  preset,
  customFrom,
  customTo,
  onPresetChange,
  onCustomFromChange,
  onCustomToChange,
}: DateRangePickerProps) {
  const t = useTranslation();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={preset === p.id ? 'default' : 'secondary'}
            onClick={() => onPresetChange(p.id)}
          >
            {t(p.labelKey)}
          </Button>
        ))}
      </div>
      {preset === 'custom' ? (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            aria-label={t('usageStats.from')}
            value={customFrom}
            onChange={(e) => onCustomFromChange(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">→</span>
          <Input
            type="date"
            className="h-7 w-36 text-xs"
            aria-label={t('usageStats.to')}
            value={customTo}
            onChange={(e) => onCustomToChange(e.target.value)}
          />
        </div>
      ) : null}
    </div>
  );
}
