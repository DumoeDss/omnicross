// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { protectedPost, viewingRequests, cancelViewingRequest } from '@/shared/keyViewing';
import { KeyViewingPrompt } from './KeyViewingPrompt';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/daemon/adminClient', () => ({ adminClient: mocks }));
vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.get.mockResolvedValue({ enabled: true });
  mocks.post.mockResolvedValue({ apiKey: 'fixture-secret' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<KeyViewingPrompt />));
});
afterEach(async () => { await act(async () => { cancelViewingRequest(); root.unmount(); }); container.remove(); });
async function enter(password: string) {
  await act(async () => Simulate.change(document.querySelector('input')!, { target: { value: password } } as never));
  await act(async () => Simulate.submit(document.querySelector('form')!));
}

it('prompts for each operation, retries errors and does not persist a password', async () => {
  let action!: Promise<unknown>;
  await act(async () => { action = protectedPost('/providers/a/reveal-key'); });
  expect(mocks.post).not.toHaveBeenCalled();
  mocks.post.mockRejectedValueOnce(new Error('view-password-invalid'));
  await enter('bad');
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('view-password-invalid');
  expect(document.querySelector('input')?.value).toBe('');
  await enter('viewing-password');
  expect(await action).toEqual({ apiKey: 'fixture-secret' });
  expect(viewingRequests.get()).toBeNull();
  await act(async () => { action = protectedPost('/providers/a/reveal-key'); });
  expect(document.querySelector('input')?.value).toBe('');
  const rejected = expect(action).rejects.toThrow('view-password-cancelled');
  await act(async () => window.dispatchEvent(new Event('blur')));
  await rejected;
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(localStorage.length).toBe(0);
});

it('ignores a successful response after cancellation during backend authentication', async () => {
  let finish!: (value: unknown) => void;
  mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let action!: Promise<unknown>;
  await act(async () => { action = protectedPost('/export', { passphrase: 'fixture-passphrase' }); });
  const rejected = expect(action).rejects.toThrow('view-password-cancelled');
  await enter('viewing-password');
  await act(async () => { cancelViewingRequest(); finish({ pack: 'fixture-pack' }); });
  await rejected;
  expect(viewingRequests.get()).toBeNull();
});

it('does not open a prompt when the native window loses focus while status is loading', async () => {
  let finish!: (value: { enabled: boolean }) => void;
  mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const action = protectedPost('/providers/a/reveal-key');
  const rejected = expect(action).rejects.toThrow('view-password-cancelled');
  await act(async () => { window.dispatchEvent(new Event('key-viewing-hide')); finish({ enabled: true }); });
  await rejected;
  expect(viewingRequests.get()).toBeNull(); expect(mocks.post).not.toHaveBeenCalled();
});
