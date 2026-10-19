/**
 * UpstreamMappingSection — the per-upstream "model mappings" affordance
 * (upstream routing model): a collapsible row on every upstream resource's
 * detail view (BYO provider page, subscription-pool page). COLLAPSED it shows
 * the row count (0 = passthrough); EXPANDED it lists the rows read-only —
 * checking what a client model maps to never requires opening the editor — and
 * offers the edit dialog. The mapping table lives ON the upstream; this is its
 * home, not a top-level hub.
 */

import { ArrowRight, ChevronDown, ChevronRight, Shuffle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import { UpstreamMappingEditor } from './UpstreamMappingEditor';
import { useUpstreamMappingInfo, type UpstreamMappingRow } from './useUpstreamMappingInfo';

/** One read-only mapping line: client model → upstream model (+ effort pin). */
function MappingPreviewRow({ row }: { row: UpstreamMappingRow }) {
  const t = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-xs">
      <span className="break-all font-mono text-foreground">{row.source}</span>
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="break-all font-mono text-foreground">{row.target}</span>
      {row.effort ? (
        <Badge
          variant="secondary"
          className="ml-auto font-mono text-[10px] normal-case"
          title={t('upstreams.mappings.effort', { level: row.effort })}
        >
          {row.effort}
        </Badge>
      ) : null}
    </div>
  );
}

export function UpstreamMappingSection({
  upstreamKey,
  label,
  autoOpen,
  onAutoOpened,
}: {
  /** The mapping-table key (`providerId` or `sub:<providerId>`). */
  upstreamKey: string;
  /** Display name for the dialog title (defaults to the key). */
  label: string;
  /** Expand + open the editor ONCE on mount (the post-add guidance dialog's
   *  "打开模型映射" landing). */
  autoOpen?: boolean;
  /** Fired when an autoOpen has been consumed (lets the host clear its flag). */
  onAutoOpened?: () => void;
}) {
  const t = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const autoOpenedRef = useRef(false);
  const { mappings, count, force, refresh } = useUpstreamMappingInfo(expanded || editing ? upstreamKey : null);

  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setExpanded(true);
    setEditing(true);
    onAutoOpened?.();
  }, [autoOpen, onAutoOpened]);

  return (
    <div className="border rounded-lg">
      <button
        type="button"
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Shuffle className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('upstreams.mappings.sectionTitle')}</span>
          {count != null && count > 0 ? (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{count}</span>
          ) : null}
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded ? (
        <div className="border-t p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('upstreams.mappings.sectionDescription')}
          </p>
          {mappings == null ? (
            <p className="text-xs text-foreground">{t('upstreams.mappings.loading')}</p>
          ) : mappings.length === 0 ? (
            <p className="text-xs text-foreground">{t('upstreams.mappings.passthrough')}</p>
          ) : (
            <div className="overflow-hidden rounded-md border border-border/70" data-testid="upstream-mapping-preview">
              <div className="divide-y divide-border/60">
                {mappings.map((row, index) => (
                  <MappingPreviewRow key={`${row.source}-${index}`} row={row} />
                ))}
              </div>
              {force === false ? (
                <p className="border-t border-border/60 bg-surface-1/50 px-3 py-1.5 text-[11px] text-muted-foreground">
                  {t('upstreams.mappings.autoHint')}
                </p>
              ) : null}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {t('upstreams.mappings.edit')}
          </Button>
        </div>
      ) : null}

      <UpstreamMappingEditor
        upstreamKey={editing ? upstreamKey : null}
        label={label}
        onClose={() => setEditing(false)}
        onSaved={refresh}
      />
    </div>
  );
}
