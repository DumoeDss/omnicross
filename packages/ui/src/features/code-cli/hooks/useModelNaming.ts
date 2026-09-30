/**
 * useModelNaming — the model-name-visibility toggle (`modelNaming.realNames`)
 * for the Code CLI page. Reads only `GET /server`'s modelNaming segment and
 * writes through the same admin seam the API-service page used; the daemon
 * re-renders the installed Claude integration file on change, and the Codex
 * side is served live off the managed `model_catalog_url`.
 */

import { useCallback, useState } from 'react';

import { agent } from '@/shared/agent';

export function useModelNaming() {
  const [realNames, setRealNames] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const config = await agent.apiService.getConfig();
      setRealNames(config?.modelNaming?.realNames === true);
    } catch {
      // Display-only toggle: a failed read leaves it unchecked (null).
      setRealNames(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  const update = useCallback(async (next: boolean) => {
    setBusy(true);
    try {
      const result = await agent.apiService.updateModelNamingConfig({ realNames: next });
      if (result.success) setRealNames(next);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  return { realNames, busy, loaded, refresh, update };
}
