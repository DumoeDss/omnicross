import { describe, expect, it } from 'vitest';

import {
  mergeServerConfig,
  normalizeServerConfig,
  normalizeWebhookSegment,
} from '../apiServerConfig';

describe('normalizeWebhookSegment', () => {
  it('returns undefined for an absent/empty segment (zero regression)', () => {
    expect(normalizeWebhookSegment(undefined)).toBeUndefined();
    expect(normalizeWebhookSegment(null)).toBeUndefined();
    expect(normalizeWebhookSegment({})).toBeUndefined();
    expect(normalizeWebhookSegment({ enabled: false, destinations: [] })).toBeUndefined();
  });

  it('keeps a valid destination + drops malformed ones', () => {
    const out = normalizeWebhookSegment({
      enabled: true,
      destinations: [
        { id: 'd1', type: 'custom', url: 'https://x/hook', secret: 's', enabled: true },
        { id: '', type: 'custom', url: 'https://x' }, // bad id → dropped
        { id: 'd2', type: 'bogus', url: 'https://x' }, // bad type → dropped
        { id: 'd3', type: 'feishu', url: '' }, // bad url → dropped
      ],
    });
    expect(out?.enabled).toBe(true);
    expect(out?.destinations.map((d) => d.id)).toEqual(['d1']);
  });

  it('defaults enabled to true per destination + keeps only known event kinds', () => {
    const out = normalizeWebhookSegment({
      enabled: true,
      destinations: [
        { id: 'd1', type: 'custom', url: 'https://x', events: ['account.recovery', 'bogus'] },
        { id: 'd2', type: 'custom', url: 'https://x', enabled: false, events: [] },
      ],
    });
    expect(out?.destinations[0]).toMatchObject({ enabled: true, events: ['account.recovery'] });
    // An all-unknown/empty events filter collapses to absent (⇒ all kinds).
    expect(out?.destinations[0].events).toEqual(['account.recovery']);
    expect(out?.destinations[1].enabled).toBe(false);
    expect(out?.destinations[1].events).toBeUndefined();
  });
});

describe('normalizeServerConfig — webhook segment', () => {
  it('stays ABSENT when no webhook config is present (byte-identical)', () => {
    const cfg = normalizeServerConfig({ enabled: false, networkBinding: false, endpoints: [] });
    expect(cfg.webhook).toBeUndefined();
  });

  it('carries a valid webhook segment through', () => {
    const cfg = normalizeServerConfig({
      enabled: false,
      networkBinding: false,
      endpoints: [],
      webhook: { enabled: true, destinations: [{ id: 'd1', type: 'custom', url: 'https://x', enabled: true }] },
    });
    expect(cfg.webhook?.destinations).toHaveLength(1);
  });
});

describe('mergeServerConfig — webhook is layer-replaced', () => {
  it('a patch carrying webhook swaps the whole segment; omitting keeps current', () => {
    const base = normalizeServerConfig({
      enabled: false,
      networkBinding: false,
      endpoints: [],
      webhook: { enabled: true, destinations: [{ id: 'd1', type: 'custom', url: 'https://a', enabled: true }] },
    });
    // Omit webhook → current kept.
    const keep = mergeServerConfig(base, { enabled: true });
    expect(keep.webhook?.destinations[0].url).toBe('https://a');
    // Provide webhook → whole segment swapped.
    const swap = mergeServerConfig(base, {
      webhook: { enabled: true, destinations: [{ id: 'd2', type: 'feishu', url: 'https://b', enabled: true }] },
    });
    expect(swap.webhook?.destinations.map((d) => d.id)).toEqual(['d2']);
  });
});
