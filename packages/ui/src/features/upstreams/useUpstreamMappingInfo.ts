/**
 * useUpstreamMappingInfo — one upstream's mapping table, fetched from the admin
 * catalog on demand. Powers the per-resource "model mappings" affordance
 * (provider detail page, subscription-pool detail): the expanded section shows
 * the actual rows READ-ONLY, so checking what a model maps to never requires
 * opening the editor dialog.
 */

import { useCallback, useEffect, useState } from 'react';

import type { UpstreamCatalogEntry } from '@/daemon/types';
import { agent } from '@/shared/agent';

/** One wire mapping row (client model → upstream model, optional effort pin). */
export type UpstreamMappingRow = UpstreamCatalogEntry['mappings'][number];

export interface UpstreamMappingInfo {
  /** Mapping rows on the upstream's table; `null` while loading / unknown. */
  mappings: UpstreamMappingRow[] | null;
  /** Row count (`null` while loading) — kept as the compact badge value. */
  count: number | null;
  /** Strict-mapping flag; `null` while loading / unknown. */
  force: boolean | null;
  /** Re-read the catalog (e.g. after the editor dialog saved). */
  refresh: () => void;
}

export function useUpstreamMappingInfo(upstreamKey: string | null): UpstreamMappingInfo {
  const [mappings, setMappings] = useState<UpstreamMappingRow[] | null>(null);
  const [force, setForce] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!upstreamKey) {
      setMappings(null);
      setForce(null);
      return;
    }
    let cancelled = false;
    setMappings(null);
    setForce(null);
    void agent.apiService.listUpstreams().then((result) => {
      if (cancelled) return;
      const entry = result.upstreams.find((item) => item.key === upstreamKey);
      setMappings(entry?.mappings ?? []);
      setForce(entry?.force !== false);
    }).catch(() => {
      if (!cancelled) {
        setMappings(null);
        setForce(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nonce, upstreamKey]);

  const refresh = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return { mappings, count: mappings ? mappings.length : null, force, refresh };
}
