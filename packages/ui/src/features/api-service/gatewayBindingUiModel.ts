import type { GatewayBinding, GatewayBindingTarget } from '@/daemon/types';
import type { SelectOption } from '@/components/ui/select';
import type { AppRoute } from '@/shared/state/hashRoute';

import type { LLMProvider } from '@shared/llm-config';

import type { AccountsListResponse } from '@/daemon/types-accounts';

/**
 * Direct key→upstream binding: the subscription providers whose upstream speaks
 * the SAME Anthropic Messages wire as the client (byte-for-byte same-format
 * relay). Others need translation and stay on the downstream routes.
 */
export const DIRECT_UPSTREAM_SUBSCRIPTION_PROVIDERS: readonly string[] = ['claude', 'kimi'];

/**
 * The direct-upstream picker's option list: every BYO provider, plus the
 * claude/kimi subscription pools / groups / accounts. Values are the encoded
 * targets ({@link encodeDirectUpstreamValue}); the label carries the localized
 * provider title so the picker reads like the upstreams page.
 */
export function buildDirectUpstreamOptions(
  providers: readonly LLMProvider[],
  providerAccounts: AccountsListResponse['providerAccounts'],
  t: (key: string, options?: Record<string, unknown>) => string,
): SelectOption[] {
  const options: SelectOption[] = [];
  for (const [providerId, rows] of Object.entries(providerAccounts)) {
    if (!DIRECT_UPSTREAM_SUBSCRIPTION_PROVIDERS.includes(providerId) || !rows.length) continue;
    const title = t(`accounts.provider.${providerId}.title`);
    options.push({
      value: `pool:${providerId}`,
      label: `${title} · ${t('upstreams.kind.account-pool')}`,
    });
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
    }
    for (const [group, members] of groups) {
      options.push({
        value: `group:${providerId}:${group}`,
        label: `${title} · ${group} · ${t('upstreams.memberCount', { count: members.length })}`,
      });
    }
    for (const row of rows) {
      options.push({
        value: `account:${providerId}:${row.id}`,
        label: `${title} · ${row.label || row.id}`,
      });
    }
  }
  for (const provider of providers) {
    options.push({ value: `provider:${provider.id}`, label: provider.name || provider.id });
  }
  return options;
}

/**
 * Encode a direct-upstream target as a stable Select value
 * (`provider:<id>` / `pool:<id>` / `group:<id>:<g>` / `account:<id>:<a>`).
 * The third segment is taken VERBATIM (a group name may itself contain `:`).
 */
export function encodeDirectUpstreamValue(target: GatewayBindingTarget | undefined): string {
  if (!target) return '';
  if (target.kind === 'provider') return `provider:${target.providerId}`;
  if (target.kind === 'account-pool') return `pool:${target.providerId}`;
  if (target.kind === 'account-group') return `group:${target.providerId}:${target.group}`;
  return `account:${target.providerId}:${target.accountId}`;
}

/** Read a legacy first-cut `boundUpstreamProviderId` string as a provider target. */
export function legacyDirectUpstream(
  providerId: string | undefined,
): GatewayBindingTarget | undefined {
  return providerId ? { kind: 'provider', providerId } : undefined;
}

/** Decode a Select value back into a target, or `null` for the unbound value. */
export function decodeDirectUpstreamValue(value: string): GatewayBindingTarget | null {
  const firstColon = value.indexOf(':');
  if (firstColon <= 0) return null;
  const kind = value.slice(0, firstColon);
  const remainder = value.slice(firstColon + 1);
  const secondColon = remainder.indexOf(':');
  const providerId = secondColon === -1 ? remainder : remainder.slice(0, secondColon);
  const ref = secondColon === -1 ? undefined : remainder.slice(secondColon + 1);
  if (!providerId) return null;
  if (kind === 'provider') return { kind: 'provider', providerId };
  if (kind === 'pool') return { kind: 'account-pool', providerId };
  if (kind === 'group' && ref) return { kind: 'account-group', providerId, group: ref };
  if (kind === 'account' && ref) return { kind: 'account', providerId, accountId: ref };
  return null;
}

export function routeForBinding(binding: GatewayBinding): AppRoute {
  return {
    page: 'upstreams',
    upstreamTab: 'routes',
    downstreamId: binding.id,
  };
}

export function bindingAllowsClientKey(binding: GatewayBinding, keyId: string): boolean {
  const scope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
  return scope === 'all' || Boolean(binding.apiKeyIds?.includes(keyId));
}

export function bindingsForClientKey(
  bindings: readonly GatewayBinding[],
  keyId: string,
): GatewayBinding[] {
  return bindings.filter(
    (binding) => binding.enabled && bindingAllowsClientKey(binding, keyId),
  );
}

/** Update one key-to-downstream assignment without changing any route details. */
export function setBindingForClientKey(
  bindings: readonly GatewayBinding[],
  allKeyIds: readonly string[],
  keyId: string,
  bindingId: string,
  selected: boolean,
): GatewayBinding[] {
  return bindings.map((binding) => {
    if (binding.id !== bindingId) return binding;
    const currentScope = binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all');
    if (selected) {
      if (currentScope === 'all' || binding.apiKeyIds?.includes(keyId)) return binding;
      return {
        ...binding,
        keyScope: 'selected',
        apiKeyIds: [...new Set([...(binding.apiKeyIds ?? []), keyId])],
      };
    }
    const currentIds = currentScope === 'all' ? [...allKeyIds] : [...(binding.apiKeyIds ?? [])];
    return {
      ...binding,
      keyScope: 'selected',
      apiKeyIds: currentIds.filter((id) => id !== keyId),
    };
  });
}

export function bindingTargetLabel(binding: GatewayBinding): string {
  if (binding.target.kind === 'account') {
    return `${binding.target.providerId} / ${binding.target.accountId}`;
  }
  if (binding.target.kind === 'account-group') {
    return `${binding.target.providerId} / ${binding.target.group}`;
  }
  return binding.target.providerId;
}

export function summarizeBindingCoverage(bindings: readonly GatewayBinding[]): {
  enabled: number;
  endpoints: number;
  keyScoped: number;
} {
  const enabled = bindings.filter((binding) => binding.enabled);
  return {
    enabled: enabled.length,
    endpoints: new Set(enabled.map((binding) => binding.endpoint)).size,
    keyScoped: enabled.filter(
      (binding) =>
        (binding.keyScope ?? (binding.apiKeyIds?.length ? 'selected' : 'all')) === 'selected',
    ).length,
  };
}
