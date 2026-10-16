import { describe, expect, it } from 'vitest';

import type { ImagesServerConfig } from '@/daemon/types';
import { moveImageRoute, removeImageInstance, saveImageInstance, saveImageAliases } from '../imageProviderConfigModel';

const config = { models: { 'gpt-image-2': 'codex-subscription' }, defaultModel: 'gpt-image-2', aliases: {}, providers: {} } as unknown as ImagesServerConfig;
const instance = { protocol: 'openrouter' as const, sourceProviderId: 'stored-key' };
describe('image provider settings', () => {
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
  it('removes obsolete mappings when a model is reassigned', () => {
    const next = saveImageInstance(config, 'my-images', instance, 'banana = google/gemini-nano-banana-2.1');
    const moved = moveImageRoute(next, 'banana', 'antigravity-subscription');
    expect(moved.models.banana).toBe('antigravity-subscription');
    expect(moved.providers?.['my-images']?.modelMap).toEqual({});
  });
});
