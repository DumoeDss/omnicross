/**
 * SupportedModelsEditor — the per-account `supportedModels` control
 * (subscription-account-model-map), rendered as a MODEL LIST in the provider
 * settings idiom (checkbox rows in a bordered container + an add box) instead
 * of the old raw textarea.
 *
 *  - codex / claudecode / kimi / grok / copilot / antigravity: the candidate
 *    rows come from the preset catalog (`SUBSCRIPTION_MODEL_CATALOG`).
 *  - opencodego: no preset — the "fetch" button pulls the live zen-half
 *    `/v1/models` list through the daemon (`listOpenCodeGoModels`).
 *  - any row can carry a logical→actual remap (`model = actual`): the row's
 *    remap affordance opens an inline "actual model" input.
 *
 * Serialization keeps the stored shapes: NO remap anywhere ⇒ ARRAY
 * (allow-list, skip-only); ANY remap ⇒ OBJECT (keys = allow-list, values =
 * the account's actual upstream model). Nothing selected ⇒ `undefined` (the
 * account supports every model, no remap).
 *
 * Secret-free — model ids are not token material.
 */

import { ArrowRightLeft, Plus, RefreshCw, Save, X } from 'lucide-react';
import React, { useEffect, useRef, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SUBSCRIPTION_MODEL_CATALOG } from '@/features/api-service/subscriptionModelCatalog';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import type { SubscriptionProviderId } from '@/daemon/types';
import { cn } from '@/shared/utils/utils';

type SupportedModels = string[] | Record<string, string>;

/** One draft row: the logical model id + its actual upstream model (remap). */
interface ModelRow {
  id: string;
  actual: string;
  /** Whether the account serves this model (unchecked rows are candidates). */
  selected: boolean;
}

interface SupportedModelsEditorProps {
  providerId: SubscriptionProviderId;
  /** The account whose key the opencodego live fetch authenticates with. */
  accountId?: string;
  value?: SupportedModels;
  busy?: boolean;
  onSave: (value: SupportedModels | undefined) => void;
  onClear: () => void;
}

/**
 * Build the draft rows: the STORED entries first (selected, remaps kept),
 * then the candidate ids (preset catalog / fetched list) appended unchecked.
 */
function buildRows(
  value: SupportedModels | undefined,
  candidateIds: readonly string[],
): ModelRow[] {
  const rows = toRows(value);
  const known = new Set(rows.map((row) => row.id));
  for (const id of candidateIds) {
    if (known.has(id)) continue;
    rows.push({ id, actual: id, selected: false });
  }
  return rows;
}

/** Flatten the stored value to draft rows (array → identity rows). */
function toRows(value: SupportedModels | undefined): ModelRow[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((id) => ({ id, actual: id, selected: true }));
  return Object.entries(value).map(([id, actual]) => ({ id, actual, selected: true }));
}

/** Serialize draft rows back to the stored shape (see the file header). */
function serialize(rows: readonly ModelRow[]): SupportedModels | undefined {
  const selected = rows.filter((row) => row.selected);
  if (selected.length === 0) return undefined;
  const hasRemap = selected.some((row) => row.actual !== row.id);
  if (!hasRemap) return selected.map((row) => row.id);
  const map: Record<string, string> = {};
  for (const row of selected) map[row.id] = row.actual || row.id;
  return map;
}

/** Parse the add-box text: `model` or `model = actual`. */
function parseAddInput(text: string): { id: string; actual: string } | null {
  const idx = text.indexOf('=');
  if (idx < 0) {
    const id = text.trim();
    return id.length > 0 ? { id, actual: id } : null;
  }
  const id = text.slice(0, idx).trim();
  const actual = text.slice(idx + 1).trim();
  return id.length > 0 ? { id, actual: actual || id } : null;
}

