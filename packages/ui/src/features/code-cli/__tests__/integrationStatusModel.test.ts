import { describe, expect, it } from 'vitest';

import {
  hasInstalledIntegration,
  hasRotationConflict,
  integrationStatusPresentation,
} from '../integrationStatusModel';

describe('persistent CLI integration status model', () => {
  it('offers installation only when no managed integration exists', () => {
    expect(integrationStatusPresentation('not-installed')).toMatchObject({
      canInstall: true,
      canRemove: false,
      needsAttention: false,
    });
    expect(integrationStatusPresentation('enabled')).toMatchObject({
      canInstall: false,
      canRemove: true,
      needsAttention: false,
    });
  });

  it('locks destructive actions when managed configuration drifted', () => {
    expect(integrationStatusPresentation('configuration-drift')).toMatchObject({
      canInstall: false,
      canRepair: true,
      canRemove: false,
      needsAttention: true,
      protectsUserChanges: true,
      badgeVariant: 'destructive',
    });
  });

  it('keeps recovery paths available for missing configuration or key state', () => {
    expect(integrationStatusPresentation('configuration-missing').canRepair).toBe(true);
    expect(integrationStatusPresentation('configuration-missing').canRemove).toBe(true);
    expect(integrationStatusPresentation('key-missing').canRepair).toBe(false);
    expect(integrationStatusPresentation('key-missing').canRemove).toBe(true);
  });

  it('enables shared-key rotation only for an installed, drift-free set', () => {
    expect(hasInstalledIntegration([{ status: 'not-installed' }, { status: 'not-installed' }])).toBe(false);
    expect(hasInstalledIntegration([{ status: 'enabled' }, { status: 'not-installed' }])).toBe(true);
    expect(hasRotationConflict([{ status: 'enabled' }, { status: 'configuration-drift' }])).toBe(true);
    expect(hasRotationConflict([{ status: 'key-missing' }, { status: 'enabled' }])).toBe(false);
  });
});
