/**
 * useRouteKeys.ts — gateway access keys eligible to route a key-scoped Codex
 * launch. Mirrors the daemon-side preflight contract: enabled, not revoked,
 * revealable, and holding the responses+images endpoint permissions. The list
 * is secret-free (`listKeys` returns metadata only).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

export interface RouteKey {
  id: string;
  name: string;
}

export function useRouteKeys(): { routeKeys: RouteKey[]; refresh: () => Promise<void> } {
  const [routeKeys, setRouteKeys] = useState<RouteKey[]>([]);

  const load = useCallback(async () => {
    const keys = await agent.apiService.listKeys();
    setRouteKeys(
      keys
        .filter(
          (key) =>
            key.enabled &&
            !key.revoked &&
            key.revealable !== false &&
            (key.allowedEndpoints ?? []).includes('responses') &&
            (key.allowedEndpoints ?? []).includes('images'),
        )
        .map((key) => ({ id: key.id, name: key.name })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { routeKeys, refresh: load };
}
