/**
 * UpstreamMappingEditor — the upstream routing model's per-upstream
 * model-mapping table editor (docs/design/upstream-routing-model.md).
 *
 * The mapping table lives on the UPSTREAM (not the key, not a route): rows are
 * client model name → upstream model id, exact names before `*` wildcards,
 * plus the `default` / `background` role rows (gemini). An EMPTY table means
 * passthrough — the client's model id is forwarded verbatim.
 *
 * The table itself is edited with the shared {@link MappingRowsEditor} (the
 * original wide columned design with target suggestions + effort pin); the
 * dialog is deliberately wide (`!max-w-4xl` — wider-than-lg overrides need the
 * `!` prefix because the generated stylesheet orders `max-w-lg` last).
 */

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { agent } from '@/shared/agent';
import { useLlmProvidersData } from '@/shared/state/settingsStore';
import { useTranslation } from '@/shared/state/LocaleContext';

import { mergeSubscriptionModelIds, SUBSCRIPTION_MODEL_CATALOG } from '../api-service/subscriptionModelCatalog';
import { MappingRowsEditor, type MappingDraft } from './MappingRowsEditor';

/** Suggest target model ids for one upstream key: the BYO provider's own
 *  `models` list, or the subscription pool's catalog (antigravity merges the
 *  live discovered ids on top). */
function useUpstreamModelSuggestions(upstreamKey: string | null): string[] {
  const providers = useLlmProvidersData().providers;
  const [antigravityModels, setAntigravityModels] = useState<string[]>([]);
  const isAntigravityPool = upstreamKey === 'sub:antigravity';

  useEffect(() => {
    let cancelled = false;
    setAntigravityModels([]);
    if (!isAntigravityPool) return;
    void agent.accounts.listAntigravityModels()
      .then((result) => {
        if (!cancelled) setAntigravityModels(result.models.map((model) => model.id));
      })
      .catch(() => {
        // Discovery is best-effort: the static catalog still suggests.
      });
    return () => {
      cancelled = true;
    };
  }, [isAntigravityPool]);

  return useMemo(() => {
    if (!upstreamKey) return [];
    if (upstreamKey.startsWith('sub:')) {
      const providerId = upstreamKey.slice(4) as keyof typeof SUBSCRIPTION_MODEL_CATALOG;
      const catalog = SUBSCRIPTION_MODEL_CATALOG[providerId] ?? [];
      return providerId === 'antigravity'
        ? [...new Set([...catalog, ...antigravityModels])]
        : catalog;
    }
    return providers.find((provider) => provider.id === upstreamKey)?.models ?? [];
  }, [antigravityModels, providers, upstreamKey]);
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
  const [rows, setRows] = useState<MappingDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestions = useUpstreamModelSuggestions(upstreamKey);

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

  const handleSave = async (): Promise<void> => {
    if (!upstreamKey) return;
    setSaving(true);
    setError(null);
    try {
      // A HALF-FILLED row (source without target or vice versa) must never be
      // silently dropped: the daemon would store a smaller/empty table while
      // the operator believes their visible rows were saved — the exact
      // "saved but reopen shows nothing" trap. Block the save instead.
      const incomplete = rows.some(
        (row) => (row.source.trim() === '') !== (row.target.trim() === ''),
      );
      if (incomplete) {
        setError(t('apiService.keys.upstream.mappingIncomplete'));
        return;
      }
      const payload = rows
        .filter((row) => row.source.trim() !== '' && row.target.trim() !== '')
        .map((row) => ({
          source: row.source.trim(),
          target: row.target.trim(),
          ...(row.effort && row.effort.trim() !== '' ? { effort: row.effort.trim() } : {}),
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
      <DialogContent className="!max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('apiService.keys.upstream.mappingTitle', { name: label })}</DialogTitle>
          <DialogDescription>{t('apiService.keys.upstream.mappingDesc')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-y-auto pr-1">
          {rows.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{t('apiService.keys.upstream.mappingEmpty')}</p>
          ) : null}
          <MappingRowsEditor
            mappings={rows}
            suggestions={suggestions}
            onChange={setRows}
            listId={upstreamKey ? `upstream-model-suggestions-${upstreamKey}` : undefined}
          />
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">
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
