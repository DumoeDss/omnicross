import type {
  AccountTokensConfig,
  SubscriptionAccountEntry,
} from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import {
  RouteLeaseError,
  type RouteLeaseSubscriptionPreflight,
  type RouteLeaseUpstream,
} from '@omnicross/core/provider-proxy';
import { getSharedAccountAllowanceScheduling } from '@omnicross/core/pipeline/AccountAllowanceScheduling';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { accountSupportsModel } from '@omnicross/subscriptions/scheduler/accountModelMap';
import type { SubscriptionCredentialStore } from '@omnicross/subscriptions/ports/credential-store';

type AnyAccount = SubscriptionAccountEntry<Record<string, unknown>>;

const PROVIDERS = new Set<SubscriptionProviderId>(['claude', 'codex', 'gemini', 'opencodego']);

function accountArray(config: AccountTokensConfig, providerId: SubscriptionProviderId): AnyAccount[] {
  const record = config as unknown as Record<string, unknown>;
  const key = `${providerId}Accounts`;
  const accounts = record[key];
  if (Array.isArray(accounts)) return accounts as AnyAccount[];
  const legacy = record[providerId];
  if (!legacy || typeof legacy !== 'object') return [];
  const activeKey = `active${providerId[0].toUpperCase()}${providerId.slice(1)}AccountId`;
  return [{ id: String(record[activeKey] ?? 'active'), enabled: true, tokens: legacy as Record<string, unknown> }];
}

function hasCredential(providerId: SubscriptionProviderId, account: AnyAccount): boolean {
  const tokens = account.tokens;
  if (providerId === 'opencodego') return typeof tokens.apiKey === 'string' && tokens.apiKey.length > 0;
  return typeof tokens.accessToken === 'string' && tokens.accessToken.length > 0;
}

function safeProviderId(value: string): SubscriptionProviderId {
  if (!PROVIDERS.has(value as SubscriptionProviderId)) {
    throw new RouteLeaseError('upstream_not_found', 'subscription provider was not found');
  }
  return value as SubscriptionProviderId;
}

/** Host-owned static account/credential/health preflight; it makes no upstream call. */
export function createRouteLeaseSubscriptionPreflight(
  credentials: SubscriptionCredentialStore,
): RouteLeaseSubscriptionPreflight {
  return {
    async assertAvailable(
      upstream: Exclude<RouteLeaseUpstream, { kind: 'provider' }>,
      model: string,
    ): Promise<void> {
      const providerId = safeProviderId(upstream.providerId);
      const config = await credentials.getFullConfig();
      const all = accountArray(config, providerId);
      if (all.length === 0) {
        throw new RouteLeaseError('upstream_unavailable', 'subscription provider has no configured account');
      }
      let bounded = all;
      if (upstream.kind === 'account') {
        bounded = all.filter((account) => account.id === upstream.accountId);
      } else if (upstream.kind === 'account-group') {
        bounded = all.filter((account) => account.group?.trim() === upstream.group);
      }
      if (bounded.length === 0) {
        throw new RouteLeaseError('upstream_not_found', 'the selected subscription resource was not found');
      }
      const modelEligible = bounded.filter((account) =>
        accountSupportsModel(account.supportedModels, model),
      );
      if (modelEligible.length === 0) {
        throw new RouteLeaseError('model_not_configured', 'model is not supported by the selected subscription resource');
      }
      const credentialEligible = modelEligible.filter((account) =>
        account.enabled !== false && hasCredential(providerId, account),
      );
      const health = getSharedAccountHealth();
      const allowance = getSharedAccountAllowanceScheduling();
      const candidates = credentialEligible.filter((account) =>
        health.isSchedulable(providerId, account.id) &&
        allowance.preview(providerId, account.id, account.priority ?? 50).schedulable,
      );
      if (candidates.length > 0) return;
      if (upstream.kind === 'account') {
        throw new RouteLeaseError('upstream_unavailable', 'the selected subscription account is unavailable');
      }
      throw new RouteLeaseError('upstream_exhausted', 'the selected subscription pool has no eligible account', {
        retryAfterSeconds: 30,
      });
    },
  };
}
