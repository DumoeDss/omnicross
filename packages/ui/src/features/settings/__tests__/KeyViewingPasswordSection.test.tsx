// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeyViewingPasswordSection } from '../KeyViewingPasswordSection';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('@/daemon/adminClient', () => ({ adminClient: mocks }));
vi.mock('@/shared/keyViewing', () => ({ cancelViewingRequest: vi.fn() }));
vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.put.mockResolvedValue({ ok: true });
  mocks.get.mockResolvedValue({ enabled: false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function button(key: string) { return [...container.querySelectorAll('button')].find((node) => node.textContent === key)!; }
async function change(index: number, value: string) {
  await act(async () => Simulate.change(container.querySelectorAll('input[type="password"]')[index], { target: { value } } as never));
}
it('sets a password with confirmation and clears password inputs after saving', async () => {
  await act(async () => root.render(<KeyViewingPasswordSection />));
  await change(0, 'view'); await change(1, 'diff');
  expect(button('keyViewing.setup').disabled).toBe(true);
  await change(1, 'view');
  await act(async () => Simulate.submit(container.querySelector('form')!));
  expect(mocks.put).toHaveBeenCalledWith('/key-viewing-password', { currentPassword: '', newPassword: 'view' });
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="password"]')].every((node) => node.value === '')).toBe(true);
  expect(button('keyViewing.disable').disabled).toBe(true);
  expect(mocks.get).toHaveBeenCalledOnce();
});

it('requires the current password for disabling and explicit confirmation for destructive recovery', async () => {
  mocks.get.mockResolvedValue({ enabled: true });
  await act(async () => root.render(<KeyViewingPasswordSection />));
  expect(button('keyViewing.disable').disabled).toBe(true);
  await change(0, 'curr');
  await act(async () => button('keyViewing.disable').click());
  expect(mocks.put).toHaveBeenCalledWith('/key-viewing-password', { currentPassword: 'curr', newPassword: null });
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<KeyViewingPasswordSection />));
  await act(async () => button('keyViewing.forgot').click());
  await change(0, 'repl'); await change(1, 'repl');
  expect(button('keyViewing.reset').disabled).toBe(true);
  mocks.post.mockRejectedValueOnce(new Error('fixture-recovery-failure'));
  await act(async () => Simulate.change(container.querySelector('input[type="checkbox"]')!, { target: { checked: true } } as never));
  await act(async () => Simulate.submit(container.querySelector('form')!));
  expect(mocks.post).toHaveBeenCalledWith('/key-viewing-password/reset', { newPassword: 'repl', confirmClearCredentials: true });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('fixture-recovery-failure');
});
