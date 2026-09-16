/**
 * UpstreamMappingsDialog — the upstream routing model's mapping-table hub
 * (docs/design/upstream-routing-model.md): one entry point on the Upstreams
 * page listing every upstream (BYO providers + non-empty subscription pools)
 * with its model-mapping row count, opening the per-upstream editor.
 */

import { ArrowRight, Server, UsersRound } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { UpstreamCatalogEntry } from '@/daemon/types';

import { UpstreamMappingEditor } from '../api-service/UpstreamMappingEditor';

export function UpstreamMappingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [entries, setEntries] = useState<UpstreamCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await agent.apiService.listUpstreams();
      setEntries(result.upstreams ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <>
      <Dialog open={open && editKey === null} onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('upstreams.mappings.title')}</DialogTitle>
            <DialogDescription>{t('upstreams.mappings.description')}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-72">
            <div className="space-y-1.5 pr-2">
              {loading && entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('upstreams.mappings.loading')}</p>
              ) : null}
              {!loading && entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('upstreams.mappings.empty')}</p>
              ) : null}
              {entries.map((entry) => {
                const isPool = entry.target.kind !== 'provider';
                return (
                  <div
                    key={entry.key}
                    className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2"
                  >
                    {isPool
                      ? <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">{entry.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {entry.mappings.length > 0
                          ? t('upstreams.mappings.count', { count: entry.mappings.length })
                          : t('upstreams.mappings.passthrough')}
                      </div>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {isPool
                        ? t('upstreams.mappings.kindSubscription')
                        : t('upstreams.mappings.kindProvider')}
                    </Badge>
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => {
                        setEditKey(entry.key);
                        setEditLabel(entry.label);
                      }}
                    >
                      {t('upstreams.mappings.edit')}
                      <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <UpstreamMappingEditor
        upstreamKey={editKey}
        label={editLabel}
        onClose={() => setEditKey(null)}
        onSaved={() => void load()}
      />
    </>
  );
}
