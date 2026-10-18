/**
 * useImagesSettings — the standalone Images page's own hook
 * (images-settings-tab, design D1). Everything the page needs from the daemon:
 * the masked server-config `images` segment, the non-consuming capability
 * snapshot and gateway status. Account data comes from the shared useAccounts hook.
 *
 * Mount-load mirrors useSearchSettings' discipline (load once + runWrite with
 * busy/error + refresh-after-write); the explicitly-consuming live
 * verification is a direct non-mutating action whose result the panel renders
 * inline (the webhook-test precedent).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

import type {
  ImagesCapabilityStatus,
  ImagesServerConfig,
  ImagesVerifyLiveResult,
  OutboundApiServerConfig,
  OutboundApiServerStatus,
} from '@/daemon/types';

export interface UseImagesSettingsResult {
  loading: boolean;
  /** The masked `images` config segment; undefined when the daemon predates it. */
  config: ImagesServerConfig | undefined;
  /** Non-consuming capability/runtime projection; null when unavailable. */
  capability: ImagesCapabilityStatus | null;
  status: OutboundApiServerStatus | null;
  busy: boolean;
  error: string | null;
  /** Persist the images segment (whole-object PUT via the shared adapter). */
  updateImagesConfig: (images: ImagesServerConfig) => Promise<void>;
  /**
   * EXPLICITLY-CONSUMING live verification (one low-quality PNG on the Codex
   * wire). The caller MUST have warned the operator before invoking.
   */
  verifyImagesLive: () => Promise<ImagesVerifyLiveResult | null>;
  /** Re-read config + capability + status (manual refresh / after verify). */
  refresh: () => Promise<void>;
}

export function useImagesSettings(): UseImagesSettingsResult {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<ImagesServerConfig | undefined>(undefined);
  const [capability, setCapability] = useState<ImagesCapabilityStatus | null>(null);
  const [status, setStatus] = useState<OutboundApiServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const [server, capability_, status_] = await Promise.all([
      agent.apiService.getConfig(),
      agent.apiService.getImagesCapability(),
      agent.apiService.getStatus(),
    ]);
    setConfig((server as OutboundApiServerConfig | null)?.images ?? undefined);
    setCapability(capability_);
    setStatus(status_);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [server, capability_, status_] = await Promise.all([
          agent.apiService.getConfig(),
          agent.apiService.getImagesCapability(),
          agent.apiService.getStatus(),
        ]);
        if (cancelled) return;
        setConfig((server as OutboundApiServerConfig | null)?.images ?? undefined);
        setCapability(capability_);
        setStatus(status_);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateImagesConfig = useCallback(async (images: ImagesServerConfig): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await agent.apiService.updateImagesConfig(images);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const verifyImagesLive = useCallback(async (): Promise<ImagesVerifyLiveResult | null> => {
    setError(null);
    try {
      return await agent.apiService.verifyImagesLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  return {
    loading,
    config,
    capability,
    status,
    busy,
    error,
    updateImagesConfig,
    verifyImagesLive,
    refresh,
  };
}