export function SupportedModelsEditor({
  providerId,
  accountId,
  value,
  busy,
  onSave,
  onClear,
}: SupportedModelsEditorProps) {
  const t = useTranslation();
  const presetIds = SUBSCRIPTION_MODEL_CATALOG[providerId] ?? [];
  const isOpencodego = providerId === 'opencodego';
  const initial = useMemo(() => buildRows(value, presetIds), [value, providerId, presetIds]);
  const [rows, setRows] = useState<ModelRow[]>(initial);
  const [addDraft, setAddDraft] = useState('');
  // Rows whose remap input is open (ids). A remap survives toggle-off only in
  // the draft while the row exists; the user sees the `→ actual` indicator.
  const [remapOpen, setRemapOpen] = useState<Set<string>>(() => new Set());
  // opencodego live discovery state.
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(serialize(rows)) !== JSON.stringify(value ?? null),
    [rows, value],
  );

  const fetchModels = async () => {
    setFetching(true);
    setFetchError(null);
    const result = await agent.accounts.listOpenCodeGoModels(accountId);
    setFetching(false);
    if (result.error || result.models.length === 0) {
      setFetchError(result.error ?? t('accounts.detail.modelListEmpty'));
      return;
    }
    // Merge fetched ids into the candidate rows — never drops a selection.
    setRows((prev) => {
      const known = new Set(prev.map((row) => row.id));
      const additions = result.models
        .filter((id) => !known.has(id))
        .map<ModelRow>((id) => ({ id, actual: id, selected: false }));
      return [...prev, ...additions];
    });
  };

  // opencodego first-open convenience: a stored-empty list auto-fetches the
  // live catalog once (the section renders collapsed, so this fires on expand;
  // an account with saved models keeps its rows until the user hits fetch).
  const autoFetched = useRef(false);
  useEffect(() => {
    if (!isOpencodego || autoFetched.current || busy) return;
    if (rows.some((row) => row.selected)) return;
    autoFetched.current = true;
    void fetchModels();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpencodego]);

  const toggleRow = (id: string) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, selected: !row.selected } : row)));
  };

  const setActual = (id: string, actual: string) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, actual } : row)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setRemapOpen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addModel = () => {
    const parsed = parseAddInput(addDraft);
    if (!parsed) return;
    setRows((prev) => (prev.some((row) => row.id === parsed.id)
      ? prev.map((row) => (row.id === parsed.id ? { ...parsed, selected: true } : row))
      : [...prev, { ...parsed, selected: true }]));
    if (parsed.actual !== parsed.id) {
      setRemapOpen((prev) => new Set(prev).add(parsed.id));
    }
    setAddDraft('');
  };

  const toggleRemapOpen = (id: string) => {
    setRemapOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCount = rows.filter((row) => row.selected).length;

  return (
    <div className="space-y-2">
      {/* Add box (+ the opencodego live-fetch button) */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          density="compact"
          className="min-w-[180px] flex-1"
          value={addDraft}
          placeholder={t('accounts.detail.modelListAddPlaceholder')}
          onChange={(e) => setAddDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addModel();
            }
          }}
          disabled={busy}
          spellCheck={false}
        />
        <Button size="sm" variant="outline" disabled={busy || addDraft.trim().length === 0} onClick={addModel}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('accounts.detail.modelListAdd')}
        </Button>
        {isOpencodego ? (
          <Button size="sm" variant="outline" disabled={busy || fetching} onClick={() => void fetchModels()}>
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', fetching && 'animate-spin')} />
            {t('accounts.detail.modelListFetch')}
          </Button>
        ) : null}
      </div>

      {fetchError ? (
        <p className="text-xs text-destructive">
          {t('accounts.detail.modelListFetchFailed', { error: fetchError })}
        </p>
      ) : null}

      {/* The model list — provider-settings idiom: bordered container, divide-y rows. */}
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
          {t('accounts.detail.modelListEmpty')}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border/60">
          <div className="divide-y divide-border/40">
            {rows.map((row) => {
              const remapped = row.actual !== row.id;
              const open = remapOpen.has(row.id);
              return (
                <div key={row.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                      checked={row.selected}
                      disabled={busy}
                      onChange={() => toggleRow(row.id)}
                      aria-label={row.id}
                    />
                    <span className={cn(
                      'min-w-0 flex-1 truncate font-mono text-xs',
                      row.selected ? 'text-foreground' : 'text-muted-foreground',
                    )}>
                      {row.id}
                      {remapped ? <span className="text-muted-foreground"> → {row.actual}</span> : null}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      disabled={busy || !row.selected}
                      title={t('accounts.detail.modelListRemap')}
                      onClick={() => toggleRemapOpen(row.id)}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      disabled={busy}
                      title={t('accounts.detail.modelListRemove')}
                      onClick={() => removeRow(row.id)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {open ? (
                    <div className="mt-1.5 flex items-center gap-2 pl-6">
                      <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <Input
                        density="compact"
                        className="h-7 flex-1 font-mono text-xs"
                        value={row.actual === row.id ? '' : row.actual}
                        placeholder={t('accounts.detail.modelListRemapPlaceholder')}
                        onChange={(e) => setActual(row.id, e.target.value)}
                        disabled={busy}
                        spellCheck={false}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t('accounts.detail.modelListHint', { count: selectedCount })}
      </p>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => onSave(serialize(rows))}>
          <Save className="mr-1 h-3.5 w-3.5" />
          {t('common.save')}
        </Button>
        {value ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setRows([]);
              setFetchError(null);
              onClear();
            }}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {t('accounts.detail.supportedModelsClear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
