/**
 * UsageStorageSection.tsx — the "Usage data storage" card (Settings → Data).
 *
 * Three operator questions, answered in one place:
 *  - how much disk does the usage store cost right now, split by retention
 *    class (event rows / raw forensic payloads / daily aggregates);
 *  - how many days of detail to keep (`usage.retentionDays`; 0 = keep forever);
 *  - clean the expired detail NOW instead of waiting for the hourly sweep.
 *
 * SAFETY: the manual pass is bounded by the SAVED retention window — it can
 * never delete a day the window keeps, and aggregates are never touched. The
 * button is disabled while the draft differs from the saved value (and at
 * retention 0), so a "clean with 7" click can never silently run with 90.
 *
 * Reads (`GET /admin/api/usage-store`) and the prune are secret-free and go
 * through the adapter directly; the save returns `MutationResult` so failures
 * render inline instead of the page-level banner.
 */

import { Database, RefreshCw, Trash2 } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { MutationResult, UsagePruneResult, UsageStoreInfo } from '@/daemon/types';

interface UsageStorageSectionProps {
  getInfo: () => Promise<UsageStoreInfo | null>;
  onUpdateRetention: (retentionDays: number) => Promise<MutationResult>;
  onPrune: () => Promise<UsagePruneResult>;
}

/** Human-readable byte size (binary units, one decimal above 1 KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

type Notice = { tone: 'ok' | 'error'; text: string };

/** One label/value line inside the footprint box. */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function UsageStorageSection({ getInfo, onUpdateRetention, onPrune }: UsageStorageSectionProps) {
  const t = useTranslation();
  const [info, setInfo] = React.useState<UsageStoreInfo | null>(null);
  const [draft, setDraft] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [pruning, setPruning] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const fresh = await getInfo();
      setInfo(fresh);
      if (fresh) setDraft(String(fresh.retentionDays));
    } finally {
      setLoading(false);
    }
  }, [getInfo]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const parsed = Number.parseInt(draft, 10);
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const savedDays = info?.retentionDays ?? null;
  const dirty = savedDays !== null && valid && parsed !== savedDays;
  // The manual pass always uses the SAVED window — refuse to guess what an
  // unsaved draft means when the deletion is irreversible.
  const canPrune = !saving && !pruning && !dirty && savedDays !== null && savedDays > 0;

  const save = async (): Promise<void> => {
    if (!valid) {
      setNotice({ tone: 'error', text: t('settings.usageStorage.invalid') });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await onUpdateRetention(parsed);
      if (!result.success) {
        setNotice({ tone: 'error', text: result.message ?? t('settings.usageStorage.saveFailed') });
        return;
      }
      await load();
      setNotice({ tone: 'ok', text: t('settings.usageStorage.saved') });
    } finally {
      setSaving(false);
    }
  };

  const runPrune = async (): Promise<void> => {
    setPruning(true);
    setNotice(null);
    try {
      const result = await onPrune();
      await load();
      setNotice({
        tone: 'ok',
        text: t('settings.usageStorage.prune.result', {
          days: String(result.removedDays),
          freed: formatBytes(result.freedBytes),
        }),
      });
    } catch {
      setNotice({ tone: 'error', text: t('settings.usageStorage.prune.failed') });
    } finally {
      setPruning(false);
    }
  };

  const stats = info?.stats;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-foreground">{t('settings.usageStorage.title')}</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || saving || pruning}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          {t('settings.usageStorage.refresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.usageStorage.description')}</p>

      {loading && !info ? (
        <p className="text-xs text-muted-foreground">{t('settings.usageStorage.size.refreshing')}</p>
      ) : !info || !stats ? (
        <p className="text-xs text-destructive">{t('settings.usageStorage.loadError')}</p>
      ) : (
        <div className="space-y-1.5 rounded-md border border-border/60 bg-surface-0/60 px-3 py-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-foreground">
              {t('settings.usageStorage.size.total')}
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {formatBytes(stats.totalBytes)}
            </span>
          </div>
          <p className="text-xs text-text-muted">
            {stats.days > 0
              ? t('settings.usageStorage.size.coverage', {
                  days: String(stats.days),
                  oldest: stats.oldestDay ?? '—',
                  newest: stats.newestDay ?? '—',
                })
              : t('settings.usageStorage.size.empty')}
          </p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 pt-1 sm:grid-cols-3">
            <StatRow label={t('settings.usageStorage.size.detail')} value={formatBytes(stats.shardBytes)} />
            <StatRow label={t('settings.usageStorage.size.raw')} value={formatBytes(stats.rawBytes)} />
            <StatRow label={t('settings.usageStorage.size.rollup')} value={formatBytes(stats.rollupBytes)} />
          </div>
        </div>
      )}

      <SettingRow
        label={t('settings.usageStorage.retention.label')}
        description={t('settings.usageStorage.retention.description')}
      >
        <Input
          type="number"
          min={0}
          step={1}
          className="w-32"
          value={draft}
          disabled={loading || saving || pruning || !info}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={t('settings.usageStorage.retention.label')}
        />
      </SettingRow>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={loading || saving || pruning || !valid} onClick={() => void save()}>
          {t('settings.usageStorage.save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canPrune}
          onClick={() => void runPrune()}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t('settings.usageStorage.prune.label')}
        </Button>
      </div>
      <p className={`text-[11px] ${notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
        {notice?.text ??
          (dirty
            ? t('settings.usageStorage.prune.requiresSave')
            : savedDays === 0
              ? t('settings.usageStorage.prune.keepForever')
              : t('settings.usageStorage.prune.description'))}
      </p>
    </section>
  );
}

export default UsageStorageSection;
