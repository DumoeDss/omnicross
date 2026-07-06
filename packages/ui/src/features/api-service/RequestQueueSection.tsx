/**
 * RequestQueueSection.tsx — the "Request queue" settings card for the two
 * outbound queue mechanisms (omnicross-user-queue-concurrency):
 *
 *  - Serial queue (`userMessageQueue`): a per-account FIFO for real user
 *    messages — an enable Switch + `delayMs` + `waitTimeoutMs`.
 *  - Concurrency queue (`concurrencyQueue`): per-key request-slot sizing —
 *    `maxQueueSizeFactor` + `minQueueSize` + `waitTimeoutMs`.
 *
 * Reads off `config.userMessageQueue` / `config.concurrencyQueue`, falling back
 * to the FROZEN defaults (planning-context §COMMITTED §1) when a pre-upgrade
 * daemon omits them. Each control commits only its own segment via `onUpdate`.
 */

import { ListOrdered } from 'lucide-react';
import React, { useState } from 'react';

import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  OutboundApiServerConfig,
  OutboundConcurrencyQueueConfig,
  OutboundUserMessageQueueConfig,
} from '@/daemon/types';

/** Frozen defaults (planning-context §COMMITTED §1) — the fallback when absent. */
const SERIAL_DEFAULTS: OutboundUserMessageQueueConfig = {
  enabled: false,
  delayMs: 200,
  waitTimeoutMs: 60000,
};
const CONCURRENCY_DEFAULTS: OutboundConcurrencyQueueConfig = {
  maxQueueSizeFactor: 2,
  minQueueSize: 4,
  waitTimeoutMs: 60000,
};

interface RequestQueueSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (patch: {
    userMessageQueue?: OutboundUserMessageQueueConfig;
    concurrencyQueue?: OutboundConcurrencyQueueConfig;
  }) => Promise<void>;
}

/**
 * A labelled integer input that keeps a local draft and commits on blur / Enter,
 * only firing `onCommit` when the parsed value actually changed. Non-finite or
 * empty input is discarded (the field re-seeds from the persisted value).
 */
function NumberField({
  label,
  helper,
  value,
  min,
  max,
  busy,
  onCommit,
}: {
  label: string;
  helper: string;
  value: number;
  min: number;
  max: number;
  busy: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = parseInt(draft.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    // Clamp to the field's valid range locally so an out-of-range entry never
    // round-trips to a daemon 400 (the daemon PUT strict-validates these).
    const clamped = Math.min(max, Math.max(min, parsed));
    if (clamped !== parsed) setDraft(String(clamped));
    if (clamped === value) return;
    onCommit(clamped);
  };

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <Input
        type="number"
        min={min}
        max={max}
        density="compact"
        className="w-28"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <p className="text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}

export function RequestQueueSection({ config, busy, onUpdate }: RequestQueueSectionProps) {
  const t = useTranslation();
  const serial = config.userMessageQueue ?? SERIAL_DEFAULTS;
  const concurrency = config.concurrencyQueue ?? CONCURRENCY_DEFAULTS;

  const patchSerial = (next: Partial<OutboundUserMessageQueueConfig>) =>
    void onUpdate({ userMessageQueue: { ...serial, ...next } });
  const patchConcurrency = (next: Partial<OutboundConcurrencyQueueConfig>) =>
    void onUpdate({ concurrencyQueue: { ...concurrency, ...next } });

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <ListOrdered className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.queue.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.queue.description')}</p>

      {/* Serial queue */}
      <div className="space-y-3 rounded-md border border-border/60 bg-surface-0/60 p-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{t('apiService.queue.serial.title')}</h4>
          <p className="text-xs text-muted-foreground">{t('apiService.queue.serial.description')}</p>
        </div>
        <SettingRow
          variant="compact"
          label={t('apiService.queue.serial.enable.label')}
          description={t('apiService.queue.serial.enable.description')}
        >
          <Switch
            checked={serial.enabled}
            disabled={busy}
            onCheckedChange={(checked) => patchSerial({ enabled: checked })}
            aria-label={t('apiService.queue.serial.enable.label')}
          />
        </SettingRow>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            label={t('apiService.queue.serial.delayMs.label')}
            helper={t('apiService.queue.serial.delayMs.helper')}
            value={serial.delayMs}
            min={0}
            max={10000}
            busy={busy}
            onCommit={(delayMs) => patchSerial({ delayMs })}
          />
          <NumberField
            label={t('apiService.queue.serial.waitTimeoutMs.label')}
            helper={t('apiService.queue.serial.waitTimeoutMs.helper')}
            value={serial.waitTimeoutMs}
            min={1000}
            max={300000}
            busy={busy}
            onCommit={(waitTimeoutMs) => patchSerial({ waitTimeoutMs })}
          />
        </div>
      </div>

      {/* Concurrency queue */}
      <div className="space-y-3 rounded-md border border-border/60 bg-surface-0/60 p-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">
            {t('apiService.queue.concurrency.title')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('apiService.queue.concurrency.description')}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            label={t('apiService.queue.concurrency.maxQueueSizeFactor.label')}
            helper={t('apiService.queue.concurrency.maxQueueSizeFactor.helper')}
            value={concurrency.maxQueueSizeFactor}
            min={1}
            max={10}
            busy={busy}
            onCommit={(maxQueueSizeFactor) => patchConcurrency({ maxQueueSizeFactor })}
          />
          <NumberField
            label={t('apiService.queue.concurrency.minQueueSize.label')}
            helper={t('apiService.queue.concurrency.minQueueSize.helper')}
            value={concurrency.minQueueSize}
            min={1}
            max={100}
            busy={busy}
            onCommit={(minQueueSize) => patchConcurrency({ minQueueSize })}
          />
          <NumberField
            label={t('apiService.queue.concurrency.waitTimeoutMs.label')}
            helper={t('apiService.queue.concurrency.waitTimeoutMs.helper')}
            value={concurrency.waitTimeoutMs}
            min={1000}
            max={300000}
            busy={busy}
            onCommit={(waitTimeoutMs) => patchConcurrency({ waitTimeoutMs })}
          />
        </div>
      </div>
    </section>
  );
}

export default RequestQueueSection;
