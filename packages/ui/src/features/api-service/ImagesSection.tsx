import {
  ArrowRight,
  CloudOff,
  Gauge,
  HardDrive,
  Image,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import React from 'react';

import { Badge } from '@/components/ui/badge';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type {
  ImagesCapabilityStatus,
  ImagesServerConfig,
  OutboundApiServerStatus,
  SubscriptionAccountSanitized,
} from '@/daemon/types';
import { useTranslation } from '@/shared/state/LocaleContext';

interface ImagesSectionProps {
  config: ImagesServerConfig | undefined;
  capability: ImagesCapabilityStatus | null;
  status: OutboundApiServerStatus | null;
  accounts: SubscriptionAccountSanitized[];
  busy: boolean;
  onUpdate: (config: ImagesServerConfig) => Promise<void>;
}

const FEATURE_KEYS = [
  'generate',
  'edit',
  'maskEdit',
  'streaming',
  'transparentBackground',
  'responsesTool',
] as const;

export function imageAccountSelection(config: ImagesServerConfig): string {
  if (config.account.id) return `account:${config.account.id}`;
  if (config.account.group) return `group:${config.account.group}`;
  return 'pool';
}

export function applyImageAccountSelection(
  config: ImagesServerConfig,
  selection: string,
): ImagesServerConfig {
  const account = selection.startsWith('account:')
    ? { id: selection.slice('account:'.length), fallback: config.account.fallback }
    : selection.startsWith('group:')
      ? { group: selection.slice('group:'.length), fallback: config.account.fallback }
      : { fallback: config.account.fallback };
  return { ...config, account };
}

export function formatImageBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.floor(safe)} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KiB`;
  return `${(safe / (1024 * 1024)).toFixed(1)} MiB`;
}

function Utilization({ label, used, max }: { label: string; used: number; max: number }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">{used} / {max}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function StatusTrack({
  configured,
  capability,
}: {
  configured: boolean;
  capability: ImagesCapabilityStatus | null;
}) {
  const t = useTranslation();
  const effective = capability?.effective.available === true;
  const reason = capability?.effective.reason;
  return (
    <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
      <div className="rounded-lg border border-border/70 bg-surface-0 px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t('apiService.images.track.configured')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          {configured
            ? <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            : <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
          <span className="text-sm font-semibold text-foreground">
            {configured ? t('apiService.images.track.on') : t('apiService.images.track.off')}
          </span>
        </div>
      </div>
      <div className="hidden items-center text-muted-foreground sm:flex" aria-hidden="true">
        <ArrowRight className="h-4 w-4" />
      </div>
      <div className="rounded-lg border border-border/70 bg-surface-0 px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t('apiService.images.track.effective')}
        </p>
        <div className="mt-2 flex items-center gap-2">
          {effective
            ? <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
            : <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />}
          <span className="text-sm font-semibold text-foreground">
            {effective
              ? t('apiService.images.track.available')
              : t('apiService.images.track.unavailable')}
          </span>
        </div>
        {!effective ? (
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={reason ?? undefined}>
            {reason ?? t('apiService.images.track.unknown')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ImagesSection({
  config,
  capability,
  status,
  accounts,
  busy,
  onUpdate,
}: ImagesSectionProps) {
  const t = useTranslation();
  if (!config) {
    return (
      <section className="rounded-xl border border-dashed border-border/70 p-4">
        <p className="text-sm font-semibold text-foreground">{t('apiService.images.title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('apiService.images.unsupportedDaemon')}</p>
      </section>
    );
  }

  const groups = [...new Set(accounts.map((account) => account.group).filter(Boolean))];
  const accountOptions: SelectOption[] = [
    { value: 'pool', label: t('apiService.images.account.pool') },
    ...groups.map((group) => ({
      value: `group:${group}`,
      label: t('apiService.images.account.group', { group }),
    })),
    ...accounts.map((account, index) => ({
      value: `account:${account.id}`,
      label: account.label || t('apiService.images.account.account', { number: index + 1 }),
      disabled: !account.enabled || !account.schedulable,
    })),
  ];
  const resources = capability?.runtime.resources ?? status?.imageRuntime?.resources;
  const features = capability?.effective.features;
  const endpoints = capability?.endpoints ?? status?.images ?? null;
  const evidence = capability?.effective.evidence;

  return (
    <section className="rounded-xl border border-border/70 bg-surface-1/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Image className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t('apiService.images.title')}</h3>
              <Badge variant="outline">{config.defaultModel}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('apiService.images.description')}</p>
          </div>
        </div>
        <Switch
          checked={config.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => void onUpdate({ ...config, enabled })}
          aria-label={t('apiService.images.enable')}
        />
      </div>

      <div className="mt-4">
        <StatusTrack configured={config.enabled} capability={capability} />
        <p className="mt-2 text-[11px] text-muted-foreground">{t('apiService.images.entitlementWarning')}</p>
      </div>

      <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs">
          <span className="font-medium text-foreground">{t('apiService.images.account.label')}</span>
          <Select
            className="w-full"
            size="sm"
            value={imageAccountSelection(config)}
            options={accountOptions}
            disabled={busy}
            onChange={(selection) => void onUpdate(applyImageAccountSelection(config, selection))}
          />
        </label>
        <label className="space-y-1.5 text-xs">
          <span className="font-medium text-foreground">{t('apiService.images.account.fallback')}</span>
          <Select
            className="w-full"
            size="sm"
            value={config.account.fallback}
            options={[
              { value: 'strict', label: t('apiService.images.account.strict') },
              { value: 'pool', label: t('apiService.images.account.poolFallback') },
            ]}
            disabled={busy}
            onChange={(fallback) => void onUpdate({
              ...config,
              account: { ...config.account, fallback: fallback as 'strict' | 'pool' },
            })}
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-surface-0/70 p-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" aria-hidden="true" />
            <h4 className="text-xs font-semibold text-foreground">{t('apiService.images.features.title')}</h4>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {FEATURE_KEYS.map((feature) => (
              <div key={feature} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-muted-foreground">{t(`apiService.images.features.${feature}`)}</span>
                <Badge variant={features?.[feature] ? 'success' : 'secondary'}>
                  {features?.[feature]
                    ? t('apiService.images.features.supported')
                    : t('apiService.images.features.unsupported')}
                </Badge>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            {evidence
              ? t('apiService.images.evidence', { age: Math.floor(evidence.ageMs / 1000) })
              : t('apiService.images.noEvidence')}
          </p>
        </div>

        <div className="rounded-lg border border-border/60 bg-surface-0/70 p-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-primary" aria-hidden="true" />
            <h4 className="text-xs font-semibold text-foreground">{t('apiService.images.resources.title')}</h4>
          </div>
          {resources ? (
            <div className="mt-3 space-y-3">
              <Utilization
                label={t('apiService.images.resources.queue')}
                used={resources.queue.activeJobs + resources.queue.waitingJobs}
                max={resources.queue.maxQueuedJobs + resources.queue.maxConcurrentJobsPerAccount}
              />
              <Utilization
                label={t('apiService.images.resources.temporary')}
                used={resources.temporary.totalBytes}
                max={resources.temporary.maxTotalBytes}
              />
              <Utilization
                label={t('apiService.images.resources.references')}
                used={resources.storage.referenceBytes}
                max={resources.storage.maxReferenceBytes}
              />
              <p className="text-[10px] text-muted-foreground">
                {t('apiService.images.resources.bytes', {
                  temporary: formatImageBytes(resources.temporary.totalBytes),
                  references: formatImageBytes(resources.storage.referenceBytes),
                })}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">{t('apiService.images.resources.unavailable')}</p>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">
            {config.remote.enabled
              ? t('apiService.images.remote.enabledWarning')
              : t('apiService.images.remote.disabled')}
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">
            {config.references.storageRootConfigured
              ? t('apiService.images.storage.custom')
              : t('apiService.images.storage.privateDefault')}
          </span>
        </div>
      </div>

      {endpoints ? (
        <div className="mt-4 grid gap-1.5 border-t border-border/60 pt-3 text-[11px] sm:grid-cols-2">
          <code className="truncate rounded bg-surface-2/60 px-2 py-1.5" title={endpoints.generations}>
            {endpoints.generations}
          </code>
          <code className="truncate rounded bg-surface-2/60 px-2 py-1.5" title={endpoints.edits}>
            {endpoints.edits}
          </code>
        </div>
      ) : null}
    </section>
  );
}
