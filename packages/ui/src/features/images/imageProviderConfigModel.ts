import type { ImageApiProviderConfig, ImagesServerConfig } from '@/daemon/types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const RESERVED = new Set(['codex-subscription', 'antigravity-subscription', '__proto__', 'constructor', 'prototype']);

function validUpstream(model: string): boolean {
  return Boolean(model.trim()) && model.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(model) && !RESERVED.has(model);
}

export const DEFAULT_CODEX_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
export const CODEX_IMAGE_MODELS = ['gpt-image-2', 'gpt-image-2.5-flare', DEFAULT_CODEX_IMAGE_MODEL] as const;

export function imageProviderModels(config: ImagesServerConfig, id: string): string[] {
  const instance = config.providers?.[id];
  return [...new Set([
    ...(instance?.models ?? []),
    ...Object.values(instance?.modelAliases ?? {}),
    ...Object.entries(config.models).filter(([, provider]) => provider === id)
      .map(([model]) => instance?.modelMap?.[model] ?? model),
  ])];
}

export function preferredImageModel(models: readonly string[], requested = DEFAULT_CODEX_IMAGE_MODEL, fallback = models[0] ?? ''): string {
  return models.find((model) => model === requested || model.endsWith(`/${requested}`) || model.includes(`/${requested}/`)) ?? fallback;
}

/** Keep the client-facing tool names stable while switching its image backend. */
export function configureCodexImageRoute(config: ImagesServerConfig, providerId: string, model: string,
  mappings: Readonly<Record<string, string>> = {}): ImagesServerConfig {
  if (!validUpstream(model)) throw new Error('images.api.invalidModels');
  if (!['codex-subscription', 'antigravity-subscription'].includes(providerId) && !config.providers?.[providerId]) {
    throw new Error('images.api.invalidInstance');
  }
  let next = { ...config, aliases: { ...config.aliases } };
  const instance = config.providers?.[providerId];
  if (instance) {
    const catalog = { ...Object.fromEntries((instance.models ?? []).map((value) => [value, value])), ...instance.modelAliases };
    for (const [requested, upstream] of Object.entries(catalog)) {
      if (!MODEL_ID.test(requested) || RESERVED.has(requested)) continue;
      delete next.aliases[requested];
      next = moveImageRoute(next, requested, providerId);
      const provider = next.providers![providerId]!;
      next = { ...next, providers: { ...next.providers, [providerId]: { ...provider, modelMap: { ...provider.modelMap, [requested]: upstream } } } };
    }
  }
  const targets = Object.fromEntries(CODEX_IMAGE_MODELS.map((requested) => [requested, mappings[requested] ?? instance?.modelAliases?.[requested] ?? model]));
  for (const requested of CODEX_IMAGE_MODELS) {
    const target = targets[requested]!;
    if (!validUpstream(target) || (providerId === 'antigravity-subscription' && !MODEL_ID.test(target))) throw new Error('images.api.invalidModels');
    delete next.aliases[requested];
    next = moveImageRoute(next, requested, providerId);
    if (providerId === 'antigravity-subscription') {
      const models = { ...next.models, [target]: providerId };
      delete models[requested];
      next = { ...next, models, aliases: { ...next.aliases, [requested]: target } };
    } else if (providerId !== 'codex-subscription') {
      const instance = next.providers![providerId]!;
      next = { ...next, providers: { ...next.providers, [providerId]: {
        ...instance, modelMap: { ...instance.modelMap, [requested]: target },
      } } };
    }
  }
  if (providerId === 'codex-subscription') {
    next = moveImageRoute(next, model, providerId);
    return { ...next, defaultModel: model, codex: { ...config.codex, imageModel: model } };
  }
  if (providerId === 'antigravity-subscription') {
    const aliases = Object.fromEntries(Object.entries(next.aliases).map(([alias, target]) => [alias, targets[target] ?? target]));
    return { ...next, aliases, defaultModel: targets[DEFAULT_CODEX_IMAGE_MODEL]! };
  }
  return { ...next, defaultModel: DEFAULT_CODEX_IMAGE_MODEL };
}

/** Save a connection/catalog without taking ownership of any model routes. */
export function saveImageProvider(config: ImagesServerConfig, id: string, instance: ImageApiProviderConfig): ImagesServerConfig {
  if (!ID.test(id) || RESERVED.has(id) || !instance.sourceProviderId) throw new Error('images.api.invalidInstance');
  return { ...config, providers: { ...config.providers, [id]: instance } };
}

