/**
 * MappingRowsEditor — the shared model-mapping TABLE editor used by both the
 * legacy downstream-route form (`DownstreamRoutesWorkspace`) and the upstream
 * routing model's per-upstream mapping dialog (`UpstreamMappingEditor`).
 *
 * Rows are client model name → upstream model id, exact names before `*`
 * wildcards, plus the `default` / `background` role rows (gemini). Wide
 * columned grid + datalist suggestions + a checkbox-gated effort pin; this is
 * the original route-editor design, kept as the one mapping editor.
 */

import { lookupCanonicalCapabilities } from '@omnicross/contracts/canonical-models';

import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { GatewayModelMapping, MappingEffortLevel } from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

export interface MappingDraft {
  source: string;
  target: string;
  /** Pinned thinking-level default; `undefined` = unchecked (client/negotiation decides). */
  effort?: MappingEffortLevel;
}

/** The shared seven-level domain, in canonical order. */
const EFFORT_LEVELS: readonly string[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

/**
 * Effort suggestions for one mapping row: the target model's canonical
 * thinking levels when the registry knows it (prevents picking a level the
 * upstream rejects), the full shared domain for unknown ids (the preset may
 * simply lag). Never exhaustive — the input accepts any custom level.
 */
function effortSuggestionsForTarget(target: string): readonly string[] {
  const levels = target.trim()
    ? lookupCanonicalCapabilities(target)?.thinkingLevels
    : undefined;
  return levels?.length ? levels : EFFORT_LEVELS;
}

export function MappingRowsEditor({
  mappings,
  suggestions,
  onChange,
  listId,
}: {
  mappings: MappingDraft[];
  /** Upstream model-id suggestions offered on the target column. */
  suggestions: string[];
  onChange: (mappings: MappingDraft[]) => void;
  /** Datalist id for the target column (defaults to a local id). */
  listId?: string;
}) {
  const t = useTranslation();
  const targetListId = listId ?? 'mapping-model-suggestions';
  const patch = (index: number, next: Partial<GatewayModelMapping>) => {
    onChange(mappings.map((mapping, itemIndex) => itemIndex === index ? { ...mapping, ...next } : mapping));
  };
  return (
    <div className="mt-3 space-y-2">
      <datalist id={targetListId}>{suggestions.map((model) => <option key={model} value={model} />)}</datalist>
      <div className="hidden grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_172px_32px] gap-2 px-1 font-mono text-[9px] uppercase text-muted-foreground sm:grid">
        <span>{t('upstreams.downstreams.mapping.source')}</span><span />
        <span>{t('upstreams.downstreams.mapping.target')}</span>
        <span className="text-center">{t('upstreams.downstreams.mapping.effort')}</span><span />
      </div>
      {mappings.map((mapping, index) => {
        // Preset-aware suggestions: the target model's canonical thinking
        // levels when the registry knows it, the full shared domain otherwise.
        // Free text stays allowed — a level our presets don't know yet rides
        // same-format wires upstream verbatim.
        const levels = effortSuggestionsForTarget(mapping.target);
        // Known target ⇒ its highest supported level; unknown ⇒ the safe 'high'.
        const defaultEffort = levels === EFFORT_LEVELS ? 'high' : levels[levels.length - 1];
        const effortListId = `mapping-effort-suggestions-${targetListId}-${index}`;
        return (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_172px_32px] items-center gap-2">
            <Input value={mapping.source} placeholder="claude-sonnet-*" onChange={(event) => patch(index, { source: event.target.value })} />
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            <Input list={targetListId} value={mapping.target} placeholder="glm-4.7" onChange={(event) => patch(index, { target: event.target.value })} />
            <div className="flex items-center justify-end gap-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0 accent-primary"
                checked={mapping.effort !== undefined}
                onChange={(event) => patch(index, { effort: event.target.checked ? defaultEffort : undefined })}
                aria-label={t('upstreams.downstreams.mapping.effort')}
              />
              <Input
                className="h-8 w-[132px] font-mono text-xs"
                list={effortListId}
                disabled={mapping.effort === undefined}
                value={mapping.effort ?? ''}
                placeholder={defaultEffort}
                onChange={(event) => patch(index, { effort: event.target.value.trim() || undefined })}
              />
              <datalist id={effortListId}>{levels.map((level) => <option key={level} value={level} />)}</datalist>
            </div>
            <Button size="icon" variant="ghost" onClick={() => onChange(mappings.filter((_, itemIndex) => itemIndex !== index))} aria-label={t('common.delete')}>
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        );
      })}
      <p className="px-1 text-[10px] leading-4 text-muted-foreground">
        {t('upstreams.downstreams.mapping.effortHint')}
      </p>
      <Button size="sm" variant="outline" onClick={() => onChange([...mappings, { source: '', target: '' }])}>
        <Plus className="h-3.5 w-3.5" />{t('upstreams.downstreams.mapping.add')}
      </Button>
    </div>
  );
}
