import { resolveProviderEndpoint } from '../endpoint-resolver';
import type { LLMProvider } from '../llm-config';

const MIMO_REPLACEMENTS: Readonly<Record<string, string>> = {
  'mimo-v2.5': 'mimo-v2.6-flash',
  'mimo-v2.5-pro': 'mimo-v2.6-pro',
};
const MIMO_HOSTS = new Set(['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com']);

/** Retired text IDs are aliases only on the vendor's verified official endpoints. */
export function resolveRetiredOfficialModel(model: string, baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && MIMO_HOSTS.has(url.hostname) && Object.hasOwn(MIMO_REPLACEMENTS, model)
      ? MIMO_REPLACEMENTS[model] : model;
  } catch {
    return model;
  }
}

/** Read-time migration; credentials, custom endpoints and speech models stay intact. */
export function refreshOfficialTextModels<T extends LLMProvider>(provider: T): T {
  const endpoint = resolveProviderEndpoint(provider).baseUrl;
  const update = (id: string) => resolveRetiredOfficialModel(id, endpoint);
  if (!(provider.models ?? []).some((id) => update(id) !== id)
    && !(provider.modelConfigs ?? []).some((model) => update(model.id) !== model.id)) return provider;
  const currentConfigs = new Set((provider.modelConfigs ?? [])
    .filter((model) => update(model.id) === model.id).map((model) => model.id));
  return {
    ...provider,
    models: [...new Set((provider.models ?? []).map(update))],
    modelConfigs: provider.modelConfigs?.filter((model) =>
      update(model.id) === model.id || !currentConfigs.has(update(model.id)))
      .map((model) => update(model.id) === model.id ? model : {
        ...model, id: update(model.id), name: model.name.replace(/v2\.5/gu, 'v2.6'),
      }),
  };
}

/** Keeps saved default/session refs usable without rewriting the user's storage. */
export function resolveOfficialModelRoute(provider: LLMProvider | null, model: string) {
  if (!provider) return null;
  const actualModelId = resolveRetiredOfficialModel(model, resolveProviderEndpoint(provider).baseUrl);
  return actualModelId === model ? null : {
    isRouted: true, actualProviderId: provider.id, actualModelId,
  };
}
