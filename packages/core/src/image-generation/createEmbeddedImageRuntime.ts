import { randomUUID } from 'node:crypto';
import type { ResponsesHostedImageRuntimeFactory } from '../provider-proxy/responses/responsesHostedImageIngress';

import { BoundedMemoryImageReferenceStore } from './BoundedMemoryImageReferenceStore';
import { ImageGenerationError } from './errors';
import { imageRouteTenantId } from './imageRouteIdentity';
import { ImageOrchestrator } from './ImageOrchestrator';
import type { ImageProvider } from './ImageProvider';
import { ImageProviderRegistry } from './ImageProviderRegistry';
import { createImageApiContributions } from './openai-images/contributions';
import { assertFiniteImageApiLimits, DEFAULT_IMAGE_API_LIMITS, type ImageApiLimits } from './openai-images/types';
import type { ImageReferenceStore } from './ports';
import { createResponsesImageGenerationContribution, InMemoryResponsesImageStateStore, type ResponsesImageStateStore } from './responses';

export interface EmbeddedImageRuntimeOptions {
  readonly providers: readonly ImageProvider[];
  readonly modelRoutes: Readonly<Record<string, string>>;
  readonly defaultModel: string;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly limits?: ImageApiLimits;
  readonly referenceStore?: ImageReferenceStore;
  readonly stateStore?: ResponsesImageStateStore;
  readonly referenceTtlMs?: number;
}

/** Library-only mount shared by desktop/server hosts; no daemon singleton or credentials. */
export function createEmbeddedImageRuntime(options: EmbeddedImageRuntimeOptions) {
  const shutdown = new AbortController();
  const routes = new Map(Object.entries(options.modelRoutes));
  const aliases = new Map(Object.entries(options.aliases ?? {}));
  const providerId = routes.get(options.defaultModel);
  if (!providerId || !options.providers.some((provider) => provider.id === providerId) ||
    [...routes.values()].some((id) => !options.providers.some((provider) => provider.id === id))) {
    throw new TypeError('Embedded image routes must name registered providers');
  }
  const limits = Object.freeze({ ...(options.limits ?? DEFAULT_IMAGE_API_LIMITS) });
  assertFiniteImageApiLimits(limits);
  const ownReferences = options.referenceStore ? undefined : new BoundedMemoryImageReferenceStore();
  const referenceStore = options.referenceStore ?? ownReferences!;
  const stateStore = options.stateStore ?? new InMemoryResponsesImageStateStore({ maxCalls: 256, maxResponses: 256 });
  const registry = new ImageProviderRegistry(options.providers.map((provider) => ({ id: provider.id,
    acquire: (context) => provider.acquire({ ...context, signal: AbortSignal.any([context.signal, shutdown.signal]) }),
  })));
  const orchestrator = new ImageOrchestrator({ registry, referenceStore });
  const hosted = createResponsesImageGenerationContribution({ orchestrator, referenceStore, stateStore });
  const ttlMs = options.referenceTtlMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('Invalid image reference TTL');
  const assertOpen = (): void => { if (shutdown.signal.aborted) throw new ImageGenerationError('unsupported_capability'); };
  const api = createImageApiContributions({ orchestrator, resolveRuntime: async ({ route }) => {
    assertOpen();
    const tenantId = imageRouteTenantId(route);
    if (!tenantId) throw new ImageGenerationError('invalid_api_key');
    await referenceStore.cleanup();
    return { tenantId, providerId, defaultModel: options.defaultModel, modelRoutes: routes,
      modelAliases: aliases, limits, referenceStore, retention: { enabled: true, ttlMs } };
  } });
  const generationId = `embedded-${randomUUID()}`;
  const hostedFactory: ResponsesHostedImageRuntimeFactory = { acquire: async () => {
    assertOpen();
    await Promise.all([referenceStore.cleanup(), stateStore.cleanup()]);
    let released = false;
    const scopes = new Set<Awaited<ReturnType<typeof hosted.createRequestScope>>>();
    return { generationId,
      inspectRequest: hosted.inspectRequest, validateSelection: hosted.validateSelection,
      openRequest: async (input) => {
        assertOpen();
        if (released) throw new ImageGenerationError('unsupported_capability');
        const scope = await hosted.createRequestScope({ admission: input.admission,
          runtime: { tenantId: input.tenantId, requestId: input.requestId, providerId,
            imageModel: options.defaultModel, modelRoutes: routes, modelAliases: aliases,
            referenceTtlMs: ttlMs, maxOutputBytes: limits.maxOutputBytes, maxTotalOutputBytes: limits.maxTotalOutputBytes,
            sessionKey: input.sessionKey, signal: AbortSignal.any([input.signal, shutdown.signal]) },
          authorizedPreviousResponseId: input.authorizedPreviousResponseId,
          authorizedPreviousResponseKnownEmpty: input.authorizedPreviousResponseKnownEmpty,
        });
        if (released || shutdown.signal.aborted) { await scope.dispose(); throw new ImageGenerationError('request_cancelled'); }
        scopes.add(scope);
        return scope;
      },
      release: async () => { released = true; await Promise.all([...scopes].map((scope) => scope.dispose())); scopes.clear(); },
    };
  } };
  return Object.freeze({ orchestrator, api, hostedFactory, dispose: () => {
    shutdown.abort(); ownReferences?.clear();
  } });
}
