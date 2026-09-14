/**
 * useLaunchTargets.ts — the routing targets a Codex launch can pin. Three
 * kinds, mirroring what `POST /cli/codex/launch` accepts:
 *
 *  - `provider` — an upstream provider from the Providers page (lease launch
 *    with an explicit `providerId`; the proxy translates protocols, so any
 *    provider serves the Responses wire);
 *  - `route` — an enabled downstream route serving the `responses` endpoint
 *    (route-pinned launch with `bindingId`: the daemon picks an eligible key
 *    and pins that exact route via `x-omnicross-binding-id`);
 *  - `key` — a gateway access key eligible to route a key-scoped launch
 *    (enabled, not revoked, revealable, responses+images permissions — the
 *    daemon-side preflight contract).
 *
 * The list is secret-free (`listKeys` returns metadata only).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

export type CodexLaunchTarget =
  | { kind: 'provider'; providerId: string; label: string }
  | { kind: 'route'; bindingId: string; label: string }
  | { kind: 'key'; keyId: string; label: string };

export function useLaunchTargets(): { targets: CodexLaunchTarget[]; refresh: () => Promise<void> } {
  const [targets, setTargets] = useState<CodexLaunchTarget[]>([]);

  const load = useCallback(async () => {
    const [providers, server, keys] = await Promise.all([
      agent.llmConfig.getProviders().catch(() => []),
      agent.apiService.getConfig().catch(() => null),
      agent.apiService.listKeys().catch(() => []),
    ]);
    // Upstreams: any provider holding at least one model (the lease launch
    // resolves the provider's first model when none is named).
    const providerTargets: CodexLaunchTarget[] = (providers ?? [])
      .filter((p) => (p.models?.length ?? 0) > 0 || (p.modelConfigs?.length ?? 0) > 0)
      .map((p) => ({ kind: 'provider', providerId: p.id, label: p.name || p.id }));
    // Downstream routes: every enabled route on the responses endpoint — the
    // daemon's preflight fails fast (with a clear error) when no eligible key
    // can enter the chosen one.
    const routeTargets: CodexLaunchTarget[] = (server?.bindings ?? [])
      .filter((b) => b.enabled && b.endpoint === 'responses')
      .map((b) => ({ kind: 'route', bindingId: b.id, label: b.name }));
    // Raw gateway keys: the daemon preflight contract for key-scoped launches.
    const keyTargets: CodexLaunchTarget[] = (keys ?? [])
      .filter(
        (key) =>
          key.enabled &&
          !key.revoked &&
          key.revealable !== false &&
          (key.allowedEndpoints ?? []).includes('responses') &&
          (key.allowedEndpoints ?? []).includes('images'),
      )
      .map((key) => ({ kind: 'key', keyId: key.id, label: key.name }));
    setTargets([...providerTargets, ...routeTargets, ...keyTargets]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { targets, refresh: load };
}
