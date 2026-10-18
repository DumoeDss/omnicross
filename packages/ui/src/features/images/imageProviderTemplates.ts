import type { ImageApiProtocol, ImagesServerConfig } from '@/daemon/types';

export interface ImageProviderTemplate {
  id: string;
  name: string;
  protocol: ImageApiProtocol;
  baseUrl: string;
  models: readonly string[];
}

/** Image adapters supported by the runtime, independent of the chat catalog. */
export const IMAGE_PROVIDER_TEMPLATES: readonly ImageProviderTemplate[] = [
  { id: 'openai-images', name: 'OpenAI Images', protocol: 'openai-images',
    baseUrl: 'https://api.openai.com/v1', models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] },
  { id: 'gemini-images', name: 'Google Gemini', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image'] },
  { id: 'gemini-interactions', name: 'Gemini Interactions', protocol: 'gemini-interactions',
    baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-nano-banana-2.1'] },
  { id: 'vertex-images', name: 'Google Vertex AI', protocol: 'vertex',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1/publishers/google',
    models: ['gemini-3-pro-image'] },
  { id: 'xai-images', name: 'xAI Grok Imagine', protocol: 'xai',
    baseUrl: 'https://api.x.ai/v1', models: ['grok-imagine-image'] },
  { id: 'openrouter-images', name: 'OpenRouter Images', protocol: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1', models: ['google/gemini-nano-banana-2.1'] },
  { id: 'wavespeed-images', name: 'WaveSpeed', protocol: 'wavespeed',
    baseUrl: 'https://api.wavespeed.ai', models: ['openai/gpt-image-2.5-sunburst/text-to-image', 'openai/gpt-image-2.5-flare/text-to-image', 'google/nano-banana-2.1/text-to-image', 'wavespeed-ai/z-image/turbo'] },
];

export const CUSTOM_IMAGE_TEMPLATE: ImageProviderTemplate = {
  id: 'custom-images', name: '', protocol: 'openai-images', baseUrl: '', models: [],
};

export function nextImageProviderId(config: ImagesServerConfig, template: ImageProviderTemplate): string {
  let id = template.id;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(config.providers ?? {}, id)) id = template.id + '-' + suffix++;
  return id;
}

export function imageProviderModelsText(config: ImagesServerConfig, id: string): string {
  const instance = config.providers?.[id];
  const map = instance?.modelMap;
  const routes = instance?.models === undefined ? Object.entries(config.models).filter(([, provider]) => provider === id) : [];
  const aliases = Object.entries(instance?.modelAliases ?? {});
  const routedModels = new Set(routes.map(([model]) => map?.[model] ?? model));
  for (const [, upstream] of aliases) routedModels.add(upstream);
  return [
    ...aliases.map(([model, upstream]) => model + ' = ' + upstream),
    ...routes.map(([model]) => map?.[model] && map[model] !== model ? model + ' = ' + map[model] : model),
    ...(config.providers?.[id]?.models ?? []).filter((model) => !routedModels.has(model)),
  ].join('\n');
}
