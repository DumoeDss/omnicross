import type { DaemonConfig } from '../config';

/** Recovery removes every portable credential, including secrets in migration packs. */
export function clearConfigCredentials(config: DaemonConfig): DaemonConfig {
  const next: DaemonConfig = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider, apiKey: '', apiKeys: [],
      codingPlan: provider.codingPlan ? { ...provider.codingPlan, apiKey: '' } : undefined,
      apiModes: provider.apiModes?.map((mode) => ({ ...mode, apiKey: '' })),
      // Extra headers can also carry operator-supplied credentials.
      extraHeaders: undefined,
    })),
  };
  if (config.server) {
    next.server = { ...config.server };
    const proxy = config.server.proxy;
    if (proxy) next.server.proxy = {
      ...proxy,
      global: proxy.global ? { ...proxy.global, password: undefined } : undefined,
      byProvider: proxy.byProvider ? Object.fromEntries(Object.entries(proxy.byProvider)
        .map(([id, value]) => [id, { ...value, password: undefined }])) : undefined,
    };
    if (config.server.webhook) next.server.webhook = {
      ...config.server.webhook,
      destinations: config.server.webhook.destinations.map((value) => ({ ...value, secret: undefined })),
    };
    if (config.server.billing) next.server.billing = { ...config.server.billing, secret: undefined };
    if (config.server.search) next.server.search = { ...config.server.search, providers: {} };
  }
  return next;
}
