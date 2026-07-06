/**
 * SupportedModelsEditor — the per-account `supportedModels` control
 * (subscription-account-model-map). A single textarea, one entry per line:
 *  - `model` — an allow-list entry (the account supports this model, no remap).
 *  - `model = actualModel` — an allow-list entry PLUS a logical→actual remap.
 *
 * If NO line has `=`, the value serializes to a CRS ARRAY (allow-list, skip-only).
 * If ANY line has `=`, it serializes to a CRS OBJECT (keys = allow-list, values =
 * the account's actual upstream model; a bare `k` line maps to itself). An empty
 * textarea clears the field (the account supports every model, no remap).
 *
 * Secret-free — model ids are not token material.
 */

import { Save, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

type SupportedModels = string[] | Record<string, string>;

interface SupportedModelsEditorProps {
  value?: SupportedModels;
  busy?: boolean;
  onSave: (value: SupportedModels | undefined) => void;
  onClear: () => void;
}

/** Serialize the stored value to the textarea text (one entry per line). */
function toText(value: SupportedModels | undefined): string {
  if (!value) return '';
  if (Array.isArray(value)) return value.join('\n');
  return Object.entries(value)
    .map(([k, v]) => (v === k ? k : `${k} = ${v}`))
    .join('\n');
}

/** Parse the textarea text into a stored value (or `undefined` to clear). */
function parseText(text: string): SupportedModels | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const hasRemap = lines.some((l) => l.includes('='));
  if (!hasRemap) return lines;
  const map: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx < 0) {
      map[line] = line;
    } else {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key) map[key] = val || key;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

export function SupportedModelsEditor({ value, busy, onSave, onClear }: SupportedModelsEditorProps) {
  const t = useTranslation();
  const initial = useMemo(() => toText(value), [value]);
  const [draft, setDraft] = useState(initial);
  const dirty = draft !== initial;

  return (
    <div className="space-y-1.5">
      <textarea
        className="min-h-[64px] w-full resize-y rounded-md border border-border/60 bg-surface-1/50 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
        value={draft}
        placeholder={t('accounts.detail.supportedModelsPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        disabled={busy}
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">{t('accounts.detail.supportedModelsHint')}</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => onSave(parseText(draft))}
        >
          <Save className="mr-1 h-3.5 w-3.5" />
          {t('common.save')}
        </Button>
        {value ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft('');
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
