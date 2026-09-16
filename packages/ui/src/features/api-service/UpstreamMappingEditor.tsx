/**
 * UpstreamMappingEditor — the upstream routing model's per-upstream
 * model-mapping table editor (P3, docs/design/upstream-routing-model.md).
 *
 * The mapping table lives on the UPSTREAM (not the key, not a route): rows are
 * client model name → upstream model id, exact names before `*` wildcards,
 * plus the `default` / `background` role rows (gemini). An EMPTY table means
 * passthrough — the client's model id is forwarded verbatim.
 */

import { Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';

interface MappingRow {
  source: string;
  target: string;
  effort: string;
}

export function UpstreamMappingEditor({
  upstreamKey,
  label,
  onClose,
  onSaved,
}: {
  upstreamKey: string | null;
  label: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useTranslation();
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!upstreamKey) return;
    setError(null);
    let cancelled = false;
    void (async () => {
      const catalog = await agent.apiService.listUpstreams();
      if (cancelled) return;
      const entry = catalog.upstreams.find((item) => item.key === upstreamKey);
      setRows(
        (entry?.mappings ?? []).map((row) => ({
          source: row.source,
          target: row.target,
          effort: row.effort ?? '',
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [upstreamKey]);

  const patch = (index: number, part: Partial<MappingRow>): void => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...part } : row)));
  };

  const handleSave = async (): Promise<void> => {
    if (!upstreamKey) return;
    setSaving(true);
    setError(null);
    try {
      const payload = rows
        .filter((row) => row.source.trim() !== '' && row.target.trim() !== '')
        .map((row) => ({
          source: row.source.trim(),
          target: row.target.trim(),
          ...(row.effort.trim() !== '' ? { effort: row.effort.trim() } : {}),
        }));
      const result = await agent.apiService.setUpstreamMappings(upstreamKey, payload);
      if (!result.success) {
        setError(result.message ?? t('apiService.keys.upstream.mappingSaveFailed'));
        return;
      }
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={upstreamKey !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('apiService.keys.upstream.mappingTitle', { name: label })}</DialogTitle>
          <DialogDescription>{t('apiService.keys.upstream.mappingDesc')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('apiService.keys.upstream.mappingEmpty')}</p>
          ) : null}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                className="h-8 flex-1 text-xs"
                value={row.source}
                placeholder={t('apiService.keys.upstream.mappingSource')}
                onChange={(e) => patch(index, { source: e.target.value })}
              />
              <span className="text-xs text-muted-foreground">→</span>
              <Input
                className="h-8 flex-1 text-xs"
                value={row.target}
                placeholder={t('apiService.keys.upstream.mappingTarget')}
                onChange={(e) => patch(index, { target: e.target.value })}
              />
              <Input
                className="h-8 w-24 text-xs"
                value={row.effort}
                placeholder={t('apiService.keys.upstream.mappingEffort')}
                onChange={(e) => patch(index, { effort: e.target.value })}
              />
              <Button
                variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                aria-label={t('common.delete')}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline" size="sm"
            onClick={() => setRows((current) => [...current, { source: '', target: '', effort: '' }])}
          >
            <Plus className="mr-1 h-3 w-3" />
            {t('apiService.keys.upstream.mappingAdd')}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            {t('apiService.keys.upstream.mappingHint')}
          </p>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={() => void handleSave()} disabled={saving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
