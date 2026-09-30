/**
 * useLaunchTargets.ts — the routing targets a terminal launch can pin, per
 * client CLI. Two kinds, mirroring what `POST /cli/:cli/launch` accepts:
 *
 *  - `provider` — an upstream provider from the Providers page that NATIVELY
 *    speaks the client's wire (Codex → `openai-response`, Claude Code →
 *    `anthropic`) and holds at least one model (lease launch with an explicit
 *    `providerId`). Other-format upstreams are deliberately NOT listed — serve
 *    them through a downstream route instead, where the gateway owns the
 *    protocol translation;
 *  - `key` — a gateway access key eligible to route a key-scoped launch
 *    (enabled, not revoked, revealable, holding the client-required endpoint
 *    permissions — the daemon-side preflight contract).
 *
 * Route-pinned launches (`bindingId`) are NOT offered here: the live route
 * aggregate is one derived `keyup:<key>:<n>:<endpoint>` binding per key per
 * endpoint, which merely duplicated each key under a second label. Picking the
 * key achieves the same pin through the key's own bindings. Both kinds are
 * deduped by id.
 *
 * The list is secret-free (`listKeys` returns metadata only).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

/** The CLIs whose launch dialog offers routing targets. */
export type LaunchTargetClient = 'codex' | 'claude';

export type LaunchTarget =
  | { kind: 'provider'; providerId: string; label: string }
  | { kind: 'key'; keyId: string; label: string };

/** Per-client contract: the wire name and the key permissions required. */
const CLIENT_CONTRACT: Record<
  LaunchTargetClient,
  {
    wire: string;
    wireFormats: string[];
    permissions: string[];
  }
> = {
  codex: {
    wire: 'Responses',
    wireFormats: ['openai-response'],
    permissions: ['responses', 'images'],
  },
  claude: {
    wire: 'Anthropic',
    wireFormats: ['anthropic'],
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
    const [providers, keys] = await Promise.all([
      agent.llmConfig.getProviders().catch(() => []),
      agent.apiService.listKeys().catch(() => []),
    ]);
    // Upstreams: ONLY providers natively speaking the client's wire, with at
    // least one model (the lease launch resolves the provider's first model
    // when none is named). Cross-format upstreams belong behind a downstream
    // route, where the gateway owns the translation.
    const providerTargets: LaunchTarget[] = [];
    const seenProviders = new Set<string>();
    for (const p of providers ?? []) {
      if (seenProviders.has(p.id)) continue;
      if (
        speaksWire(p, contract.wireFormats) &&
        ((p.models?.length ?? 0) > 0 || (p.modelConfigs?.length ?? 0) > 0)
      ) {
        seenProviders.add(p.id);
        providerTargets.push({ kind: 'provider', providerId: p.id, label: p.name || p.id });
      }
    }
    // Raw gateway keys: the daemon preflight contract for key-scoped launches.
    const keyTargets: LaunchTarget[] = [];
    const seenKeys = new Set<string>();
    for (const key of keys ?? []) {
      if (seenKeys.has(key.id)) continue;
      if (
        key.enabled &&
        !key.revoked &&
        key.revealable !== false &&
        contract.permissions.every((permission) =>
          (key.allowedEndpoints ?? []).some((allowed) => allowed === permission),
        )
      ) {
        seenKeys.add(key.id);
        keyTargets.push({ kind: 'key', keyId: key.id, label: key.name });
      }
    }
    setTargets([...providerTargets, ...keyTargets]);
  }, [contract]);

  useEffect(() => {
    void load();
  }, [load]);

  return { targets, wire: contract.wire, refresh: load };
}
