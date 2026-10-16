import { resolveProviderEndpoint } from '@omnicross/contracts/endpoint-resolver';

import type { ProviderConfigSource } from '../../ports/provider-config-source';
import { fetchUpstream } from '../../pipeline/upstreamFetch';
import type { ImageProvider } from '../ImageProvider';

import { createApiImageProvider } from './ApiImageProvider';
import type { ApiImageProviderOptions, ImageApiProviderConfig } from './types';

export interface ConfiguredImageProvidersOptions {
  readonly providers: Readonly<Record<string, ImageApiProviderConfig>>;
  readonly modelRoutes: Readonly<Record<string, string>>;
  readonly providerSource: Pick<ProviderConfigSource, 'getProvider'>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxTotalOutputBytes?: number;
  readonly maxPixels?: number;
  readonly publishInput?: ApiImageProviderOptions['publishInput'];
  readonly acquireExecution?: (sourceProviderId: string) => ApiImageProviderOptions['acquireExecution'];
}

/** Portable assembly shared by daemon and embedded application hosts. */
export function createConfiguredImageProviders(options: ConfiguredImageProvidersOptions): ImageProvider[] {
  return Object.entries(options.providers).flatMap(([id, config]) => {
    const models = Object.fromEntries(Object.entries(options.modelRoutes)
      .filter(([, provider]) => provider === id)
      .map(([model]) => [model, config.modelMap?.[model] ?? model]));
    if (!Object.keys(models).length) return [];
    return [createApiImageProvider({
      id, protocol: config.protocol, models,
      timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes,
      maxTotalOutputBytes: options.maxTotalOutputBytes, maxPixels: options.maxPixels,
      publishInput: options.publishInput,
      acquireExecution: options.acquireExecution?.(config.sourceProviderId),
      resolveCredentials: async () => {
        if (config.enabled === false) return null;
        const source = await options.providerSource.getProvider(config.sourceProviderId);
        if (!source || source.enabled === false) return null;
        const endpoint = resolveProviderEndpoint(source);
        const key = endpoint.apiKey.startsWith('$') ? process.env[endpoint.apiKey.slice(1)] ?? '' : endpoint.apiKey;
        return { baseUrl: endpoint.baseUrl, apiKey: key, headers: source.extraHeaders };
      },
      fetch: (url, init) => fetchUpstream(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        init ?? {}, { providerId: 'byo', redactBodies: true },
      ),
    })];
  });
}
