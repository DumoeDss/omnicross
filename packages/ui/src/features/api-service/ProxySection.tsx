/**
 * ProxySection.tsx — the "Upstream proxy" settings card (upstream-proxy).
 *
 * Edits the layered `server.proxy` segment: a GLOBAL proxy plus optional
 * per-provider overrides (claude/codex/gemini/opencodego/byo). Each layer is a
 * {@link ProxyEditor}; a save/clear rebuilds the FULL segment from the last-loaded
 * (masked) config and PUTs it — the daemon preserves each untouched layer's
 * write-only password. Precedence at serve time is account > provider > global >
 * env; this card owns the global + provider layers.
 */

import { Network } from 'lucide-react';
import React from 'react';

import { ProxyEditor, seedFromProxyConfig } from '@/components/ProxyEditor';
import { useTranslation } from '@/shared/state/LocaleContext';

import type { OutboundApiServerConfig, OutboundProxyConfig, ProxyConfig } from '@/daemon/types';

/** The per-provider override keys (subscription providers + the BYO bucket). */
const PROVIDER_KEYS = ['claude', 'codex', 'gemini', 'opencodego', 'byo'] as const;

/** Brand display names (not translated); BYO uses an i18n label. */
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencodego: 'OpenCodeGo',
};

interface ProxySectionProps {
  config: OutboundApiServerConfig;
  busy: boolean;
  onUpdate: (proxy: OutboundProxyConfig | undefined) => Promise<void>;
}

/** Collapse an empty segment (no global + no provider entries) to `undefined`. */
function normalizeSegment(next: OutboundProxyConfig): OutboundProxyConfig | undefined {
  const hasProviders = next.byProvider && Object.keys(next.byProvider).length > 0;
  if (!next.global && !hasProviders) return undefined;
  const out: OutboundProxyConfig = {};
  if (next.global) out.global = next.global;
  if (hasProviders) out.byProvider = next.byProvider;
  return out;
}

export function ProxySection({ config, busy, onUpdate }: ProxySectionProps) {
  const t = useTranslation();
  const proxy = config.proxy ?? {};

  const saveGlobal = (cfg: ProxyConfig) =>
    onUpdate(normalizeSegment({ ...proxy, global: cfg }));
  const clearGlobal = () => {
    const { global: _drop, ...rest } = proxy;
    return onUpdate(normalizeSegment(rest));
  };

  const saveProvider = (pid: string, cfg: ProxyConfig) =>
    onUpdate(normalizeSegment({ ...proxy, byProvider: { ...proxy.byProvider, [pid]: cfg } }));
  const clearProvider = (pid: string) => {
    const byProvider = { ...proxy.byProvider };
    delete byProvider[pid];
    return onUpdate(normalizeSegment({ ...proxy, byProvider }));
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-foreground">{t('apiService.proxy.title')}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{t('apiService.proxy.description')}</p>

      <ProxyEditor
        label={t('apiService.proxy.global.label')}
        description={t('apiService.proxy.global.description')}
        seed={seedFromProxyConfig(proxy.global)}
        busy={busy}
        onSave={saveGlobal}
        onClear={clearGlobal}
      />

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('apiService.proxy.byProvider.title')}
        </h4>
        <div className="space-y-2">
          {PROVIDER_KEYS.map((pid) => (
            <ProxyEditor
              key={pid}
              label={PROVIDER_LABELS[pid] ?? t('apiService.proxy.byoLabel')}
              seed={seedFromProxyConfig(proxy.byProvider?.[pid])}
              busy={busy}
              onSave={(cfg) => saveProvider(pid, cfg)}
              onClear={() => clearProvider(pid)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export default ProxySection;
