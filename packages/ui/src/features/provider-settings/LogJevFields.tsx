import { useState } from 'react';
import { parseLogJevSettings, type LogJevSettings } from '@omnicross/contracts/logjev';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useTranslation } from '@/shared/state/LocaleContext';

export function LogJevFields({ value, onChange, onValidity }: {
  value?: LogJevSettings;
  onChange: (value: LogJevSettings) => void;
  onValidity: (valid: boolean) => void;
}) {
  const t = useTranslation();
  const [extra, setExtra] = useState(() => JSON.stringify(value?.extraBody ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  const update = (patch: Partial<LogJevSettings>) => onChange({ kind: 'chat', ...value, ...patch });
  return <fieldset className="space-y-3 rounded border p-3">
    <legend className="px-1 text-sm font-medium">LogJev</legend>
    <label className="block space-y-1 text-sm">
      <span>{t('logjev.mode')}</span>
      <Select value={value?.kind ?? ''} options={[
        ...(!value ? [{ value: '', label: t('logjev.legacy') }] : []),
        { value: 'chat', label: t('logjev.chat') }, { value: 'jev', label: t('logjev.native') },
      ]} onChange={kind => {
        if (kind !== 'chat' && kind !== 'jev') return;
        update({ kind }); setExtra(JSON.stringify(value?.extraBody ?? {}, null, 2));
        setInvalid(false); onValidity(true);
      }} />
    </label>
    <p className="text-xs text-muted-foreground">{t('logjev.endpointNote')}</p>
    {value?.kind !== 'jev' && <>
      <label className="block space-y-1 text-sm">
        <span>{t('logjev.prompt')}</span>
        <Select value={value?.promptMode ?? 'full'} options={[
          { value: 'full', label: t('logjev.full') }, { value: 'minimal', label: t('logjev.minimal') },
        ]} onChange={mode => update({ promptMode: mode === 'minimal' ? 'minimal' : 'full' })} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t('logjev.topk')}</span>
        <Input type="number" min={1} max={100} value={value?.topk ?? 20}
          onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n >= 1 && n <= 100) update({ topk: n }); }} />
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t('logjev.extra')}</span>
        <textarea className="min-h-24 w-full rounded border bg-background p-2 font-mono text-xs" value={extra}
          aria-invalid={invalid} onChange={event => {
            setExtra(event.target.value);
            try {
              const parsed: unknown = JSON.parse(event.target.value);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
              const settings = parseLogJevSettings({ kind: 'chat', ...value, extraBody: parsed });
              onChange(settings);
              setInvalid(false); onValidity(true);
            } catch { setInvalid(true); onValidity(false); }
          }} />
      </label>
      {invalid && <p role="alert" className="text-xs text-red-500">{t('logjev.invalidJson')}</p>}
    </>}
  </fieldset>;
}