/** A provider's model catalog may overlap other providers without claiming their routes. */
export function saveImageProviderModels(config: ImagesServerConfig, id: string, rows: readonly { model: string; upstream: string }[]): ImagesServerConfig {
  const instance = config.providers?.[id];
  if (!instance) throw new Error('images.api.invalidInstance');
  const aliases: Record<string, string> = {};
  const models = new Set<string>();
  const requests = new Set<string>();
  for (const row of rows) {
    const upstream = row.upstream.trim();
    const requested = row.model.trim() || upstream;
    if (!MODEL_ID.test(requested) || RESERVED.has(requested) || !validUpstream(upstream) || requests.has(requested)) {
      throw new Error('images.api.invalidModels');
    }
    requests.add(requested); models.add(upstream);
    if (requested !== upstream) aliases[requested] = upstream;
  }
  const modelMap = { ...instance.modelMap };
  // Only explicit edits of an already-active request name affect its current target.
  for (const row of rows) {
    const requested = row.model.trim() || row.upstream.trim();
    if (config.models[requested] === id) modelMap[requested] = row.upstream.trim();
  }
  return saveImageProvider(config, id, { ...instance, models: [...models], modelAliases: aliases, modelMap });
}

export function saveImageInstance(
  config: ImagesServerConfig, id: string, instance: ImageApiProviderConfig, text: string,
  options: { replaceExistingRoutes?: boolean } = {},
): ImagesServerConfig {
  if (!ID.test(id) || RESERVED.has(id) || !instance.sourceProviderId) throw new Error('images.api.invalidInstance');
  const modelMap: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const split = line.indexOf('=');
    const model = (split < 0 ? line : line.slice(0, split)).trim();
    const upstream = (split < 0 ? line : line.slice(split + 1)).trim();
    if (!MODEL_ID.test(model) || RESERVED.has(model) || !validUpstream(upstream) || Object.prototype.hasOwnProperty.call(modelMap, model)) {
      throw new Error('images.api.invalidModels');
    }
    if (config.models[model] && config.models[model] !== id && !options.replaceExistingRoutes) throw new Error('images.api.routeConflict');
    modelMap[model] = upstream;
  }
  if (!Object.keys(modelMap).length) throw new Error('images.api.invalidModels');
  // Reassign only after validation and explicit consent, retaining unrelated routes.
  for (const model of Object.keys(modelMap)) {
    if (config.models[model] && config.models[model] !== id) config = moveImageRoute(config, model, id);
  }
  const models = Object.fromEntries(Object.entries(config.models).filter(([, provider]) => provider !== id));
  for (const model of Object.keys(modelMap)) models[model] = id;
  return {
    ...config, models,
    providers: { ...config.providers, [id]: { ...instance, models: [...new Set(Object.values(modelMap))], modelMap } },
    defaultModel: models[config.defaultModel] ? config.defaultModel : Object.keys(modelMap)[0]!,
    aliases: Object.fromEntries(Object.entries(config.aliases).filter(([alias, target]) => !models[alias] && Boolean(models[target]))),
  };
}

export function removeImageInstance(config: ImagesServerConfig, id: string): ImagesServerConfig {
  const providers = { ...config.providers };
  delete providers[id];
  const models = Object.fromEntries(Object.entries(config.models).filter(([, provider]) => provider !== id));
  if (!Object.keys(models).length) throw new Error('images.api.lastRoute');
  return { ...config, providers, models,
    defaultModel: models[config.defaultModel] ? config.defaultModel : Object.keys(models)[0]!,
    aliases: Object.fromEntries(Object.entries(config.aliases).filter(([, target]) => Boolean(models[target]))),
  };
}

export function moveImageRoute(config: ImagesServerConfig, model: string, provider: string): ImagesServerConfig {
  const previous = config.models[model];
  const providers = { ...config.providers };
  if (previous && providers[previous]?.modelMap) {
    const modelMap = { ...providers[previous]!.modelMap };
    delete modelMap[model];
    providers[previous] = { ...providers[previous]!, modelMap };
  }
  return { ...config, providers, models: { ...config.models, [model]: provider } };
}

export function saveImageAliases(config: ImagesServerConfig, text: string): ImagesServerConfig {
  const aliases: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const pair = line.split('=').map((value) => value.trim());
    const [alias, target] = pair;
    if (pair.length !== 2 || !alias || !target || !ID.test(alias) || RESERVED.has(alias)
      || Object.prototype.hasOwnProperty.call(config.models, alias)
      || Object.prototype.hasOwnProperty.call(aliases, alias)
      || !Object.prototype.hasOwnProperty.call(config.models, target)) {
      throw new Error('images.api.invalidAliases');
    }
    aliases[alias] = target;
  }
  return { ...config, aliases };
}
