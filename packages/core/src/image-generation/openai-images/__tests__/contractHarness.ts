import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ImageCapabilities,
  ImageProviderEvent,
  NormalizedImageRequest,
} from '@omnicross/contracts/image-generation-types';
import sharp from 'sharp';

import { OpenAIOperationRegistry } from '../../../openai-operation';
import { routeRequest } from '../../../provider-proxy/providerProxyRouter';
import { ProviderProxyRouteMap } from '../../../provider-proxy/providerProxyRouteMap';
import type { ProviderProxyDeps, RouteContext } from '../../../provider-proxy/types';
import { ImageOrchestrator } from '../../ImageOrchestrator';
import type {
  ImageJob,
  ImageProvider,
  ImageProviderContext,
  ImageProviderLease,
} from '../../ImageProvider';
import { ImageProviderRegistry } from '../../ImageProviderRegistry';
import { InMemoryImageAsset } from '../../ports';
import type { ImageReferenceStore } from '../../ports';
import { createImageApiContributions } from '../contributions';
import { createImageRequestResourceScope } from '../TemporaryImageAsset';
import {
  DEFAULT_IMAGE_API_LIMITS,
  type ImageApiAuditRecord,
  type ImageApiLimits,
  type RemoteImageAssetResolver,
} from '../types';

const capabilities: ImageCapabilities = {
  available: true,
  models: ['gpt-image-1', 'image-test'],
  generate: true,
  edit: true,
  maskEdit: true,
  maxInputImages: 16,
  maxOutputImages: 10,
  streaming: true,
  maxPartialImages: 3,
  transparentBackground: true,
  flexibleSizes: true,
  outputFormats: ['png', 'jpeg', 'webp'],
  qualityLevels: ['auto', 'low', 'medium', 'high'],
  moderationModes: ['auto', 'low'],
  outputCompression: { supported: true, formats: ['jpeg', 'webp'], min: 0, max: 100 },
  responsesTool: false,
  multiTurnEdit: true,
  supportsFileId: false,
  supportsImageUrl: false,
  resolvedAt: 1,
  oldestEvidenceAt: 1,
};

async function fixture(
  format: 'png' | 'jpeg' | 'webp',
  value: number,
  alpha: boolean,
  width = 2,
  height = 2,
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha
        ? { r: value, g: 20, b: 30, alpha: 0.5 }
        : { r: value, g: 20, b: 30 },
    },
  });
  return format === 'png' ? image.png().toBuffer()
    : format === 'jpeg' ? image.jpeg().toBuffer()
      : image.webp().toBuffer();
}

export interface ContractHarnessCapture {
  readonly requests: NormalizedImageRequest[];
  readonly contexts: ImageProviderContext[];
  readonly audits: ImageApiAuditRecord[];
  starts: number;
  cancels: number;
  releases: number;
}

