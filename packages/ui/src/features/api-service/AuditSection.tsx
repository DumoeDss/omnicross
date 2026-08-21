/**
 * AuditSection.tsx — the "Request audit log" settings card + viewer
 * (request-audit-log, Phase 2).
 *
 * Edits the `server.audit` segment: a master enable switch, a SEPARATE
 * body-capture switch (the sensitive second opt-in), a truncation cap, a TTL
 * retention, and a trust-`X-Forwarded-For` switch. Edits are held in a local
 * draft; Save PUTs the whole segment. Below the settings, an authed viewer
 * queries `GET /admin/api/audit` by key id + limit and renders the returned
 * metadata rows. Captured bodies are NOT part of a listing — they live in the
 * per-session shard store and are fetched one record at a time. The segment
 * carries NO secret — nothing here is masked.
 */

import { Archive, FileClock, RefreshCw } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { AuditConfig, AuditRecord, OutboundApiServerConfig } from '@/daemon/types';

const DEFAULT_AUDIT: AuditConfig = {
  enabled: false,
  captureBodies: false,
  maxBodyBytes: -1,
  retentionDays: 7,
  compactStreamingBodies: false,
  trustForwardedFor: false,
};

interface AuditSectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (audit: OutboundApiServerConfig['audit'] | undefined) => Promise<void>;
  onQuery: (query: { keyId?: string; limit?: number }) => Promise<AuditRecord[]>;
  onCompact: () => Promise<{ days: number; shards: number; savedBytes: number }>;
}

export function AuditSection({ config, busy, onUpdate, onQuery, onCompact }: AuditSectionProps) {
  const t = useTranslation();
  const seeded: AuditConfig = config.audit ?? DEFAULT_AUDIT;
  const [draft, setDraft] = React.useState<AuditConfig>(seeded);
  const [records, setRecords] = React.useState<AuditRecord[] | null>(null);
  const [keyFilter, setKeyFilter] = React.useState('');
  const [querying, setQuerying] = React.useState(false);
  const [compacting, setCompacting] = React.useState(false);
  const [compactResult, setCompactResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(config.audit ?? DEFAULT_AUDIT);
  }, [config.audit]);

  const patch = (p: Partial<AuditConfig>): void => setDraft((d) => ({ ...d, ...p }));

  const save = (): Promise<void> => onUpdate(draft);

  // Compaction rewrites CLOSED days only, so it is safe to trigger at any time.
  const runCompact = async (): Promise<void> => {
    setCompacting(true);
    setCompactResult(null);
    try {
      const result = await onCompact();
      const mb = (result.savedBytes / (1024 * 1024)).toFixed(1);
      setCompactResult(
        t('apiService.audit.compactNow.result', {
          days: String(result.days),
          shards: String(result.shards),
          saved: `${mb} MB`,
        }),
      );
    } finally {
      setCompacting(false);
    }
  };

  const runQuery = async (): Promise<void> => {
    setQuerying(true);
    try {
      const rows = await onQuery({ keyId: keyFilter.trim() || undefined, limit: 100 });
      setRecords(rows);
    } finally {
      setQuerying(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <FileClock className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.audit.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.audit.description')}</p>

      <SettingRow
        label={t('apiService.audit.enable.label')}
        description={t('apiService.audit.enable.description')}
      >
        <Switch
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label={t('apiService.audit.enable.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.audit.captureBodies.label')}
        description={t('apiService.audit.captureBodies.description')}
      >
        <Switch
          checked={draft.captureBodies}
          disabled={busy || !draft.enabled}
          onCheckedChange={(checked) => patch({ captureBodies: checked })}
          aria-label={t('apiService.audit.captureBodies.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.audit.maxBodyBytes.label')}
        description={t('apiService.audit.maxBodyBytes.description')}
      >
        <Input
          type="number"
          min={-1}
          step={1}
          className="w-32"
          value={String(draft.maxBodyBytes)}
          disabled={busy || !draft.captureBodies}
          onChange={(e) => patch({ maxBodyBytes: Number(e.target.value) || 0 })}
          aria-label={t('apiService.audit.maxBodyBytes.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.audit.compactStreamingBodies.label')}
        description={t('apiService.audit.compactStreamingBodies.description')}
      >
        <Switch
          checked={draft.compactStreamingBodies}
          disabled={busy || !draft.captureBodies}
          onCheckedChange={(checked) => patch({ compactStreamingBodies: checked })}
          aria-label={t('apiService.audit.compactStreamingBodies.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.audit.retentionDays.label')}
        description={t('apiService.audit.retentionDays.description')}
      >
        <Input
          type="number"
          className="w-32"
          value={String(draft.retentionDays)}
          disabled={busy || !draft.enabled}
          onChange={(e) => patch({ retentionDays: Number(e.target.value) || 0 })}
          aria-label={t('apiService.audit.retentionDays.label')}
        />
      </SettingRow>

      <SettingRow
        label={t('apiService.audit.trustForwardedFor.label')}
        description={t('apiService.audit.trustForwardedFor.description')}
      >
        <Switch
          checked={draft.trustForwardedFor}
          disabled={busy || !draft.enabled}
          onCheckedChange={(checked) => patch({ trustForwardedFor: checked })}
          aria-label={t('apiService.audit.trustForwardedFor.label')}
        />
      </SettingRow>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {t('apiService.audit.save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || compacting || !draft.enabled}
          onClick={() => void runCompact()}
        >
          <Archive className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t('apiService.audit.compactNow.label')}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {compactResult ?? t('apiService.audit.compactNow.description')}
      </p>

      {/* Viewer — authed query by key id (bodies shown only if captured). */}
      <div className="space-y-2 rounded-md border border-border/60 p-3">
        <p className="text-xs font-medium text-muted-foreground">{t('apiService.audit.viewer.title')}</p>
        <div className="flex items-center gap-2">
          <Input
            value={keyFilter}
            disabled={querying}
            placeholder={t('apiService.audit.viewer.keyPlaceholder')}
            onChange={(e) => setKeyFilter(e.target.value)}
            aria-label={t('apiService.audit.viewer.keyPlaceholder')}
          />
          <Button variant="outline" size="sm" disabled={querying} onClick={() => void runQuery()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t('apiService.audit.viewer.refresh')}
          </Button>
        </div>
        {records === null ? (
          <p className="text-[11px] text-muted-foreground">{t('apiService.audit.viewer.hint')}</p>
        ) : records.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t('apiService.audit.viewer.empty')}</p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colTime')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colMethod')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colPath')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colStatus')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colModel')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colKey')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colIp')}</th>
                  <th className="py-1 pr-2">{t('apiService.audit.viewer.colLatency')}</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {records.map((r) => (
                  <tr key={r.id} className="border-t border-border/40 align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                    <td className="py-1 pr-2">{r.method}</td>
                    <td className="py-1 pr-2 break-all">{r.path}</td>
                    <td className="py-1 pr-2">{r.status}</td>
                    <td className="py-1 pr-2 break-all">{r.model ?? '—'}</td>
                    <td className="py-1 pr-2 break-all">{r.keyId ?? '—'}</td>
                    <td className="py-1 pr-2 break-all">{r.ip ?? '—'}</td>
                    <td className="py-1 pr-2 whitespace-nowrap">{r.latencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default AuditSection;
