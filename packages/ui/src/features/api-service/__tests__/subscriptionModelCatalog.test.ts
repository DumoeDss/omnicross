/**
 * subscriptionModelCatalog tests — pins the UI mirror of contracts'
 * `SUBSCRIPTION_MODEL_CATALOG`. The ui package has no contracts runtime dep,
 * so this guard catches an accidental UI-side drift from the contracts SSOT.
 */
import { describe, expect, it } from 'vitest';

import { SUBSCRIPTION_MODEL_CATALOG, subscriptionProviderHasCatalog } from '../subscriptionModelCatalog';

describe('SUBSCRIPTION_MODEL_CATALOG', () => {
  it('catalogs claude (small → large) and codex (nano → flagship)', () => {
    // DRIFT GUARD: this UI mirror must match contracts' SSOT. If the upstream
    // catalog changes, update both this pin and the mirror together.
    expect(SUBSCRIPTION_MODEL_CATALOG.claude).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
    ]);
    expect(SUBSCRIPTION_MODEL_CATALOG.codex).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
  });

  it('leaves gemini/opencodego empty until their upstream ids are confirmed', () => {
    expect(SUBSCRIPTION_MODEL_CATALOG.gemini).toEqual([]);
    expect(SUBSCRIPTION_MODEL_CATALOG.opencodego).toEqual([]);
  });

  it('reports catalog availability per provider', () => {
    expect(subscriptionProviderHasCatalog('claude')).toBe(true);
    expect(subscriptionProviderHasCatalog('codex')).toBe(true);
    expect(subscriptionProviderHasCatalog('gemini')).toBe(false);
    expect(subscriptionProviderHasCatalog('opencodego')).toBe(false);
  });
});
