import { describe, expect, it } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';

import {
  applyImageAccountSelection,
  formatImageBytes,
  imageAccountSelection,
} from '../ImagesSection';
import {
  effectiveKeyPermissions,
  toggleKeyPermission,
} from '../KeyManagementSection';

const BASE_CONFIG = {
  account: { fallback: 'strict' },
} as ImagesServerConfig;

describe('exact Images key permissions', () => {
  it('keeps legacy keys on the four text permissions without granting Images', () => {
    expect(effectiveKeyPermissions(undefined)).toEqual([
      'chat',
      'responses',
      'messages',
      'gemini',
    ]);
  });

  it('preserves canonical ordering and treats Responses and Images independently', () => {
    const withImages = toggleKeyPermission(['responses'], 'images', true);
    expect(withImages).toEqual(['responses', 'images']);
    expect(toggleKeyPermission(withImages, 'responses', false)).toEqual(['images']);
    expect(toggleKeyPermission(['images'], 'responses', true)).toEqual(['responses', 'images']);
  });

  it('honors an explicit empty list as deny-all', () => {
    expect(effectiveKeyPermissions([])).toEqual([]);
    expect(toggleKeyPermission([], 'images', true)).toEqual(['images']);
  });
});

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
