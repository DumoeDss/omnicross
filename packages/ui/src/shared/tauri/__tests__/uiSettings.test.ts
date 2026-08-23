import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mocks.desktop,
  invoke: mocks.invoke,
}));

import { getUiSettings, setUiSettings } from '../uiSettings';

beforeEach(() => {
  mocks.desktop = true;
  mocks.invoke.mockReset();
});

describe('autoDownloadUpdates settings bridge', () => {
  it('round-trips the persistent desktop field and sends a partial patch', async () => {
    mocks.invoke.mockResolvedValue({
      closeToTray: false,
      startMinimized: false,
      language: 'en',
      autoStart: false,
      autoDownloadUpdates: true,
    });
    expect((await getUiSettings())?.autoDownloadUpdates).toBe(true);
    expect(await setUiSettings({ autoDownloadUpdates: false })).toBe(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith('set_ui_settings', {
      patch: { autoDownloadUpdates: false },
    });
  });

  it('does not invoke native settings commands in a browser', async () => {
    mocks.desktop = false;
    expect(await getUiSettings()).toBeNull();
    expect(await setUiSettings({ autoDownloadUpdates: true })).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
