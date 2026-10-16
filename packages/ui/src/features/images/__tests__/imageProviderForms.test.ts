// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';
import type { LLMProvider } from '@shared/llm-config';
import { ImageApiProvidersPanel } from '../ImageApiProvidersPanel';
import { ImageCredentialForm } from '../ImageCredentialForm';

const mocks = vi.hoisted(() => ({ getProviders: vi.fn(), updateProvider: vi.fn(), addProvider: vi.fn() }));
vi.mock('@/shared/agent', () => ({ agent: { llmConfig: mocks } }));
vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));

let root: Root;
let container: HTMLDivElement;
const config = { models: { 'gpt-image-2': 'codex-subscription' }, defaultModel: 'gpt-image-2', aliases: {}, providers: {} } as unknown as ImagesServerConfig;
function button(text: string) {
  const match = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Simulate.change(element, { target: { value } } as never); });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  mocks.getProviders.mockResolvedValue([{ id: 'image-key', name: 'Image credentials', models: [] }]);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('image provider forms', () => {
  it('creates an API instance and keeps the editor open on a failed save', async () => {
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Reload failed')).mockResolvedValue(undefined);
    await act(async () => root.render(React.createElement(ImageApiProvidersPanel, { config, busy: false, onUpdate })));
    expect(container.textContent).toContain('images.api.empty');
    await click('images.api.add');
    await change(container.querySelector('input')!, 'studio-images');
    await click('images.api.selectSource');
    await click('Image credentials');
    await change(container.querySelector('textarea')!, 'sunburst = gpt-image-2.5-sunburst');
    await click('images.api.save');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Reload failed');
    expect(container.querySelector('textarea')).not.toBeNull();
    await click('images.api.save');
    expect(onUpdate.mock.calls[1][0]).toMatchObject({
      defaultModel: 'gpt-image-2', models: { sunburst: 'studio-images' },
      providers: { 'studio-images': { sourceProviderId: 'image-key', protocol: 'openai-images', modelMap: { sunburst: 'gpt-image-2.5-sunburst' } } },
    });
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('edits the effective legacy endpoint without resending a blank secret', async () => {
    const source = { id: 'legacy', name: 'Saved', api_base_url: 'https://standard.example/v1',
      codingPlan: { enabled: true, baseUrl: 'https://plan.example/v1', hasApiKey: true }, models: [] } as unknown as LLMProvider;
    const onSaved = vi.fn();
    mocks.updateProvider.mockResolvedValue({ success: true, provider: source });
    await act(async () => root.render(React.createElement(ImageCredentialForm, { source, onSaved, onCancel: vi.fn() })));
    const inputs = container.querySelectorAll('input');
    expect(inputs[1].value).toBe('https://plan.example/v1');
    expect(inputs[2].value).toBe('');
    await change(inputs[1], 'https://images.example/v1');
    await click('images.api.save');
    expect(mocks.updateProvider.mock.calls[0][0]).toMatchObject({ codingPlan: { enabled: true, baseUrl: 'https://images.example/v1' } });
    expect(mocks.updateProvider.mock.calls[0][0].codingPlan).not.toHaveProperty('apiKey');
    expect(mocks.updateProvider.mock.calls[0][0]).not.toHaveProperty('api_key');
    expect(onSaved).toHaveBeenCalledWith('legacy');
  });
});
