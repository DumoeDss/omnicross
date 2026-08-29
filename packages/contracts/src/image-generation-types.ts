/**
 * Provider-neutral image generation vocabulary.
 *
 * This module intentionally contains no HTTP, filesystem, credential, or
 * ChatGPT/Codex private-wire types. Binary access is supplied by the core
 * image-generation module through an asset type that extends
 * {@link ImageInputAsset} / {@link ImageArtifactMetadata}.
 */

declare const imageArtifactIdBrand: unique symbol;
declare const imageReferenceIdBrand: unique symbol;
declare const sensitiveProviderReferenceBrand: unique symbol;

/** A process-generated, non-provider artifact identifier. */
export type ImageArtifactId = string & { readonly [imageArtifactIdBrand]: true };

/** A random public reference ID scoped by the reference store to one tenant. */
export type ImageReferenceId = string & { readonly [imageReferenceIdBrand]: true };

/**
 * An opaque upstream reference. It is content-sensitive and must never be
 * logged, serialized into telemetry, or exposed as a public file/reference ID.
 */
export type SensitiveOpaqueImageReference = string & {
  readonly [sensitiveProviderReferenceBrand]: 'sensitive-opaque-image-reference';
};

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type ImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type ImageBackground = 'auto' | 'opaque' | 'transparent';
export type ImageModeration = 'auto' | 'low';
export type ImageAction = 'generate' | 'edit';

/** Truthful provider support for the numeric output_compression request. */
export type ImageOutputCompressionCapability =
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly formats: readonly ImageOutputFormat[];
      readonly min: number;
      readonly max: number;
    };

export type ImageSize =
  | { readonly kind: 'auto' }
  | { readonly kind: 'pixels'; readonly width: number; readonly height: number };

export interface ImageRequestOptions {
  readonly model: string;
  readonly prompt: string;
  readonly n: number;
  readonly quality: ImageQuality;
  readonly size: ImageSize;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression?: number;
  readonly moderation: ImageModeration;
  readonly stream: boolean;
  readonly partialImages: number;
  /** Optional irreversible digest created by the protocol frontend. */
  readonly userFingerprint?: string;
}

/** Trusted metadata shared by every normalized edit asset. */
export interface ImageInputAsset {
  readonly artifactId: ImageArtifactId;
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha?: boolean;
  readonly sha256?: string;
}

export interface NormalizedImageGenerateRequest extends ImageRequestOptions {
  readonly action: 'generate';
}

export interface NormalizedImageEditRequest<
  TAsset extends ImageInputAsset = ImageInputAsset,
> extends ImageRequestOptions {
  readonly action: 'edit';
  readonly images: readonly TAsset[];
  readonly mask?: TAsset;
}

export type NormalizedImageRequest<
  TAsset extends ImageInputAsset = ImageInputAsset,
> = NormalizedImageGenerateRequest | NormalizedImageEditRequest<TAsset>;

/** Metadata for a complete, independently decodable image artifact. */
export interface ImageArtifactMetadata extends ImageInputAsset {
  readonly independentlyDecodable: true;
}

export interface ImageProviderOutput<
  TArtifact extends ImageArtifactMetadata = ImageArtifactMetadata,
> {
  readonly artifact: TArtifact;
  /** Sensitive trusted-process state; callers must retain it behind a public ID. */
  readonly providerReference?: SensitiveOpaqueImageReference;
  readonly revisedPrompt?: string;
}

/** Image usage is truthful and optional; absent values are never defaulted to zero. */
export interface ImageUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly inputTextTokens?: number;
  readonly inputImageTokens?: number;
  readonly outputImageTokens?: number;
  readonly generatedImages?: number;
}

export const IMAGE_GENERATION_ERROR_CODES = [
  'invalid_image_request',
  'unsupported_model',
  'unsupported_capability',
  'invalid_api_key',
  'upstream_auth_required',
  'image_reference_not_found',
  'image_reference_expired',
  'image_too_large',
  'unsupported_image_type',
  'moderation_blocked',
  'upstream_rate_limited',
  'subscription_usage_limit_reached',
  'request_cancelled',
  'upstream_protocol_changed',
  'image_generation_failed',
  'image_generation_timeout',
] as const;

export type ImageGenerationErrorCode = (typeof IMAGE_GENERATION_ERROR_CODES)[number];

