/**
 * uiSettings.ts — the renderer ⇄ Tauri bridge for desktop UI preferences
 * (tray behavior + startup + autostart). These are enforced natively, so they
 * only exist inside the Tauri shell; in a plain browser (`npm run dev`) the
 * getters return null and the setters no-op (the Settings page hides/disables
 * the desktop-only rows accordingly).
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

export interface UiSettings {
  closeToTray: boolean;
  startMinimized: boolean;
  language: string;
  autoStart: boolean;
}

/** True only inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** Read the persisted desktop settings (null outside Tauri / on error). */
export async function getUiSettings(): Promise<UiSettings | null> {
  if (!isDesktop()) return null;
  try {
    return await invoke<UiSettings>('get_ui_settings');
  } catch {
    return null;
  }
}

/** Apply a partial update natively. Returns false outside Tauri / on error. */
export async function setUiSettings(patch: Partial<UiSettings>): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    await invoke('set_ui_settings', { patch });
    return true;
  } catch {
    return false;
  }
}
