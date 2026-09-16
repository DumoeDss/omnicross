/**
 * useUpstreamMappingInfo — one upstream's mapping-table row count, fetched
 * from the admin catalog on demand. Powers the per-resource "model mappings"
 * affordances (provider detail page, subscription-pool detail) so an operator
 * can see at a glance whether an upstream is passthrough (0 rows) or mapped.
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

export interface UpstreamMappingInfo {
  /** Mapping rows on the upstream's table; `null` while loading / unknown. */
  count: number | null;
  /** Re-read the catalog (e.g. after the editor dialog saved). */
  refresh: () => void;
}

export function useUpstreamMappingInfo(upstreamKey: string | null): UpstreamMappingInfo {
  const [count, setCount] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!upstreamKey) {
      setCount(null);
      return;
    }
    let cancelled = false;
    setCount(null);
    void agent.apiService.listUpstreams().then((result) => {
      if (cancelled) return;
      const entry = result.upstreams.find((item) => item.key === upstreamKey);
      setCount(entry ? entry.mappings.length : 0);
    }).catch(() => {
      if (!cancelled) setCount(null);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, upstreamKey]);

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return { count, refresh };
}
