import { describe, expect, it } from 'vitest';

import type { UpdateSnapshot } from '../../tauri/update';
import { updateActions } from '../updateModel';

const snapshot = (patch: Partial<UpdateSnapshot>): UpdateSnapshot => ({
  state: 'idle',
  currentVersion: '1.0.0',
  autoDownloadUpdates: false,
  canInstall: false,
  ...patch,
});

describe('updateActions', () => {
  it('maps available and ready snapshots to explicit actions', () => {
    expect(updateActions(snapshot({ state: 'available', canInstall: true })).canDownload).toBe(true);
    expect(updateActions(snapshot({ state: 'ready', canInstall: true })).canInstall).toBe(true);
  });

  it('never shows a startup/manual check failure in the app-wide banner', () => {
    const actions = updateActions(snapshot({
      state: 'failed',
      error: { phase: 'check', message: 'unavailable', retryable: true },
    }));
    expect(actions.canRetry).toBe(true);
    expect(actions.showAppBanner).toBe(false);
  });

  it('shows requested download/install failures non-modally', () => {
    for (const phase of ['download', 'install'] as const) {
      const actions = updateActions(snapshot({
        state: 'failed',
        releaseUrl: 'https://github.com/Dumoedss/omnicross/releases/latest',
        error: { phase, message: 'failed', retryable: true },
      }));
      expect(actions.showAppBanner).toBe(true);
      expect(actions.canRetry).toBe(true);
      expect(actions.canOpenRelease).toBe(true);
    }
  });

  it('keeps busy operations single-action and accepts final progress', () => {
    const downloading = updateActions(snapshot({ state: 'downloading', progressPercent: 42 }));
    expect(downloading.canCheck).toBe(false);
    expect(downloading.canDownload).toBe(false);
    expect(updateActions(snapshot({ state: 'ready', progressPercent: 100, canInstall: true })).canInstall).toBe(true);
  });
});
