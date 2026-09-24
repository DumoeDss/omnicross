/**
 * LogJevFields — the LogJev decision-backend configuration.
 *
 * Chat mode is SELECTOR-shaped: instead of re-entering an API key / URL on
 * this row, pick an ALREADY configured provider (模型服务) plus one of its
 * models — the daemon resolves that row's credentials at call time
 * (`logjev.upstream`). The PROBE button issues one minimal completion with
 * the reader's exact logprobs parameters and reports whether the selected
 * provider+model actually returns top_logprobs (a model without logprobs
 * evidence cannot serve LogJev readings).
 *
 * Legacy rows (own key/url) keep working: the empty upstream option means
 * "use this row's own configuration". Native `jev` mode is unchanged.
 */
import { Activity } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseLogJevSettings, type LogJevSettings, type LogJevUpstream } from '@omnicross/contracts/logjev';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { agent } from '@/shared/agent';
import { useTranslation } from '@/shared/state/LocaleContext';
import { useLlmProvidersData } from '@/shared/state/settingsStore';

import type { LLMProvider } from '@shared/llm-config';

/** Selector value for the opencodego account-pool option. */
const OC_POOL_VALUE = 'account-pool:opencodego';

/** Candidates for the upstream selector: enabled OpenAI-wire chat providers. */
function selectableUpstreamProviders(providers: readonly LLMProvider[]): LLMProvider[] {
  return providers.filter(
    (p) => p.enabled !== false && p.category !== 'other' && (p.apiFormat || 'openai') === 'openai',
  );
}

function providerModelIds(provider: LLMProvider | undefined): string[] {
  if (!provider) return [];
  if (provider.modelConfigs?.length) return provider.modelConfigs.map((m) => m.id);
  return provider.models ?? [];
}

export function LogJevFields({ value, onChange, onValidity }: {
  value?: LogJevSettings;
  onChange: (value: LogJevSettings) => void;
  onValidity: (valid: boolean) => void;
}) {
  const t = useTranslation();
  const { providers } = useLlmProvidersData();
  const accountsApi = useAccounts();
  const [extra, setExtra] = useState(() => JSON.stringify(value?.extraBody ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);
  // Probe state for the CURRENT upstream selection.
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<
    { supported: boolean; message?: string; latencyMs?: number } | null
  >(null);
  // Live model list for the opencodego account-pool option (fetched on select).
  const [ocModels, setOcModels] = useState<string[] | null>(null);
  const [ocModelsLoading, setOcModelsLoading] = useState(false);
  const update = (patch: Partial<LogJevSettings>) => onChange({ kind: 'chat', ...value, ...patch });

  const upstream = value?.upstream;
  const isOcPool = upstream?.kind === 'account-pool';
  const ocAccounts = accountsApi.data.providerAccounts.opencodego ?? [];
  const upstreamProviders = useMemo(() => selectableUpstreamProviders(providers), [providers]);
  const selectedUpstream = !isOcPool ? upstreamProviders.find((p) => p.id === upstream?.id) : undefined;
  const modelIds = useMemo(
    () => (isOcPool ? ocModels ?? [] : providerModelIds(selectedUpstream)),
    [isOcPool, ocModels, selectedUpstream],
  );
  const probeReady = Boolean(upstream && upstream.model);
  const selectorValue = isOcPool ? OC_POOL_VALUE : upstream?.id ?? '';

  const setUpstreamProvider = (id: string) => {
    setProbeResult(null);
    setOcModels(null);
    if (!id) {
      update({ upstream: undefined });
      return;
    }
    if (id === OC_POOL_VALUE) {
      update({ upstream: { kind: 'account-pool', providerId: 'opencodego', model: '' } });
      // Pull the pool's live model list to offer a dropdown (fallback: free
      // input when the fetch fails or returns nothing).
      setOcModelsLoading(true);
      void agent.accounts.listOpenCodeGoModels().then((result) => {
        setOcModelsLoading(false);
        setOcModels(result.models);
      });
      return;
    }
    const target = upstreamProviders.find((p) => p.id === id);
    const firstModel = providerModelIds(target)[0] ?? '';
    update({ upstream: { kind: 'provider', id, model: firstModel } });
  };

  const setUpstreamModel = (model: string) => {
    setProbeResult(null);
    if (!upstream) return;
    const next: LogJevUpstream = isOcPool
      ? { kind: 'account-pool', providerId: 'opencodego', model }
      : { kind: 'provider', id: upstream.id, model };
    update({ upstream: next });
  };

  const runProbe = async () => {
    if (!upstream?.model) return;
    setProbing(true);
    setProbeResult(null);
    const result = await agent.llmConfig.probeLogJev({
      kind: isOcPool ? 'account-pool' : 'provider',
      id: isOcPool ? 'opencodego' : (upstream as { id: string }).id,
      model: upstream.model,
    });
    setProbing(false);
    setProbeResult({ supported: result.supported, message: result.message, latencyMs: result.latencyMs });
  };

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
    {value?.kind !== 'jev' && <>
      {/* Upstream selector — reuse an already-configured provider instead of
          storing a second key/url on this row. */}
      <label className="block space-y-1 text-sm">
        <span>{t('logjev.upstream')}</span>
        <Select
          value={selectorValue}
          options={[
            { value: '', label: t('logjev.upstreamSelf') },
            ...upstreamProviders.map((p) => ({
              value: p.id,
              label: p.name || p.id,
            })),
            // The opencodego ACCOUNT pool (zen half serves the OpenAI chat
            // wire) — only offered when at least one account exists.
            ...(ocAccounts.length > 0
              ? [{ value: OC_POOL_VALUE, label: `${t('accounts.provider.opencodego.title')} · ${t('upstreams.kind.account-pool')}` }]
              : []),
          ]}
          onChange={setUpstreamProvider}
        />
      </label>
      {upstream ? <>
        <label className="block space-y-1 text-sm">
          <span>{t('logjev.upstreamModel')}</span>
          {modelIds.length > 0 ? (
            <Select
              value={upstream.model && modelIds.includes(upstream.model) ? upstream.model : ''}
              options={[
                ...(upstream.model && !modelIds.includes(upstream.model)
                  ? [{ value: upstream.model, label: upstream.model }]
                  : []),
                ...modelIds.map((id) => ({ value: id, label: id })),
              ]}
              onChange={setUpstreamModel}
            />
          ) : (
            /* A provider with an empty model list, or the account pool while
               its live list is loading / unavailable: free-form model entry. */
            <Input
              value={upstream.model}
              placeholder={ocModelsLoading ? t('common.loading') : t('logjev.upstreamModelPlaceholder')}
              onChange={(event) => setUpstreamModel(event.target.value)}
              spellCheck={false}
            />
          )}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!probeReady || probing} onClick={() => void runProbe()}>
            <Activity className={probing ? 'mr-1 h-3.5 w-3.5 animate-pulse' : 'mr-1 h-3.5 w-3.5'} />
            {t('logjev.probe')}
          </Button>
          {probeResult ? (
            <span
              role="status"
              className={
                probeResult.supported
                  ? 'text-xs text-emerald-600 dark:text-emerald-500'
                  : 'text-xs text-destructive'
              }
            >
              {probeResult.supported
                ? t('logjev.probeSupported', { latency: probeResult.latencyMs ?? 0 })
                : t('logjev.probeUnsupported')}
              {probeResult.message ? ` — ${probeResult.message}` : ''}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{t('logjev.upstreamNote')}</p>
      </> : (
        <p className="text-xs text-muted-foreground">{t('logjev.endpointNote')}</p>
      )}
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
