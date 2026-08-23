import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  desktop: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: unknown }) => void) | undefined,
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mocks.desktop,
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

import {
  checkForUpdates,
  ensureUpdateBridge,
  getUpdateSnapshot,
  resetUpdateBridgeForTests,
} from '../update';

const initial = {
  state: 'idle',
  currentVersion: '1.0.0',
  autoDownloadUpdates: false,
  canInstall: false,
} as const;

beforeEach(async () => {
  await resetUpdateBridgeForTests();
  mocks.desktop = true;
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
  mocks.unlisten.mockReset();
  mocks.eventHandler = undefined;
  mocks.listen.mockImplementation(async (_event, handler) => {
    mocks.eventHandler = handler;
    return mocks.unlisten;
  });
});

describe('desktop update bridge', () => {
  it('subscribes exactly once across StrictMode-style repeated initialization', async () => {
    mocks.invoke.mockResolvedValue(initial);
    await Promise.all([ensureUpdateBridge(), ensureUpdateBridge()]);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(getUpdateSnapshot()).toEqual(initial);
  });

  it('does not let a late initial snapshot overwrite a newer event', async () => {
    let resolveInitial!: (value: typeof initial) => void;
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { resolveInitial = resolve; }));
    const initializing = ensureUpdateBridge();
    await vi.waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const available = { ...initial, state: 'available' as const, latestVersion: '1.1.0', canInstall: true };
    mocks.eventHandler?.({ payload: available });
    resolveInitial(initial);
    await initializing;
    expect(getUpdateSnapshot()).toEqual(available);
  });

  it('normalizes command results into the same store', async () => {
    mocks.invoke.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, state: 'upToDate' });
    await ensureUpdateBridge();
    await checkForUpdates();
    expect(getUpdateSnapshot()?.state).toBe('upToDate');
  });

  it('is a safe no-op in browser-served UI', async () => {
    mocks.desktop = false;
    await ensureUpdateBridge();
    expect(await checkForUpdates()).toBeNull();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('quietly disables the bridge when native event registration is unavailable', async () => {
    mocks.listen.mockRejectedValueOnce(new Error('event permission unavailable'));
    await expect(ensureUpdateBridge()).resolves.toBeUndefined();
    expect(getUpdateSnapshot()).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
