/**
 * preset-map.test.ts — pure preset → daemon-row mapping assertions (design
 * D1/D2/D3/D6). Mirrors `ccr-import.test.ts`.
 *
 * Asserts: catalog resolves under vitest (the cross-runtime seam, D1), openai/
 * anthropic passthrough, google→gemini name translation, openai-response/
 * azure-openai exclusion with a reason, empty key → missingKey, id/baseUrl
 * overrides, and exhaustive FORMAT_MAP coverage of every apiFormat in the catalog.
 */

import { describe, expect, it } from 'vitest';

import { getCatalog, getPresetById } from '../preset-catalog';
import {
  FORMAT_MAP,
  listMappablePresets,
  mapPresetToProvider,
  type PresetApiFormat,
} from '../preset-map';

describe('preset-catalog seam (D1 — vitest runtime)', () => {
  it('resolves a non-empty catalog (> 20 presets)', () => {
    const all = getCatalog();
    expect(all.length).toBeGreaterThan(20);
    expect(getPresetById('openai')?.id).toBe('openai');
  });
});

describe('preset → daemon-row mapping', () => {
  it('passes through an openai preset', () => {
    const preset = getPresetById('openai')!;
    const r = mapPresetToProvider(preset, { key: 'sk-x' });
    expect('provider' in r).toBe(true);
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.apiFormat).toBe('openai');
    expect(r.provider.baseUrl).toBe(preset.api_base_url);
    expect(r.provider.apiKey).toBe('sk-x');
    expect(r.provider.models).toEqual(preset.models);
  });

  it('passes through an anthropic preset', () => {
    const preset = getPresetById('anthropic')!;
    const r = mapPresetToProvider(preset, { key: 'sk-ant' });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.apiFormat).toBe('anthropic');
  });

  it('translates a google preset to gemini (D3)', () => {
    const preset = getPresetById('gemini')!;
    expect(preset.apiFormat).toBe('google'); // preset uses the wide union value
    const r = mapPresetToProvider(preset, { key: 'AIza-x' });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.apiFormat).toBe('gemini'); // narrowed, NOT 'google'
  });

  it('maps openai-response to the openai-response daemon format', () => {
    const preset = getPresetById('openai-response')!;
    const r = mapPresetToProvider(preset, { key: 'sk-x' });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.apiFormat).toBe('openai-response');
  });

  it('maps the OpenRouter Responses preset to its native Responses endpoint', () => {
    const preset = getPresetById('openrouter-response')!;
    expect(preset.apiFormat).toBe('openai-response');
    expect(preset.api_base_url).toBe('https://openrouter.ai/api/v1');
    const r = mapPresetToProvider(preset, { key: 'sk-or-x' });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider).toMatchObject({
      id: 'openrouter-response',
      apiFormat: 'openai-response',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-x',
    });
  });

  it('excludes azure-openai with a reason', () => {
    const preset = getPresetById('azure-openai')!;
    const r = mapPresetToProvider(preset, { key: 'sk-x' });
    if (!('excluded' in r)) throw new Error('expected excluded');
    expect(r.excluded.reason).toMatch(/azure/i);
  });

  it('reports missingKey when the caller supplies no key', () => {
    const preset = getPresetById('openai')!;
    const r = mapPresetToProvider(preset, { key: '' });
    expect(r).toEqual({ missingKey: true });
  });

  it('honors id and baseUrl overrides', () => {
    const preset = getPresetById('openai')!;
    const r = mapPresetToProvider(preset, {
      key: 'sk-x',
      id: 'my-openai',
      baseUrlOverride: 'https://proxy/v1',
    });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.id).toBe('my-openai');
    expect(r.provider.baseUrl).toBe('https://proxy/v1');
  });

  it('never sources apiKey from the preset (preset has none)', () => {
    const preset = getPresetById('openai')!;
    expect((preset as unknown as Record<string, unknown>)['apiKey']).toBeUndefined();
    const r = mapPresetToProvider(preset, { key: '$OPENAI_KEY' });
    if (!('provider' in r)) throw new Error('expected provider');
    expect(r.provider.apiKey).toBe('$OPENAI_KEY'); // literal, not expanded
  });
});

describe('FORMAT_MAP exhaustiveness (drift guard)', () => {
  it('has a disposition for every apiFormat present in the catalog', () => {
    for (const preset of getCatalog()) {
      const fmt = preset.apiFormat as PresetApiFormat | undefined;
      expect(fmt, `preset ${preset.id} has no apiFormat`).toBeDefined();
      expect(fmt! in FORMAT_MAP, `apiFormat '${fmt}' missing from FORMAT_MAP`).toBe(true);
    }
  });

  it('splits the catalog into mappable + excluded with no overlap or loss', () => {
    const { mappable, excluded } = listMappablePresets();
    expect(mappable.length).toBeGreaterThan(20);
    expect(excluded.length).toBeGreaterThanOrEqual(1); // azure-openai
    expect(mappable.length + excluded.length).toBe(getCatalog().length);
    // Every mappable apiFormat is a valid daemon format.
    for (const m of mappable) {
      expect(['openai', 'anthropic', 'gemini', 'openai-response']).toContain(m.apiFormat);
    }
    // azure-openai is the only remaining exclusion (openai-response became
    // mappable once DaemonApiFormat could name the Responses wire).
    const excludedIds = excluded.map((e) => e.id);
    expect(excludedIds).not.toContain('openai-response');
    expect(excludedIds).toContain('azure-openai');
    for (const e of excluded) expect(e.reason.length).toBeGreaterThan(0);
  });
});