export type ImageRetrySafety = 'before_acceptance' | 'after_acceptance' | 'unknown';
export type ImageModerationStage = 'input' | 'output';

export interface ImageModerationDetails {
  readonly stage?: ImageModerationStage;
  /** Coarse, upstream-verified category names only; no scores are accepted. */
  readonly categories?: readonly string[];
}

/** The only serializable error fields allowed across the image module boundary. */
export interface ImageGenerationPublicError {
  readonly type: 'image_generation_error' | 'image_generation_user_error';
  readonly code: ImageGenerationErrorCode;
  readonly message: string;
  readonly param?: string;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly retrySafety?: ImageRetrySafety;
  readonly moderationDetails?: ImageModerationDetails;
}

export type ImageProviderAcceptedEvent = {
  readonly type: 'accepted';
  readonly acceptedAt: number;
};

export type ImageProviderPartialImageEvent<
  TArtifact extends ImageArtifactMetadata = ImageArtifactMetadata,
> = {
  readonly type: 'partial_image';
  readonly outputIndex: number;
  readonly partialImageIndex: number;
  readonly image: ImageProviderOutput<TArtifact>;
};

export type ImageProviderCompletedEvent<
  TArtifact extends ImageArtifactMetadata = ImageArtifactMetadata,
> = {
  readonly type: 'completed';
  readonly images: readonly ImageProviderOutput<TArtifact>[];
  readonly usage?: ImageUsage;
  /** Added by trusted retention, not by a private provider wire. */
  readonly references?: readonly ImageReferenceMetadata[];
};

export type ImageProviderFailedEvent = {
  readonly type: 'failed';
  readonly error: ImageGenerationPublicError;
};

export type ImageProviderEvent<
  TArtifact extends ImageArtifactMetadata = ImageArtifactMetadata,
> =
  | ImageProviderAcceptedEvent
  | ImageProviderPartialImageEvent<TArtifact>
  | ImageProviderCompletedEvent<TArtifact>
  | ImageProviderFailedEvent;

export type ImageCapabilityLayerKind = 'adapter' | 'account' | 'upstream';

/** Every property is independently evidenced; omission means unknown. */
export interface ImageCapabilityValues {
  readonly available: boolean;
  readonly models: readonly string[];
  readonly generate: boolean;
  readonly edit: boolean;
  readonly maskEdit: boolean;
  readonly maxInputImages: number;
  readonly maxOutputImages: number;
  readonly streaming: boolean;
  readonly maxPartialImages: number;
  readonly transparentBackground: boolean;
  readonly flexibleSizes: boolean;
  readonly outputFormats: readonly ImageOutputFormat[];
  readonly qualityLevels: readonly ImageQuality[];
  readonly moderationModes: readonly ImageModeration[];
  readonly outputCompression: ImageOutputCompressionCapability;
  readonly responsesTool: boolean;
  readonly multiTurnEdit: boolean;
  readonly supportsFileId: boolean;
  readonly supportsImageUrl: boolean;
}

/** Trusted evidence. Sources must be descriptive, never an account identifier. */
export interface ImageCapabilityEvidenceLayer {
  readonly kind: ImageCapabilityLayerKind;
  readonly source: string;
  readonly verifiedAt?: number;
  readonly expiresAt?: number;
  readonly values?: Partial<ImageCapabilityValues>;
}

export const IMAGE_CAPABILITY_UNAVAILABLE_REASONS = [
  'missing_evidence',
  'stale_evidence',
  'contradictory_evidence',
  'adapter_unavailable',
  'account_unverified',
  'protocol_unverified',
  'no_common_models',
  'no_common_output_formats',
  'no_common_quality_levels',
  'no_common_moderation_modes',
] as const;

export type ImageCapabilityUnavailableReason =
  (typeof IMAGE_CAPABILITY_UNAVAILABLE_REASONS)[number];

/** Safe resolved snapshot. Raw account/protocol evidence never leaves the provider. */
export interface ImageCapabilities extends ImageCapabilityValues {
  readonly reason?: ImageCapabilityUnavailableReason;
  readonly resolvedAt: number;
  readonly oldestEvidenceAt?: number;
}

export interface ImageReferenceMetadata {
  readonly referenceId: ImageReferenceId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly mimeType: `image/${string}`;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}
