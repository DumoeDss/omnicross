import { describe, expect, it } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';

import {
  applyImageAccountSelection,
  applyImageCodexOverrides,
  formatImageBytes,
  imageAccountSelection,
  imageRouteEntries,
  UI_DEFAULT_CODEX_CARRIER_MODEL,
  UI_DEFAULT_CODEX_IMAGE_MODEL,
} from '../ImagesSection';

const BASE_CONFIG = {
  account: { fallback: 'strict' },
} as ImagesServerConfig;

describe('Images account and resource display helpers', () => {
  it('selects exactly one fixed account or group and preserves fallback policy', () => {
    const fixed = applyImageAccountSelection(BASE_CONFIG, 'account:local-account-key');
    expect(fixed.account).toEqual({ id: 'local-account-key', fallback: 'strict' });
    expect(fixed.account).not.toHaveProperty('group');
    expect(imageAccountSelection(fixed)).toBe('account:local-account-key');

    const grouped = applyImageAccountSelection(fixed, 'group:creative');
    expect(grouped.account).toEqual({ group: 'creative', fallback: 'strict' });
    expect(grouped.account).not.toHaveProperty('id');
    expect(imageAccountSelection(grouped)).toBe('group:creative');

    expect(applyImageAccountSelection(grouped, 'pool').account).toEqual({ fallback: 'strict' });
  });

  it('formats byte counts deterministically and clamps invalid input', () => {
    expect(formatImageBytes(Number.NaN)).toBe('0 B');
    expect(formatImageBytes(-1)).toBe('0 B');
    expect(formatImageBytes(512)).toBe('512 B');
    expect(formatImageBytes(1536)).toBe('1.5 KiB');
    expect(formatImageBytes(2.5 * 1024 * 1024)).toBe('2.5 MiB');
  });
});

describe('Images routing-table and Codex override helpers', () => {
  const ROUTED: ImagesServerConfig = {
    ...BASE_CONFIG,
    defaultModel: 'gpt-image-2',
    models: {
      'gpt-image-2': 'codex-subscription',
      'gpt-image-2-5': 'codex-subscription',
      'gemini-3-pro-image-preview': 'antigravity-subscription',
    },
    codex: { imageModel: 'gpt-image-2', carrierModel: 'gpt-5.6-luna' },
  } as ImagesServerConfig;

  it('orders route entries default-first then alphabetical', () => {
    expect(imageRouteEntries(ROUTED).map((entry) => entry.model)).toEqual([
      'gpt-image-2',
      'gemini-3-pro-image-preview',
      'gpt-image-2-5',
    ]);
    expect(imageRouteEntries(ROUTED)[1].provider).toBe('antigravity-subscription');
  });

  it('restores the pinned wire defaults when overrides are blanked', () => {
    const overridden = applyImageCodexOverrides(ROUTED, {
      imageModel: 'gpt-image-2-5',
      carrierModel: 'gpt-6-orion',
    });
    expect(overridden.codex).toEqual({ imageModel: 'gpt-image-2-5', carrierModel: 'gpt-6-orion' });
    expect(applyImageCodexOverrides(overridden, { imageModel: '  ' }).codex.imageModel)
      .toBe(UI_DEFAULT_CODEX_IMAGE_MODEL);
    expect(applyImageCodexOverrides(overridden, { carrierModel: '' }).codex.carrierModel)
      .toBe(UI_DEFAULT_CODEX_CARRIER_MODEL);
    // Untouched segments ride along.
    expect(overridden.models).toBe(ROUTED.models);
  });
});
