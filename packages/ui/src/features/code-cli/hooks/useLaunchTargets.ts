/**
 * useLaunchTargets.ts — the routing targets a terminal launch can pin, per
 * client CLI. Three kinds, mirroring what `POST /cli/:cli/launch` accepts:
 *
 *  - `provider` — an upstream provider from the Providers page that NATIVELY
 *    speaks the client's wire (Codex → `openai-response`, Claude Code →
 *    `anthropic`) and holds at least one model (lease launch with an explicit
 *    `providerId`). Other-format upstreams are deliberately NOT listed — serve
 *    them through a downstream route instead, where the gateway owns the
 *    protocol translation;
 *  - `route` — an enabled downstream route serving the client's endpoint
 *    (`responses` for Codex, `messages` for Claude Code; route-pinned launch
 *    with `bindingId`: the daemon picks an eligible key and pins that exact
 *    route via `x-omnicross-binding-id`);
 *  - `key` — a gateway access key eligible to route a key-scoped launch
 *    (enabled, not revoked, revealable, holding the client-required endpoint
 *    permissions — the daemon-side preflight contract).
 *
 * The list is secret-free (`listKeys` returns metadata only).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

/** The CLIs whose launch dialog offers routing targets. */
export type LaunchTargetClient = 'codex' | 'claude';

export type LaunchTarget =
  | { kind: 'provider'; providerId: string; label: string }
  | { kind: 'route'; bindingId: string; label: string }
  | { kind: 'key'; keyId: string; label: string };

/** Per-client contract: the wire name, the gateway endpoint, key permissions. */
const CLIENT_CONTRACT: Record<
  LaunchTargetClient,
  {
    wire: string;
    wireFormats: string[];
    endpoint: 'responses' | 'messages';
    permissions: string[];
  }
> = {
  codex: {
    wire: 'Responses',
    wireFormats: ['openai-response'],
    endpoint: 'responses',
    permissions: ['responses', 'images'],
  },
  claude: {
    wire: 'Anthropic',
    wireFormats: ['anthropic'],
    endpoint: 'messages',
    permissions: ['messages'],
  },
};

/** Does this upstream natively speak the client's wire? */
function speaksWire(provider: { apiFormat?: string; chatApiFormat?: string }, wireFormats: string[]): boolean {
  return wireFormats.some(
    (format) => provider.apiFormat === format || provider.chatApiFormat === format,
  );
}

export function useLaunchTargets(client: LaunchTargetClient): {
  targets: LaunchTarget[];
  wire: string;
  refresh: () => Promise<void>;
} {
  const [targets, setTargets] = useState<LaunchTarget[]>([]);
  const contract = CLIENT_CONTRACT[client];

  const load = useCallback(async () => {
    const [providers, server, keys] = await Promise.all([
      agent.llmConfig.getProviders().catch(() => []),
      agent.apiService.getConfig().catch(() => null),
      agent.apiService.listKeys().catch(() => []),
    ]);
    // Upstreams: ONLY providers natively speaking the client's wire, with at
    // least one model (the lease launch resolves the provider's first model
    // when none is named). Cross-format upstreams belong behind a downstream
    // route, where the gateway owns the translation.
    const providerTargets: LaunchTarget[] = (providers ?? [])
      .filter(
        (p) =>
          speaksWire(p, contract.wireFormats) &&
          ((p.models?.length ?? 0) > 0 || (p.modelConfigs?.length ?? 0) > 0),
      )
      .map((p) => ({ kind: 'provider', providerId: p.id, label: p.name || p.id }));
    // Downstream routes: every enabled route on the client's endpoint — the
    // daemon's preflight fails fast (with a clear error) when no eligible key
    // can enter the chosen one.
    const routeTargets: LaunchTarget[] = (server?.bindings ?? [])
      .filter((b) => b.enabled && b.endpoint === contract.endpoint)
      .map((b) => ({ kind: 'route', bindingId: b.id, label: b.name }));
    // Raw gateway keys: the daemon preflight contract for key-scoped launches.
    const keyTargets: LaunchTarget[] = (keys ?? [])
      .filter(
        (key) =>
          key.enabled &&
          !key.revoked &&
          key.revealable !== false &&
          contract.permissions.every((permission) =>
            (key.allowedEndpoints ?? []).some((allowed) => allowed === permission),
          ),
      )
      .map((key) => ({ kind: 'key', keyId: key.id, label: key.name }));
    setTargets([...providerTargets, ...routeTargets, ...keyTargets]);
  }, [contract]);

  useEffect(() => {
    void load();
  }, [load]);

  return { targets, wire: contract.wire, refresh: load };
}
