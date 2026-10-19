import { getCurrentWindow } from '@tauri-apps/api/window';
import { isDesktop } from './uiSettings';

/** WebView focus can differ from native window activation (including minimize/tray). */
export async function listenKeyViewingFocus(): Promise<() => void> {
  if (!isDesktop()) return () => {};
  return getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) window.dispatchEvent(new Event('key-viewing-hide'));
  });
}
