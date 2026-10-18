import type { ImageApiProviderConfig, ImagesServerConfig } from '@/daemon/types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESERVED = new Set(['codex-subscription', 'antigravity-subscription', '__proto__', 'constructor', 'prototype']);

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
    if (!ID.test(model) || RESERVED.has(model) || !upstream || upstream.length > 256 || /[\u0000-\u001f\u007f]/u.test(upstream) || Object.prototype.hasOwnProperty.call(modelMap, model)) {
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
    providers: { ...config.providers, [id]: { ...instance, modelMap } },
    defaultModel: models[config.defaultModel] ? config.defaultModel : Object.keys(modelMap)[0]!,
    aliases: Object.fromEntries(Object.entries(config.aliases).filter(([, target]) => Boolean(models[target]))),
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
