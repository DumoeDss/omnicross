// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { listenKeyViewingFocus } from './keyViewingFocus';

const mocks = vi.hoisted(() => ({ desktop: true, subscribe: vi.fn() }));
vi.mock('./uiSettings', () => ({ isDesktop: () => mocks.desktop }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: mocks.subscribe }) }));

it('forwards native focus loss and skips browser-only contexts', async () => {
  let receive!: (event: { payload: boolean }) => void;
  const unsubscribe = vi.fn();
  mocks.subscribe.mockImplementation(async (callback) => { receive = callback; return unsubscribe; });
  const hidden = vi.fn();
  window.addEventListener('key-viewing-hide', hidden);
  const stop = await listenKeyViewingFocus();
  receive({ payload: true }); expect(hidden).not.toHaveBeenCalled();
  receive({ payload: false }); expect(hidden).toHaveBeenCalledTimes(1);
  stop(); expect(unsubscribe).toHaveBeenCalledOnce();
  mocks.desktop = false;
  await listenKeyViewingFocus(); expect(mocks.subscribe).toHaveBeenCalledOnce();
  window.removeEventListener('key-viewing-hide', hidden);
});
