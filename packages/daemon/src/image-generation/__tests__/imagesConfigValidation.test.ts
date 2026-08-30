import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_IMAGES_SERVER_CONFIG } from '@omnicross/core/outbound-api';

import { validateImagesAdminConfig } from '../imagesConfigValidation';

function config(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_IMAGES_SERVER_CONFIG)) as Record<string, unknown>;
}

describe('validateImagesAdminConfig', () => {
  it('requires an actually composed hardened resolver before enabling remote URLs', () => {
    const value = config();
    value['remote'] = { enabled: true };
    expect(validateImagesAdminConfig(value).join('\n')).toMatch(/proven composed remote resolver/);
    expect(validateImagesAdminConfig(value, { remoteResolverAvailable: true })).toEqual([]);
  });

  it('rejects relative, broad, and detected-worktree storage roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-images-config-'));
    try {
      const relativeValue = config();
      (relativeValue['references'] as Record<string, unknown>)['storageRoot'] = 'relative/images';
      expect(validateImagesAdminConfig(relativeValue).join('\n')).toMatch(/absolute path/);

      const broadValue = config();
      (broadValue['references'] as Record<string, unknown>)['storageRoot'] = dir;
      expect(validateImagesAdminConfig(broadValue, { processDirectory: join(dir, 'workspace') }).join('\n'))
        .toMatch(/too broad/);

      const worktree = join(dir, 'repo');
      mkdirSync(join(worktree, '.git'), { recursive: true });
      const worktreeValue = config();
      (worktreeValue['references'] as Record<string, unknown>)['storageRoot'] =
        join(worktree, 'private-images');
      expect(validateImagesAdminConfig(worktreeValue).join('\n')).toMatch(/outside every detected worktree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a storage root that traverses an existing directory symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-images-config-'));
    try {
      const actual = join(dir, 'actual');
      const linked = join(dir, 'linked');
      mkdirSync(actual);
      symlinkSync(actual, linked, 'junction');
      writeFileSync(join(actual, 'sentinel'), 'safe', 'utf8');
      const value = config();
      (value['references'] as Record<string, unknown>)['storageRoot'] = join(linked, 'images');
      expect(validateImagesAdminConfig(value).join('\n')).toMatch(/symbolic link/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
