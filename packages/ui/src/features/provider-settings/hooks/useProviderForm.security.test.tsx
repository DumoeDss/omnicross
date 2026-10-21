// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '@shared/llm-config';
import { ProviderDetails } from '../ProviderDetails';
import { useProviderForm } from './useProviderForm';

const mocks = vi.hoisted(() => ({ revealProviderKey: vi.fn(), updateProvider: vi.fn(), getKeyHealth: vi.fn() }));
vi.mock('@/shared/agent', () => ({ agent: { llmConfig: mocks } }));
vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/shared/keyViewing', () => ({ cancelViewingRequest: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let form: ReturnType<typeof useProviderForm>;
const updateCache = vi.fn();
const providers = ['a', 'b'].map((id) => ({ id, name: id, apiFormat: 'openai', api_base_url: `https://${id}.invalid`, hasKey: true, api_key: '', models: [], enabled: true } as LLMProvider));
const noop = () => {};
const done = async () => {};
function Harness({ selected }: { selected: LLMProvider | null }) {
  form = useProviderForm(providers, selected?.id ?? null, noop, selected, done, updateCache, false, noop);
  return <ProviderDetails {...form} selectedProvider={selected} visibleModelGroups={[]}
    onInlineUpdate={form.handleInlineUpdate} onRevealApiKey={form.revealApiKey} onCopyApiKey={form.copyApiKey}
    modelStatus={null} modelSearch="" setModelSearch={noop} collapsedGroups={{}} toggleGroupCollapse={noop}
    editingModel={null} setEditingModel={noop} onToggleProvider={done} onToggleOfficial={done} onDeleteProvider={done}
    onShowManageModels={noop} onShowAddModelDialog={noop} onApplyModelEdit={done} onToggleModelEnabled={done}
    onSetModelsEnabled={done} onRemoveModel={done} onShowEditModelDialog={noop} />;
}
async function select(selected: LLMProvider | null) { await act(async () => root.render(<Harness selected={selected} />)); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  mocks.revealProviderKey.mockResolvedValue({ success: true, apiKey: 'fixture-secret' });
  mocks.updateProvider.mockResolvedValue({ success: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('provider key isolation', () => {
  it.each([false, undefined])('protects eye-button reveals when hasKey is %s', async (hasKey) => {
    let finish!: (value: unknown) => void;
    mocks.revealProviderKey.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await select({ ...providers[0], hasKey });

    await act(async () => Simulate.click(container.querySelector('button[aria-label="Show"]')!));
    expect(mocks.revealProviderKey).toHaveBeenCalledWith(providers[0].id);
    expect(form.inlineApiKey).toBe('');
    expect(form.showApiKey).toBe(false);

    await act(async () => finish({ success: true, apiKey: 'fixture-secret' }));
    expect(form.inlineApiKey).toBe('fixture-secret');
    expect(form.showApiKey).toBe(true);
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(updateCache).not.toHaveBeenCalled();

    const input = container.querySelector<HTMLInputElement>('input[value="fixture-secret"]')!;
    const preventDefault = vi.fn();
    await act(async () => Simulate.copy(input, { preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    expect(mocks.revealProviderKey).toHaveBeenCalledTimes(2);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('fixture-secret');

    await act(async () => Simulate.click(container.querySelector('button[aria-label="Hide"]')!));
    mocks.revealProviderKey.mockResolvedValueOnce({ success: false, message: 'view-password-cancelled' });
    await act(async () => Simulate.click(container.querySelector('button[aria-label="Show"]')!));
    expect(mocks.revealProviderKey).toHaveBeenCalledTimes(3);
    expect(form.inlineApiKey).toBe('');
    expect(form.showApiKey).toBe(false);
  });

  it('toggles a newly typed key locally without fetching the stored key', async () => {
    await select({ ...providers[0], hasKey: false });
    await act(async () => form.setInlineApiKey('draft-key'));

    await act(async () => Simulate.click(container.querySelector('button[aria-label="Show"]')!));
    expect(form.inlineApiKey).toBe('draft-key');
    expect(form.showApiKey).toBe(true);
    expect(mocks.revealProviderKey).not.toHaveBeenCalled();

    await act(async () => Simulate.click(container.querySelector('button[aria-label="Hide"]')!));
    expect(form.inlineApiKey).toBe('draft-key');
    expect(form.showApiKey).toBe(false);
  });

  it('clears drafts, visibility and edit state on provider and API-mode changes', async () => {
    await select(providers[0]);
    await act(async () => { form.setInlineApiKey('draft-key'); form.setShowApiKey(true); form.handleEditProvider(); form.setShowApiKey(true); });
    await select(providers[1]);
    expect(form.inlineApiKey).toBe(''); expect(form.showApiKey).toBe(false); expect(form.isEditing).toBe(false);
    await act(async () => { form.setInlineApiKey('second-draft'); form.setShowApiKey(true); });
    await select({ ...providers[1], selectedApiModeId: 'another-mode' });
    expect(form.inlineApiKey).toBe(''); expect(form.showApiKey).toBe(false);
    await select(null); expect(form.inlineApiKey).toBe('');
  });

  it('ignores a delayed A response after A → B → A and edits during authentication', async () => {
    let finish!: (value: unknown) => void;
    mocks.revealProviderKey.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await select(providers[0]);
    let pending!: Promise<void>;
    await act(async () => { pending = form.revealApiKey(); });
    await select(providers[1]); await select(providers[0]);
    await act(async () => { finish({ success: true, apiKey: 'stale-secret' }); await pending; });
    expect(form.inlineApiKey).toBe(''); expect(form.showApiKey).toBe(false);
    mocks.revealProviderKey.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { pending = form.revealApiKey(); });
    await act(async () => form.setInlineApiKey('new-draft'));
    await act(async () => { finish({ success: true, apiKey: 'stale-secret' }); await pending; });
    expect(form.inlineApiKey).toBe('new-draft');
  });

  it('keeps revealed values out of writes/cache, hides on timeout/blur and verifies native copy again', async () => {
    await select(providers[0]);
    await act(async () => form.revealApiKey());
    expect(form.inlineApiKey).toBe('fixture-secret'); expect(form.showApiKey).toBe(true);
    expect(updateCache).not.toHaveBeenCalled();
    await act(async () => form.handleInlineUpdate('api_key', 'fixture-secret'));
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    const input = container.querySelector<HTMLInputElement>('input[value="fixture-secret"]')!;
    const preventDefault = vi.fn();
    await act(async () => Simulate.copy(input, { preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    expect(mocks.revealProviderKey).toHaveBeenCalledTimes(2);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('fixture-secret');
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(form.inlineApiKey).toBe(''); expect(form.showApiKey).toBe(false);
    await act(async () => form.revealApiKey());
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(form.inlineApiKey).toBe(''); expect(form.showApiKey).toBe(false);
  });

  it('drops a saved replacement without caching it and preserves a later draft', async () => {
    await select(providers[0]);
    await act(async () => form.setInlineApiKey('replacement'));
    await act(async () => form.handleInlineUpdate('api_key', 'replacement'));
    expect(form.inlineApiKey).toBe('');
    expect(updateCache.mock.calls[0][0].api_key).toBe('');
    expect(updateCache.mock.calls[0][0].hasKey).toBe(true);
  });
});
