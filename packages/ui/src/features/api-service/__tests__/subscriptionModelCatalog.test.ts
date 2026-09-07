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
      'claude-fable-5-1',
    ]);
    expect(SUBSCRIPTION_MODEL_CATALOG.codex).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-6-astra',
    ]);
  });

  it('catalogs kimi (small to large, official CLI ids)', () => {
    expect(SUBSCRIPTION_MODEL_CATALOG.kimi).toEqual([
      'kimi-k2.5',
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
  });

  it('leaves gemini/opencodego empty until their upstream ids are confirmed', () => {
    expect(SUBSCRIPTION_MODEL_CATALOG.gemini).toEqual([]);
    expect(SUBSCRIPTION_MODEL_CATALOG.opencodego).toEqual([]);
  });

  it('catalogs antigravity (static CCA census, denylist applied)', () => {
    expect(SUBSCRIPTION_MODEL_CATALOG.antigravity).toEqual([
      'tab_flash_lite_preview',
      'tab_jump_flash_lite_preview',
      'gpt-oss-120b',
      'gemini-3.1-flash-image',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash',
      'gemini-3-pro',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro',
      'gemini-3.5-flash',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'claude-sonnet-4-5',
    ]);
  });

  it('reports catalog availability per provider', () => {
    expect(subscriptionProviderHasCatalog('claude')).toBe(true);
    expect(subscriptionProviderHasCatalog('codex')).toBe(true);
    expect(subscriptionProviderHasCatalog('gemini')).toBe(false);
    expect(subscriptionProviderHasCatalog('opencodego')).toBe(false);
    expect(subscriptionProviderHasCatalog('antigravity')).toBe(true);
  });
});
