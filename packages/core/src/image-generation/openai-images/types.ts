import type {
  ImageRequestOptions,
} from '@omnicross/contracts/image-generation-types';

import type {
  OpenAIOperationHandler,
  OpenAIOperationHandlerContext,
} from '../../openai-operation';
import type { ImageOrchestrator, ImageRetentionPolicy } from '../ImageOrchestrator';
import type { ImageAsset, ImageReferenceStore } from '../ports';

import { ImageGenerationError } from '../errors';

import type { ImageRequestResourceScope } from './TemporaryImageAsset';

export interface ImageApiLimits {
  readonly maxJsonBytes: number;
  readonly maxMultipartBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalInputBytes: number;
  readonly maxFiles: number;
  readonly maxFields: number;
  readonly maxParts: number;
  readonly maxHeaderPairs: number;
  readonly maxFieldNameBytes: number;
  readonly maxFieldValueBytes: number;
  readonly maxPixels: number;
  readonly maxRawBytes: number;
  readonly maxOutputBytes: number;
  readonly maxTotalOutputBytes: number;
  readonly maxSpoolBytes: number;
  readonly maxRedirects: number;
  readonly maxRemoteUrlBytes: number;
  readonly maxRemoteHeaderBytes: number;
  readonly remoteConnectTimeoutMs: number;
  readonly remoteTotalTimeoutMs: number;
}

export const DEFAULT_IMAGE_API_LIMITS: ImageApiLimits = Object.freeze({
  // Codex's built-in image tool sends edits as JSON data URLs rather than
  // multipart files. Leave room for the Base64 expansion of the bounded
  // aggregate input budget plus the small JSON/options envelope.
  maxJsonBytes: 96 * 1024 * 1024,
  maxMultipartBytes: 64 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalInputBytes: 64 * 1024 * 1024,
  maxFiles: 17,
  maxFields: 32,
  maxParts: 49,
  maxHeaderPairs: 64,
  maxFieldNameBytes: 128,
  maxFieldValueBytes: 32 * 1024,
  maxPixels: 8_294_400,
  maxRawBytes: 8_294_400 * 4,
  maxOutputBytes: 50 * 1024 * 1024,
  maxTotalOutputBytes: 100 * 1024 * 1024,
  maxSpoolBytes: 140 * 1024 * 1024,
  maxRedirects: 5,
  maxRemoteUrlBytes: 8 * 1024,
  maxRemoteHeaderBytes: 32 * 1024,
  remoteConnectTimeoutMs: 10_000,
  remoteTotalTimeoutMs: 30_000,
});

export function assertFiniteImageApiLimits(limits: ImageApiLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Image API limit '${name}' must be a positive safe integer.`);
    }
  }
  if (limits.maxFileBytes > 50 * 1024 * 1024) {
    throw new TypeError('Image API per-file limit exceeds the 50 MiB hard ceiling.');
  }
  if (limits.maxFiles > 17) {
    throw new TypeError('Image API file count exceeds sixteen images plus one mask.');
  }
  if (limits.maxPixels > 8_294_400) {
    throw new TypeError('Image API pixel limit exceeds the GPT Image hard ceiling.');
  }
  if (limits.maxTotalInputBytes < limits.maxFileBytes) {
    throw new TypeError('Image API aggregate input limit must cover one file.');
  }
  if (limits.maxTotalOutputBytes < limits.maxOutputBytes) {
    throw new TypeError('Image API aggregate output limit must cover one output.');
  }
}

export interface ImageRemoteMaterializer {
  materialize(
    source: AsyncIterable<Uint8Array>,
    declaredBytes: number | undefined,
    signal: AbortSignal,
  ): Promise<ImageAsset>;
}

export interface RemoteImageAssetResolver {
  resolve(input: {
    readonly url: string;
    readonly signal: AbortSignal;
    readonly limits: ImageApiLimits;
    readonly materializer: ImageRemoteMaterializer;
  }): Promise<ImageAsset>;
}

export interface ImageApiRuntime {
  readonly tenantId: string;
  /** The DEFAULT model's provider (status/validation); per-request dispatch resolves via `modelRoutes`. */
  readonly providerId: string;
  readonly defaultModel: string;
  readonly modelAliases: ReadonlyMap<string, string>;
  /** Model→provider routing (multi-provider-image-generation D1); models absent here are `unsupported_model`. */
  readonly modelRoutes: ReadonlyMap<string, string>;
  readonly limits: ImageApiLimits;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  readonly boundAccountFallbackPolicy?: 'strict' | 'pool';
  readonly referenceStore?: ImageReferenceStore;
  readonly remoteResolver?: RemoteImageAssetResolver;
  readonly fingerprintUser?: (value: string) => string;
  readonly retention?: ImageRetentionPolicy;
}

/** Resolve the per-request provider from the routing table (D1): the model the
 *  request actually targets (post alias/default normalization) picks the
 *  provider; a model absent from the table is rejected before any lease. */
export function resolveImageRequestProvider(
  runtime: Pick<ImageApiRuntime, 'modelRoutes' | 'providerId'>,
  model: string,
): string {
  const providerId = runtime.modelRoutes.get(model);
  if (!providerId) throw new ImageGenerationError('unsupported_model', { param: 'model' });
  return providerId;
}

export type ImageApiRuntimeResolver = (
  context: OpenAIOperationHandlerContext,
) => Promise<ImageApiRuntime> | ImageApiRuntime;

export interface ImageApiAuditRecord {
  readonly requestId: string;
  readonly operationId: 'images.generate' | 'images.edit';
  readonly providerId?: string;
  readonly model?: string;
  readonly options?: Pick<
    ImageRequestOptions,
    'n' | 'quality' | 'background' | 'outputFormat' | 'stream' | 'partialImages'
  >;
  readonly inputCount?: number;
  readonly inputBytes?: number;
  readonly referenceOutcomes?: {
    readonly hits: number;
    readonly notFound: number;
    readonly expired: number;
    readonly failed: number;
  };
  readonly cleanupOutcome?: 'completed' | 'failed';
  readonly terminal: 'completed' | 'failed' | 'cancelled';
  readonly errorCode?: string;
}

export interface ImageApiContributionsDeps {
  readonly orchestrator: ImageOrchestrator;
  readonly resolveRuntime: ImageApiRuntimeResolver;
  readonly createRequestId?: () => string;
  readonly now?: () => number;
  readonly createResourceScope?: (
    limits: ImageApiLimits,
    signal: AbortSignal,
    tenantId: string,
  ) => Promise<ImageRequestResourceScope>;
  readonly audit?: (record: ImageApiAuditRecord) => void | Promise<void>;
}

export interface ImageOpenAIOperationContribution {
  readonly operationId: 'images.generate' | 'images.edit';
  readonly handler: OpenAIOperationHandler;
}

export interface ImageApiContributions {
  readonly generate: ImageOpenAIOperationContribution & { readonly operationId: 'images.generate' };
  readonly edit: ImageOpenAIOperationContribution & { readonly operationId: 'images.edit' };
  readonly all: readonly ImageOpenAIOperationContribution[];
}
