import { IMAGE_API_PROTOCOLS, type ImageApiProviderConfig } from '../image-generation/api/types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RESERVED = new Set(['codex-subscription', 'antigravity-subscription', '__proto__', 'constructor', 'prototype']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateImageApiProviders(value: unknown): string[] {
  if (value === undefined) return [];
  if (!record(value)) return ['images.providers must be an object'];
  const errors: string[] = [];
  if (Object.keys(value).length > 128) errors.push('images.providers has too many instances');
  for (const [id, entry] of Object.entries(value)) {
    const path = `images.providers.${ID.test(id) ? id : '[invalid]'}`;
    if (!ID.test(id) || RESERVED.has(id)) errors.push('images.providers contains an invalid or reserved instance id');
    if (!record(entry)) { errors.push(`${path} must be an object`); continue; }
    for (const key of Object.keys(entry)) {
      if (!['protocol', 'sourceProviderId', 'enabled', 'models', 'modelAliases', 'modelMap'].includes(key)) errors.push(`${path}.${key} is not supported`);
    }
    if (!(IMAGE_API_PROTOCOLS as readonly unknown[]).includes(entry.protocol)) errors.push(`${path}.protocol is unsupported`);
    if (typeof entry.sourceProviderId !== 'string' || !entry.sourceProviderId.trim() || entry.sourceProviderId.length > 256 || /[\u0000-\u001f\u007f]/u.test(entry.sourceProviderId)) {
      errors.push(`${path}.sourceProviderId is invalid`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') errors.push(`${path}.enabled must be a boolean`);
    if (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.length > 256
      || entry.models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model) || RESERVED.has(model))
      || new Set(entry.models).size !== entry.models.length)) {
      errors.push(`${path}.models must contain unique valid model ids (at most 256)`);
    }
    for (const field of ['modelAliases', 'modelMap'] as const) {
      const mapping = entry[field];
      if (mapping === undefined) continue;
      if (!record(mapping)) { errors.push(`${path}.${field} must be an object`); continue; }
      if (Object.keys(mapping).length > 256) errors.push(`${path}.${field} has too many mappings`);
      for (const [model, upstream] of Object.entries(mapping)) {
        if (!MODEL_ID.test(model) || RESERVED.has(model) || typeof upstream !== 'string' || !upstream.trim() || upstream.length > 256 || /[\u0000-\u001f\u007f]/u.test(upstream)) {
          errors.push(`${path}.${field} contains an invalid mapping`);
        }
      }
    }
  }
  return errors;
}

export function normalizeImageApiProviders(value: unknown): Record<string, ImageApiProviderConfig> {
  const output: Record<string, ImageApiProviderConfig> = {};
  if (!record(value)) return output;
  for (const [id, entry] of Object.entries(value).slice(0, 128)) {
    if (validateImageApiProviders({ [id]: entry }).length || !record(entry)) continue;
    output[id] = {
      protocol: entry.protocol as ImageApiProviderConfig['protocol'],
      sourceProviderId: (entry.sourceProviderId as string).trim(),
      ...(entry.enabled !== undefined ? { enabled: entry.enabled as boolean } : {}),
      ...(Array.isArray(entry.models) ? { models: [...entry.models] as string[] } : {}),
      ...(record(entry.modelAliases) ? { modelAliases: { ...entry.modelAliases } as Record<string, string> } : {}),
      ...(record(entry.modelMap) ? { modelMap: { ...entry.modelMap } as Record<string, string> } : {}),
    };
  }
  return output;
}
