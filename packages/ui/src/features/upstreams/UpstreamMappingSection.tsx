/**
 * UpstreamMappingSection — the per-upstream "model mappings" affordance
 * (upstream routing model): a collapsible row on every upstream resource's
 * detail view (BYO provider page, subscription-pool page) showing the current
 * mapping row count (0 = passthrough) and opening the shared
 * {@link UpstreamMappingEditor} dialog. The mapping table lives ON the
 * upstream — this is its home, not a top-level hub.
 */

import { ChevronDown, ChevronRight, Shuffle } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

import { UpstreamMappingEditor } from './UpstreamMappingEditor';
import { useUpstreamMappingInfo } from './useUpstreamMappingInfo';

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
  const { count, refresh } = useUpstreamMappingInfo(expanded || editing ? upstreamKey : null);

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
          <p className="text-xs text-foreground">
            {count == null
              ? t('upstreams.mappings.loading')
              : count > 0
                ? t('upstreams.mappings.count', { count })
                : t('upstreams.mappings.passthrough')}
          </p>
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
