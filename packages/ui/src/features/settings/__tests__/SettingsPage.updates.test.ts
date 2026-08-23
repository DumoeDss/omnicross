// @vitest-environment jsdom

import React, { createElement } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateSnapshot } from '@/shared/tauri/update';

const mocks = vi.hoisted(() => ({
  desktop: true,
  status: null as UpdateSnapshot | null,
  getUiSettings: vi.fn(),
  setUiSettings: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('@/shared/tauri/uiSettings', () => ({
  isDesktop: () => mocks.desktop,
  getUiSettings: mocks.getUiSettings,
  setUiSettings: mocks.setUiSettings,
}));
vi.mock('@/shared/tauri/update', () => ({
  checkForUpdates: mocks.checkForUpdates,
  downloadUpdate: mocks.downloadUpdate,
  installUpdate: mocks.installUpdate,
}));
vi.mock('@/shared/state/useUpdateStatus', () => ({
  useUpdateStatus: () => mocks.status,
}));
vi.mock('@/shared/tauri/openExternal', () => ({ openExternal: mocks.openExternal }));
vi.mock('@/shared/state/LocaleContext', () => ({
  useTranslation: () => (key: string, values?: Record<string, unknown>) => {
    if (values?.version !== undefined) return `${key} ${values.version}`;
    if (values?.percent !== undefined) return `${key} ${values.percent}%`;
    return key;
  },
}));
vi.mock('@/i18n', () => ({
  default: { language: 'en', t: (key: string) => key },
  isLanguage: (value: string) => value === 'en',
  setLanguage: vi.fn(),
  SUPPORTED_LANGUAGES: [{ code: 'en', nativeName: 'English' }],
}));
vi.mock('@/components/ui/scroll-area', async () => {
  const ReactModule = await import('react');
  return { ScrollArea: ({ children }: React.PropsWithChildren) => ReactModule.createElement('div', null, children) };
});
vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) =>
      ReactModule.createElement('button', { type: 'button', onClick, disabled }, children),
  };
});
vi.mock('@/components/ui/setting-row', async () => {
  const ReactModule = await import('react');
  return {
    SettingRow: ({ children, label }: React.PropsWithChildren<{ label: string }>) =>
      ReactModule.createElement('label', { 'data-setting': label }, label, children),
  };
});
vi.mock('@/components/ui/switch', async () => {
  const ReactModule = await import('react');
  return {
    Switch: ({ checked, disabled, onCheckedChange }: {
      checked: boolean;
      disabled?: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => ReactModule.createElement('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onCheckedChange(event.currentTarget.checked),
    }),
  };
});
vi.mock('@/components/ui/select', async () => {
  const ReactModule = await import('react');
  return {
    Select: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
      ReactModule.createElement('select', {
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.currentTarget.value),
      }),
  };
});
vi.mock('../SettingsTabs', () => ({ SettingsTabs: () => null }));

import { SettingsPage } from '../SettingsPage';

const defaultSettings = {
  closeToTray: false,
  startMinimized: false,
  autoStart: false,
  autoDownloadUpdates: false,
  language: 'en',
};

const status = (patch: Partial<UpdateSnapshot>): UpdateSnapshot => ({
  state: 'idle',
  currentVersion: '1.0.0',
  autoDownloadUpdates: false,
  canInstall: false,
  ...patch,
});

let container: HTMLDivElement;
let root: Root;

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(createElement(SettingsPage));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')]
    .find((element) => element.textContent?.includes(label));
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.desktop = true;
  mocks.status = status({});
  for (const mock of [
    mocks.getUiSettings,
    mocks.setUiSettings,
    mocks.checkForUpdates,
    mocks.downloadUpdate,
    mocks.installUpdate,
    mocks.openExternal,
  ]) mock.mockReset();
  mocks.getUiSettings.mockResolvedValue(defaultSettings);
  mocks.setUiSettings.mockResolvedValue(true);
  mocks.checkForUpdates.mockResolvedValue(null);
  mocks.downloadUpdate.mockResolvedValue(null);
  mocks.installUpdate.mockResolvedValue(null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Settings General updater integration', () => {
  it('persists the automatic-download switch through the settings bridge', async () => {
    mocks.getUiSettings
      .mockResolvedValueOnce(defaultSettings)
      .mockResolvedValueOnce({ ...defaultSettings, autoDownloadUpdates: true });
    await renderPage();
    await vi.waitFor(() => expect(mocks.getUiSettings).toHaveBeenCalledTimes(1));
    const row = container.querySelector('[data-setting="updates.autoDownload"]');
    const toggle = row?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(toggle).not.toBeNull();
    await click(toggle!);
    await vi.waitFor(() => expect(mocks.setUiSettings).toHaveBeenCalledWith({ autoDownloadUpdates: true }));
  });

  it('hides updater controls in browser-served UI and invokes no update action', async () => {
    mocks.desktop = false;
    mocks.status = status({ state: 'ready', latestVersion: '1.1.0', canInstall: true });
    mocks.getUiSettings.mockResolvedValue(null);
    await renderPage();
    expect(container.textContent).not.toContain('updates.title');
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.installUpdate).not.toHaveBeenCalled();
  });

  it('routes check, download, install, and phase-specific retry actions', async () => {
    await renderPage();
    await click(button('updates.checkNow'));
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1);

    mocks.status = status({ state: 'available', latestVersion: '1.1.0', canInstall: true });
    await renderPage();
    await click(button('updates.download'));
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);

    mocks.status = status({ state: 'ready', latestVersion: '1.1.0', canInstall: true });
    await renderPage();
    await click(button('updates.installRestart'));
    expect(mocks.installUpdate).toHaveBeenCalledTimes(1);

    mocks.status = status({
      state: 'failed',
      error: { phase: 'check', message: 'check failed', retryable: true },
    });
    await renderPage();
    await click(button('updates.retry'));
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2);

    mocks.status = status({
      state: 'failed',
      error: { phase: 'download', message: 'download failed', retryable: true },
    });
    await renderPage();
    await click(button('updates.retry'));
    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('renders failure, progress, and ready states with their actions', async () => {
    mocks.status = status({
      state: 'failed',
      error: { phase: 'install', message: 'install failed safely', retryable: true },
    });
    await renderPage();
    expect(container.textContent).toContain('install failed safely');
    expect(button('updates.retry')).toBeTruthy();

    mocks.status = status({ state: 'downloading', latestVersion: '1.1.0', progressPercent: 42 });
    await renderPage();
    expect(container.textContent).toContain('updates.downloading 42%');
    expect(container.querySelector('[style*="42%"]')).not.toBeNull();

    mocks.status = status({ state: 'ready', latestVersion: '1.1.0', canInstall: true });
    await renderPage();
    expect(button('updates.installRestart')).toBeTruthy();
  });
});
