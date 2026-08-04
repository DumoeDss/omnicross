import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import { describe, expect, it, vi } from 'vitest';

import { SubscriptionAccountService } from '../SubscriptionAccountService';
import type { SubscriptionCredentialStore } from '../ports/credential-store';

function storeFor(config: AccountTokensConfig): SubscriptionCredentialStore {
  return {
    getFullConfig: vi.fn(async () => config),
    getValidClaudeAccessToken: vi.fn(async () => config.claude?.accessToken ?? null),
    getValidOpenCodeGoApiKey: vi.fn(async () => null),
    refreshClaudeToken: vi.fn(async () => false), refreshCodexToken: vi.fn(async () => false), refreshGeminiToken: vi.fn(async () => false),
    getAccessTokenForAccount: vi.fn(async (_provider, id) => config.claudeAccounts?.find((account) => account.id === id)?.tokens.accessToken ?? null),
  };
}

async function authorization(config: AccountTokensConfig): Promise<string | undefined> {
  const strategy = new SubscriptionAccountService(storeFor(config)).getStrategy('claude')!;
  const headers: Record<string, string> = {};
  await strategy.applyHeaders(headers);
  return headers.Authorization;
}

describe('explicit account enabled gating', () => {
  it('legacy rows without enabled remain schedulable', async () => {
    expect(await authorization({ updatedAt: '', claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'legacy' }, activeClaudeAccountId: 'a', claudeAccounts: [{ id: 'a', tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'legacy' } }] })).toBe('Bearer legacy');
  });

  it('a disabled sole active account does not fall through to its credential', async () => {
    expect(await authorization({ updatedAt: '', claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'disabled' }, activeClaudeAccountId: 'a', claudeAccounts: [{ id: 'a', enabled: false, tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'disabled' } }] })).toBeUndefined();
  });

  it('routes around a disabled active account to an enabled sibling', async () => {
    expect(await authorization({ updatedAt: '', claude: { authMethod: 'oauth', status: 'authorized', accessToken: 'disabled' }, activeClaudeAccountId: 'a', claudeAccounts: [
      { id: 'a', enabled: false, tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'disabled' } },
      { id: 'b', enabled: true, tokens: { authMethod: 'oauth', status: 'authorized', accessToken: 'enabled' } },
    ] })).toBe('Bearer enabled');
  });
});
