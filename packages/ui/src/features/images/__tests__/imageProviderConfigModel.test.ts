import { describe, expect, it } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';
import { CODEX_IMAGE_MODELS, configureCodexImageRoute, imageProviderModels, preferredImageModel, moveImageRoute, removeImageInstance, saveImageProvider, saveImageProviderModels, saveImageInstance, saveImageAliases } from '../imageProviderConfigModel';

const config = { models: { 'gpt-image-2': 'codex-subscription' }, defaultModel: 'gpt-image-2', aliases: {}, providers: {} } as unknown as ImagesServerConfig;
const instance = { protocol: 'openrouter' as const, sourceProviderId: 'stored-key' };
describe('image provider settings', () => {
  it('saves a provider and its template catalog without changing the active routes', () => {
    const next = saveImageProvider(config, 'wave', { ...instance, models: ['openai/gpt-image-2.5-sunburst/text-to-image'] });
    expect(next.models).toBe(config.models);
    expect(next.defaultModel).toBe(config.defaultModel);
    expect(next.providers?.wave?.modelMap).toBeUndefined();
    expect(imageProviderModels(next, 'wave')).toEqual(['openai/gpt-image-2.5-sunburst/text-to-image']);
  });
  it('passes through namespaced model ids unless an explicit mapping is provided', () => {
    const model = 'google/gemini-nano-banana-2.1';
    const next = saveImageInstance(config, 'studio', instance, model);
    expect(next.models[model]).toBe('studio');
    expect(next.providers?.studio?.modelMap?.[model]).toBe(model);
  });
  it('keeps overlapping catalogs and optional aliases independent until a provider is selected', () => {
    const first = saveImageProvider(config, 'one', instance);
    const second = saveImageProvider(first, 'two', instance);
    const rows = [{ model: 'gpt-image-2', upstream: 'google/gemini-nano-banana-2.1' }];
    const declared = saveImageProviderModels(saveImageProviderModels(second, 'one', rows), 'two', rows);
    expect(declared.models).toEqual(config.models);
    expect(declared.providers?.one?.modelAliases).toEqual(declared.providers?.two?.modelAliases);
    const selected = configureCodexImageRoute(declared, 'two', rows[0]!.upstream);
    expect(selected.models['gpt-image-2']).toBe('two');
    expect(selected.providers?.two?.modelMap?.['gpt-image-2']).toBe(rows[0]!.upstream);
    expect(selected.providers?.one?.modelAliases).toEqual({ 'gpt-image-2': rows[0]!.upstream });
  });
  it('routes every Codex image request to an independent API with explicit per-model overrides', () => {
    const catalog = ['openai/gpt-image-2.5-sunburst/text-to-image', 'google/nano-banana-2.1/text-to-image'];
    const saved = saveImageProvider(config, 'wave', { protocol: 'wavespeed', sourceProviderId: 'wave-key', models: catalog });
    const next = configureCodexImageRoute(saved, 'wave', catalog[0]!, { 'gpt-image-2.5-flare': catalog[1]! });
    for (const model of CODEX_IMAGE_MODELS) expect(next.models[model]).toBe('wave');
    expect(next.providers?.wave?.modelMap).toMatchObject({ 'gpt-image-2': catalog[0], 'gpt-image-2.5-flare': catalog[1], 'gpt-image-2.5-sunburst': catalog[0], [catalog[0]!]: catalog[0] });
    expect(next.models[catalog[0]!]).toBe('wave');
    expect(next.defaultModel).toBe('gpt-image-2.5-sunburst');
    expect(saved.models['gpt-image-2']).toBe('codex-subscription');
    expect(preferredImageModel(catalog)).toBe(catalog[0]);
    expect(preferredImageModel(['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'])).toBe('openai/gpt-image-2.5-sunburst');
  });
  it('preserves long upstream identifiers behind short public model names', () => {
    const upstream = 'vendor/' + 'x'.repeat(160);
    const next = saveImageInstance(config, 'api', instance, `art = ${upstream}`);
    expect(next.providers?.api?.models).toEqual([upstream]);
    expect(configureCodexImageRoute(next, 'api', upstream).providers?.api?.modelMap?.['gpt-image-2']).toBe(upstream);
  });
  it('maps Codex GPT image requests to NanoBanana and switches back to the native subscription', () => {
    const saved = saveImageProvider(config, 'banana', { ...instance, models: ['google/gemini-nano-banana-2.1'] });
    const mapped = configureCodexImageRoute(saved, 'banana', 'google/gemini-nano-banana-2.1');
    const native = configureCodexImageRoute(mapped, 'codex-subscription', 'gpt-image-2.5-sunburst');
    for (const model of CODEX_IMAGE_MODELS) expect(native.models[model]).toBe('codex-subscription');
    for (const model of CODEX_IMAGE_MODELS) expect(native.providers?.banana?.modelMap).not.toHaveProperty(model);
    expect(native.providers?.banana?.modelMap).toEqual({ 'google/gemini-nano-banana-2.1': 'google/gemini-nano-banana-2.1' });
    expect(native.codex.imageModel).toBe('gpt-image-2.5-sunburst');
  });
  it('maps requests to native Antigravity models through aliases, and cleans aliases on a subsequent switch', () => {
    const mapped = configureCodexImageRoute({ ...config, aliases: { favorite: 'gpt-image-2' } }, 'antigravity-subscription', 'gemini-nano-banana-2.1');
    expect(mapped.defaultModel).toBe('gemini-nano-banana-2.1');
    expect(mapped.models['gemini-nano-banana-2.1']).toBe('antigravity-subscription');
    expect(mapped.aliases.favorite).toBe('gemini-nano-banana-2.1');
    for (const model of CODEX_IMAGE_MODELS) {
      expect(mapped.models[model]).toBeUndefined();
      expect(mapped.aliases[model]).toBe('gemini-nano-banana-2.1');
    }
    const native = configureCodexImageRoute(mapped, 'codex-subscription', 'gpt-image-2.5-flare');
    for (const model of CODEX_IMAGE_MODELS) expect(native.aliases[model]).toBeUndefined();
  });
  it('saves aliases only to existing routes and rejects cycles and collisions', () => {
    expect(saveImageAliases(config, 'favorite = gpt-image-2').aliases).toEqual({ favorite: 'gpt-image-2' });
    expect(() => saveImageAliases(config, 'favorite = missing')).toThrow('invalidAliases');
    expect(() => saveImageAliases(config, 'favorite = favorite')).toThrow('invalidAliases');
    expect(() => saveImageAliases(config, 'gpt-image-2 = gpt-image-2')).toThrow('invalidAliases');
  });
  it('keeps upstream slashes in mappings while public routes remain compatible', () => {
    const next = saveImageInstance(config, 'my-images', instance, 'banana = google/gemini-nano-banana-2.1');
    expect(next.models).toEqual({ 'gpt-image-2': 'codex-subscription', banana: 'my-images' });
    expect(next.providers?.['my-images']?.modelMap).toEqual({ banana: 'google/gemini-nano-banana-2.1' });
    expect(config.models).toEqual({ 'gpt-image-2': 'codex-subscription' });
  });
  it('protects existing routes and rejects ambiguous duplicate models', () => {
    expect(() => saveImageInstance(config, 'my-images', instance, 'gpt-image-2')).toThrow('routeConflict');
    expect(() => saveImageInstance(config, 'my-images', instance, 'banana\nbanana')).toThrow('invalidModels');
    expect(() => saveImageInstance(config, 'codex-subscription', instance, 'banana')).toThrow('invalidInstance');
  });
  it('repairs defaults and aliases when removing an instance', () => {
    const next = saveImageInstance(config, 'my-images', instance, 'banana');
    const removed = removeImageInstance({ ...next, defaultModel: 'banana', aliases: { favorite: 'banana' } }, 'my-images');
    expect(removed.defaultModel).toBe('gpt-image-2');
    expect(removed.aliases).toEqual({});
    expect(removed.providers).toEqual({});
  });
  it('reassigns routes only with consent and cleans previous instance mappings', () => {
    const previous = saveImageInstance(config, 'old-images', instance, 'banana = old/banana\nkeep = old/keep');
    const next = saveImageInstance(previous, 'new-images', instance, 'banana = new/banana\ngpt-image-2', { replaceExistingRoutes: true });
    expect(next.models).toEqual({ 'gpt-image-2': 'new-images', banana: 'new-images', keep: 'old-images' });
    expect(next.providers?.['old-images']?.modelMap).toEqual({ keep: 'old/keep' });
    expect(next.providers?.['new-images']?.modelMap).toEqual({ banana: 'new/banana', 'gpt-image-2': 'gpt-image-2' });
    expect(previous.providers?.['old-images']?.modelMap?.banana).toBe('old/banana');
  });
  it('removes obsolete mappings when a model is reassigned', () => {
    const next = saveImageInstance(config, 'my-images', instance, 'banana = google/gemini-nano-banana-2.1');
    const moved = moveImageRoute(next, 'banana', 'antigravity-subscription');
    expect(moved.models.banana).toBe('antigravity-subscription');
    expect(moved.providers?.['my-images']?.modelMap).toEqual({});
  });
});
