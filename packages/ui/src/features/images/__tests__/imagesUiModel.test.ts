import { describe, expect, it } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';

import {
  applyImageAccountSelection,
  imageAccountSelection,
} from '../ImagesSection';

const BASE_CONFIG = {
  account: { fallback: 'strict' },
} as ImagesServerConfig;

describe('Images account selection', () => {
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

});
