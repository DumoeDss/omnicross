/**
 * WebhookSection.tsx — the "Webhook notifications" settings card
 * (webhook-notifications, Phase 2).
 *
 * Edits the `server.webhook` segment: a master enable switch + a list of
 * destinations (type / url / signing secret / event filter / enabled). Edits are
 * held in a local draft; Save PUTs the WHOLE segment (the daemon preserves each
 * destination's write-only secret when the field is left masked). A per-destination
 * Test button delivers a `test` event to the SAVED destination and shows the
 * outcome. The secret is entered through a {@link RevealableInput} and is masked on
 * read — it never round-trips in plaintext.
 */

import { Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RevealableInput } from '@/components/ui/revealable-input';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type {
  OutboundApiServerConfig,
  WebhookConfig,
  WebhookDestination,
  WebhookDestinationType,
  WebhookEventKind,
  WebhookTestResult,
} from '@/daemon/types';

const DESTINATION_TYPES: WebhookDestinationType[] = ['custom', 'feishu'];

const EVENT_KINDS: WebhookEventKind[] = [
  'account.recovery',
  'account.anomaly',
  'key.quotaWarning',
  'key.quotaExceeded',
  'server.error',
];

interface WebhookSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (webhook: OutboundApiServerConfig['webhook'] | undefined) => Promise<void>;
  onTest: (destinationId: string) => Promise<WebhookTestResult>;
}

/** Draft a blank destination with a unique-ish id. */
function blankDestination(): WebhookDestination {
  return { id: `wh_${Math.random().toString(36).slice(2, 8)}`, type: 'custom', url: '', enabled: true };
}

export function WebhookSection({ config, busy, onUpdate, onTest }: WebhookSectionProps) {
  const t = useTranslation();
  const seeded: WebhookConfig = config.webhook ?? { enabled: false, destinations: [] };
  const [draft, setDraft] = React.useState<WebhookConfig>(seeded);
  const [testResults, setTestResults] = React.useState<Record<string, WebhookTestResult>>({});

  // Re-seed the draft whenever the loaded config changes (a successful save
  // re-fetches and re-renders with the masked-secret view).
  React.useEffect(() => {
    setDraft(config.webhook ?? { enabled: false, destinations: [] });
  }, [config.webhook]);

  const patchDestination = (index: number, patch: Partial<WebhookDestination>): void => {
    setDraft((d) => ({
      ...d,
      destinations: d.destinations.map((dest, i) => (i === index ? { ...dest, ...patch } : dest)),
    }));
  };

  const toggleEvent = (index: number, kind: WebhookEventKind): void => {
    setDraft((d) => ({
      ...d,
      destinations: d.destinations.map((dest, i) => {
        if (i !== index) return dest;
        const events = new Set(dest.events ?? []);
        if (events.has(kind)) events.delete(kind);
        else events.add(kind);
        const next = [...events];
        return { ...dest, events: next.length > 0 ? next : undefined };
      }),
    }));
  };

  const addDestination = (): void =>
    setDraft((d) => ({ ...d, destinations: [...d.destinations, blankDestination()] }));

  const removeDestination = (index: number): void =>
    setDraft((d) => ({ ...d, destinations: d.destinations.filter((_, i) => i !== index) }));

  const save = (): Promise<void> =>
    onUpdate(draft.destinations.length === 0 && !draft.enabled ? undefined : draft);

  const runTest = async (id: string): Promise<void> => {
    const result = await onTest(id);
    setTestResults((r) => ({ ...r, [id]: result }));
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <WebhookIcon className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.webhook.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.webhook.description')}</p>

      <SettingRow label={t('apiService.webhook.enable.label')} description={t('apiService.webhook.enable.description')}>
        <Switch
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: checked }))}
          aria-label={t('apiService.webhook.enable.label')}
        />
      </SettingRow>

      <div className="space-y-3">
        {draft.destinations.map((dest, index) => (
          <div key={dest.id} className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="w-40">
                <Select
                  value={dest.type}
                  onChange={(v) => patchDestination(index, { type: v as WebhookDestinationType })}
                  options={DESTINATION_TYPES.map((tp) => ({ value: tp, label: t(`apiService.webhook.type.${tp}`) }))}
                  disabled={busy}
                  size="sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={dest.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => patchDestination(index, { enabled: checked })}
                  aria-label={t('apiService.webhook.destinationEnabled')}
                />
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => removeDestination(index)} aria-label={t('apiService.webhook.remove')}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <Input
              value={dest.url}
              disabled={busy}
              placeholder={t('apiService.webhook.urlPlaceholder')}
              onChange={(e) => patchDestination(index, { url: e.target.value })}
              aria-label={t('apiService.webhook.url')}
            />

            <RevealableInput
              value={dest.secret ?? ''}
              disabled={busy}
              placeholder={t('apiService.webhook.secretPlaceholder')}
              onChange={(e) => patchDestination(index, { secret: e.target.value })}
              aria-label={t('apiService.webhook.secret')}
            />

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('apiService.webhook.eventsLabel')}</p>
              <div className="flex flex-wrap gap-1.5">
                {EVENT_KINDS.map((kind) => {
                  const on = !dest.events || dest.events.length === 0 || dest.events.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      disabled={busy}
                      onClick={() => toggleEvent(index, kind)}
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        on ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border/60 text-muted-foreground'
                      }`}
                    >
                      {kind}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">{t('apiService.webhook.eventsHint')}</p>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void runTest(dest.id)}>
                <Send className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {t('apiService.webhook.test')}
              </Button>
              {testResults[dest.id] ? (
                <span className={`text-xs ${testResults[dest.id].ok ? 'text-primary' : 'text-destructive'}`}>
                  {testResults[dest.id].ok
                    ? t('apiService.webhook.testOk')
                    : t('apiService.webhook.testFail', { error: testResults[dest.id].error ?? String(testResults[dest.id].status ?? '') })}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={addDestination}>
          {t('apiService.webhook.addDestination')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {t('apiService.webhook.save')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('apiService.webhook.testHint')}</p>
    </section>
  );
}

export default WebhookSection;
