import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../adminClient', () => ({
  adminClient: { get: vi.fn() },
}));

import { adminClient } from '../adminClient';
import { createAccountsAdapter } from '../accountsAdapter';
import { mergeSubscriptionModelIds, SUBSCRIPTION_MODEL_CATALOG } from '../../features/api-service/subscriptionModelCatalog';

beforeEach(() => vi.clearAllMocks());

describe('Antigravity model discovery for routing suggestions', () => {
  it('loads daemon metadata and merges new models without duplicates', async () => {
    const models = [{ id: 'gemini-next', origin: 'discovered', supportsThinking: true }];
    vi.mocked(adminClient.get).mockResolvedValueOnce({ models, discovered: true });
    const result = await createAccountsAdapter().listAntigravityModels();
    expect(adminClient.get).toHaveBeenCalledWith('/accounts/antigravity/models');
    expect(result).toEqual({ models, discovered: true });
    expect(mergeSubscriptionModelIds('antigravity', [...models, { id: 'gemini-3-pro' }]))
      .toEqual([...SUBSCRIPTION_MODEL_CATALOG.antigravity, 'gemini-next']);
  });

  it('keeps static suggestions when discovery fails', async () => {
    vi.mocked(adminClient.get).mockRejectedValueOnce(new Error('offline'));
    const result = await createAccountsAdapter().listAntigravityModels();
    expect(result).toEqual({ models: [], discovered: false });
    expect(mergeSubscriptionModelIds('antigravity', result.models)).toEqual(SUBSCRIPTION_MODEL_CATALOG.antigravity);
  });
});
