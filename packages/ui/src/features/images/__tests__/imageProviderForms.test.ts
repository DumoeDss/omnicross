// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';
import type { LLMProvider } from '@shared/llm-config';
import { AddAccountDialog } from '@/features/upstreams/AddAccountDialog';
import type { UseAccountsResult } from '@/features/accounts/hooks/useAccounts';
import { ImageProviderForm } from '../ImageProviderForm';
import { ImageProviderDialog } from '../ImageProviderDialog';
import { ImageProviderDetails } from '../ImageProviderDetails';
import { ImageProviderModels } from '../ImageProviderModels';
import { ImagesSection } from '../ImagesSection';
import { IMAGE_PROVIDER_TEMPLATES } from '../imageProviderTemplates';
import { ImageCredentialForm } from '../ImageCredentialForm';

const mocks = vi.hoisted(() => ({ getProviders: vi.fn(), updateProvider: vi.fn(), addProvider: vi.fn(), discoverModels: vi.fn() }));
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
  it('limits image account login to image-capable subscriptions and keeps the default picker unchanged', async () => {
    const accountsApi = { data: { accounts: ['codex', 'claude', 'antigravity', 'gemini'].map((providerId) => ({ providerId })), providerAccounts: {} } } as unknown as UseAccountsResult;
    await act(async () => root.render(React.createElement(AddAccountDialog, { open: true, onOpenChange: vi.fn(), accountsApi, providerIds: ['codex', 'antigravity'] })));
    const text = document.querySelector('[role="dialog"]')!.textContent;
    expect(text).toContain('accounts.provider.codex.title');
    expect(text).toContain('accounts.provider.antigravity.title');
    expect(text).not.toContain('accounts.provider.claude.title');
    expect(text).not.toContain('accounts.provider.gemini.title');
    await act(async () => root.render(React.createElement(AddAccountDialog, { open: true, onOpenChange: vi.fn(), accountsApi })));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('accounts.provider.claude.title');
  });

  it('creates an API instance and keeps the editor open on a failed save', async () => {
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Reload failed')).mockResolvedValue(undefined);
    const sources = await mocks.getProviders();
    await act(async () => root.render(React.createElement(ImageProviderForm, { config, sources, template: IMAGE_PROVIDER_TEMPLATES[0]!,
      busy: false, onUpdate, onCredentialsChanged: vi.fn(), onSaved: vi.fn(), onCancel: vi.fn() })));
    await change(container.querySelector('input[aria-label="images.api.instanceId"]')!, 'studio-images');
    await click('images.api.newCredentials');
    await click('images.api.selectSource');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="image-credential-source"] button')!.click(); });
    await click('Image credentials');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('images.models.request');
    await click('images.api.save');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Reload failed');
    expect(container.querySelector('[data-testid="image-provider-form"]')).not.toBeNull();
    await click('images.api.save');
    expect(onUpdate.mock.calls[1][0]).toMatchObject({
      defaultModel: 'gpt-image-2', models: config.models,
      providers: { 'studio-images': { sourceProviderId: 'image-key', protocol: 'openai-images', models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] } },
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses image templates and saves credentials without taking over routes or duplicating credentials on retry', async () => {
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Config failed')).mockResolvedValue(undefined);
    const onSaved = vi.fn();
    mocks.addProvider.mockResolvedValue({ success: true, provider: { id: 'created-image-key' } });
    await act(async () => root.render(React.createElement(ImageProviderDialog, { config, sources: [], busy: false,
      onUpdate, onCredentialsChanged: vi.fn(), onSaved, onClose: vi.fn() })));
    const picker = document.querySelector('[data-testid="image-provider-templates"]')!;
    expect(picker.querySelectorAll('[data-image-template]')).toHaveLength(7);
    expect(picker.textContent).toContain('gpt-image-2.5-sunburst');
    expect(picker.textContent).toContain('gemini-nano-banana-2.1');
    for (const chatService of ['Anthropic', 'DeepSeek', 'Claude Code', 'chat/completions']) expect(picker.textContent).not.toContain(chatService);
    await act(async () => { (picker.querySelector('[data-image-template="openai-images"]') as HTMLButtonElement).click(); });
    const url = document.querySelector<HTMLInputElement>('input[aria-label="images.api.baseUrl"]')!;
    expect(url.value).toBe('https://api.openai.com/v1');
    const key = document.querySelector<HTMLInputElement>('input[aria-label="images.api.apiKey"]')!;
    await change(key, 'test-image-key');
    await click('images.api.save');
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Config failed');
    expect(key.value).toBe('');
    await click('images.api.save');
    expect(mocks.addProvider).toHaveBeenCalledTimes(1);
    expect(mocks.addProvider.mock.calls[0][0]).toMatchObject({ category: 'other', models: [] });
    expect(onUpdate.mock.calls[1][0]).toMatchObject({ providers: { 'openai-images': { protocol: 'openai-images', sourceProviderId: 'created-image-key' } },
      models: { 'gpt-image-2': 'codex-subscription' } });
    expect(onUpdate.mock.calls[1][0].providers['openai-images'].modelMap).toBeUndefined();
    expect(onSaved).toHaveBeenCalledWith('openai-images');
  });

  it('stores overlapping provider models without taking ownership of subscription routes', async () => {
    const onUpdate = vi.fn();
    const imageConfig = { ...config, providers: { studio: { protocol: 'openai-images', sourceProviderId: 'image-key', models: ['gpt-image-2'] } } } as ImagesServerConfig;
    await act(async () => root.render(React.createElement(ImageProviderModels, { id: 'studio', config: imageConfig, busy: false, onUpdate })));
    expect(button('images.api.save').disabled).toBe(false);
    expect(mocks.addProvider).not.toHaveBeenCalled();
    await click('images.api.save');
    expect(onUpdate.mock.calls[0][0].models).toEqual(config.models);
    expect(onUpdate.mock.calls[0][0].providers.studio.models).toEqual(['gpt-image-2']);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('fetches image models after creation, retains drafts on error, and defaults to passing model ids through', async () => {
    const imageConfig = { ...config, providers: { studio: { protocol: 'openrouter', sourceProviderId: 'image-key', models: [] } } } as ImagesServerConfig;
    const onUpdate = vi.fn().mockRejectedValueOnce(new Error('Config failed')).mockResolvedValue(undefined);
    mocks.discoverModels.mockResolvedValueOnce({ success: false, models: [], error: 'No access' })
      .mockResolvedValueOnce({ success: true, models: [{ id: 'deepseek-chat' }, { id: 'google/gemini-nano-banana-2.1' }] });
    await act(async () => root.render(React.createElement(ImageProviderModels, { id: 'studio', config: imageConfig, busy: false, onUpdate })));
    await click('images.models.fetch');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('No access');
    await click('images.models.fetch');
    expect(mocks.discoverModels).toHaveBeenLastCalledWith('image-key', { forceRefresh: true });
    expect(container.querySelector('input[aria-label="images.models.request 1"]')?.getAttribute('value')).toBe('google/gemini-nano-banana-2.1');
    expect(container.textContent).not.toContain('deepseek-chat');
    await click('images.api.save');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Config failed');
    await click('images.api.save');
    expect(onUpdate.mock.calls[1][0].providers.studio.models).toEqual(['google/gemini-nano-banana-2.1']);
    expect(onUpdate.mock.calls[1][0].providers.studio.modelAliases).toEqual({});
    expect(onUpdate.mock.calls[1][0].models).toEqual(config.models);
  });

  it('selects an independent image provider for Codex and maps GPT names to NanoBanana', async () => {
    const imageConfig = { ...config, enabled: true, codex: { imageModel: 'gpt-image-2.5-sunburst', carrierModel: 'gpt-5.6-luna' },
      account: { fallback: 'strict' }, providers: { wave: { protocol: 'wavespeed', sourceProviderId: 'image-key', models: ['google/nano-banana-2.1/text-to-image'] } } } as ImagesServerConfig;
    const onUpdate = vi.fn();
    await act(async () => root.render(React.createElement(ImagesSection, { config: imageConfig, accounts: [], sources: await mocks.getProviders(), busy: false, onUpdate })));
    await act(async () => { document.getElementById('codex-image-provider')!.click(); });
    await click('Image credentials');
    expect(container.querySelector('[data-testid="codex-image-model-mapping"]')).not.toBeNull();
    expect(container.textContent).not.toContain('images.account.label');
    await click('images.api.save');
    expect(onUpdate.mock.calls[0][0]).toMatchObject({ defaultModel: 'gpt-image-2.5-sunburst', models: { 'gpt-image-2': 'wave', 'gpt-image-2.5-flare': 'wave', 'gpt-image-2.5-sunburst': 'wave' },
      providers: { wave: { modelMap: { 'gpt-image-2': 'google/nano-banana-2.1/text-to-image', 'gpt-image-2.5-sunburst': 'google/nano-banana-2.1/text-to-image' } } } });
    expect(onUpdate.mock.calls[0][0].codex).toEqual(imageConfig.codex);
  });

  it('edits and removes image instances without deleting shared credentials', async () => {
    const imageConfig = { ...config, providers: { studio: { protocol: 'openai-images', sourceProviderId: 'image-key', enabled: false, modelMap: { art: 'upstream/image' } } },
      models: { ...config.models, art: 'studio' }, aliases: { favorite: 'art' } } as ImagesServerConfig;
    const onUpdate = vi.fn();
    const onRemoved = vi.fn();
    await act(async () => root.render(React.createElement(ImageProviderDetails, { id: 'studio', config: imageConfig,
      sources: await mocks.getProviders(), busy: false, onUpdate, onRemoved, onCredentialsChanged: vi.fn() })));
    expect(container.querySelector('input[aria-label="images.models.upstream 1"]')?.getAttribute('value')).toBe('upstream/image');
    await change(container.querySelector('input[aria-label="images.models.upstream 1"]')!, 'upstream/new-image');
    await click('images.api.save');
    expect(onUpdate.mock.calls[0][0].providers.studio.modelMap).toEqual({ art: 'upstream/new-image' });
    await click('images.api.edit');
    expect(container.querySelector('textarea')).toBeNull();
    await click('images.api.save');
    expect(onUpdate.mock.calls[1][0].providers.studio.modelMap).toEqual({ art: 'upstream/image' });
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    await click('images.api.remove');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="dialog-confirm-ok-btn"]')!.click(); });
    expect(onUpdate.mock.calls[2][0]).toMatchObject({ providers: {}, models: { 'gpt-image-2': 'codex-subscription' }, aliases: {} });
    expect(onRemoved).toHaveBeenCalled();
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