export interface ImageContractHarness {
  readonly baseURL: string;
  readonly token: string;
  readonly tenantId: string;
  readonly capture: ContractHarnessCapture;
  readonly inputPng: Buffer;
  readonly inputJpeg: Buffer;
  readonly maskPng: Buffer;
  readonly outputBytes: Readonly<Record<'png' | 'jpeg' | 'webp', Buffer>>;
  readonly tempEntries: () => Promise<readonly string[]>;
  /** Wait until every accepted HTTP request has completed its handler finally block. */
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export async function createImageContractHarness(options: {
  readonly register?: boolean;
  readonly usage?: boolean;
  readonly onAccepted?: () => Promise<void> | void;
  readonly capabilities?: Partial<ImageCapabilities>;
  readonly limits?: Partial<ImageApiLimits>;
  readonly referenceStore?: ImageReferenceStore;
  readonly remoteResolver?: RemoteImageAssetResolver;
} = {}): Promise<ImageContractHarness> {
  const inputPng = await fixture('png', 1, true);
  const inputJpeg = await fixture('jpeg', 2, false);
  const maskPng = await fixture('png', 3, true);
  const outputBytes = {
    png: await fixture('png', 100, true, 1024, 1024),
    jpeg: await fixture('jpeg', 101, false, 1024, 1024),
    webp: await fixture('webp', 102, true, 1024, 1024),
  } as const;
  const partialBytes = await fixture('png', 200, true);
  const capture: ContractHarnessCapture = {
    requests: [],
    contexts: [],
    audits: [],
    starts: 0,
    cancels: 0,
    releases: 0,
  };
  const resolvedCapabilities = { ...capabilities, ...options.capabilities };
  const resolvedLimits = { ...DEFAULT_IMAGE_API_LIMITS, ...options.limits };
  const tempRoot = await mkdtemp(join(tmpdir(), 'omnicross-contract-images-'));
  const provider: ImageProvider = {
    id: 'fake-images',
    async acquire(context): Promise<ImageProviderLease> {
      capture.contexts.push(context);
      return {
        providerId: 'fake-images',
        capabilities: resolvedCapabilities,
        start(request): ImageJob {
          capture.starts += 1;
          capture.requests.push(request);
          let cancelled = false;
          const events = (async function* (): AsyncIterable<ImageProviderEvent> {
            yield { type: 'accepted', acceptedAt: 10 };
            await options.onAccepted?.();
            for (let partialIndex = 0; partialIndex < request.partialImages; partialIndex += 1) {
              for (let outputIndex = 0; outputIndex < request.n; outputIndex += 1) {
                if (cancelled || context.signal.aborted) return;
                yield {
                  type: 'partial_image',
                  outputIndex,
                  partialImageIndex: partialIndex,
                  image: {
                    artifact: new InMemoryImageAsset(partialBytes, {
                      mimeType: 'image/png',
                      width: 2,
                      height: 2,
                      hasAlpha: true,
                    }),
                  },
                };
              }
            }
            if (cancelled || context.signal.aborted) return;
            const bytes = outputBytes[request.outputFormat];
            yield {
              type: 'completed',
              images: Array.from({ length: request.n }, (_unused, index) => ({
                artifact: new InMemoryImageAsset(bytes, {
                  mimeType: `image/${request.outputFormat}`,
                  width: 1024,
                  height: 1024,
                  hasAlpha: request.outputFormat !== 'jpeg',
                }),
                revisedPrompt: `safe revision ${index}`,
              })),
              ...(options.usage
                ? {
                    usage: {
                      totalTokens: 7,
                      inputTokens: 3,
                      outputTokens: 4,
                      inputTextTokens: 2,
                      inputImageTokens: 1,
                      outputImageTokens: 4,
                      generatedImages: request.n,
                    },
                  }
                : {}),
            };
          })();
          return {
            events,
            async cancel() {
              if (!cancelled) capture.cancels += 1;
              cancelled = true;
            },
          };
        },
        async release() {
          capture.releases += 1;
        },
      };
    },
  };
  const orchestrator = new ImageOrchestrator({ registry: new ImageProviderRegistry([provider]) });
  const registry = new OpenAIOperationRegistry();
  const tenantId = 'outbound-key-tenant';
  if (options.register !== false) {
    const contributions = createImageApiContributions({
      orchestrator,
      createRequestId: () => 'image-request-id',
      now: () => 1_700_000_000_000,
      createResourceScope: (limits, signal) => createImageRequestResourceScope(limits, signal, tempRoot),
      audit: (record) => { capture.audits.push(record); },
      resolveRuntime: (context) => {
        if (context.route.apiKeyId !== tenantId) throw new Error('trusted route identity missing');
        return {
          tenantId: context.route.apiKeyId,
          providerId: 'fake-images',
          defaultModel: 'gpt-image-1',
          modelAliases: new Map([['latest-image', 'gpt-image-1']]),
          limits: resolvedLimits,
          preferredAccountGroup: 'runtime-configured-group',
          boundAccountFallbackPolicy: 'pool',
          ...(options.referenceStore ? { referenceStore: options.referenceStore } : {}),
          ...(options.remoteResolver ? { remoteResolver: options.remoteResolver } : {}),
        };
      },
    });
    for (const contribution of contributions.all) {
      registry.register(contribution.operationId, contribution.handler);
    }
  }
  const routes = new ProviderProxyRouteMap();
  const route: RouteContext = {
    sessionId: 'safe-session',
    apiKeyId: tenantId,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-5.6',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'unused-text-provider',
    preferredAccountId: 'untrusted-route-account',
    boundAccountFallbackPolicy: 'strict',
  };
  const token = routes.addRoute(route);
  const deps = {
    llmConfig: { getProvider: async () => undefined },
    openAIOperationRegistry: registry,
  } as unknown as ProviderProxyDeps;
  const activeRequests = new Set<Promise<void>>();
  const waitForIdle = async (): Promise<void> => {
    while (activeRequests.size > 0) {
      await Promise.all([...activeRequests]);
    }
  };
  const server: Server = createServer((request, response) => {
    const handled = routeRequest(request, response, routes, deps).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"test_harness_failed"}}');
    });
    activeRequests.add(handled);
    void handled.finally(() => activeRequests.delete(handled));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test harness did not bind a TCP port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    token,
    tenantId,
    capture,
    inputPng,
    inputJpeg,
    maskPng,
    outputBytes,
    tempEntries: () => readdir(tempRoot),
    waitForIdle,
    async close() {
      routes.clear();
      const closed = once(server, 'close');
      server.close();
      await waitForIdle();
      await closed;
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}
