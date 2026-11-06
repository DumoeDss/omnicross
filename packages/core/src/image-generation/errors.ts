import {
  IMAGE_GENERATION_ERROR_CODES,
  IMAGE_DIAGNOSTIC_PHASES,
  IMAGE_DIAGNOSTIC_REASONS,
  type ImageGenerationDiagnostic,
  type ImageGenerationErrorCode,
  type ImageGenerationPublicError,
  type ImageModerationDetails,
  type ImageRetrySafety,
} from '@omnicross/contracts/image-generation-types';

const DEFAULT_MESSAGES: Record<ImageGenerationErrorCode, string> = {
  invalid_image_request: 'The image request is invalid.',
  unsupported_model: 'The requested image model is not supported.',
  unsupported_capability: 'The requested image capability is not available.',
  invalid_api_key: 'The API key is invalid.',
  upstream_auth_required: 'The upstream image provider requires authentication.',
  image_reference_not_found: 'The image reference was not found.',
  image_reference_expired: 'The image reference has expired.',
  image_too_large: 'The image exceeds the configured size limit.',
  unsupported_image_type: 'The image type is not supported.',
  moderation_blocked: 'The image request was blocked by moderation.',
  upstream_rate_limited: 'The upstream image provider is rate limited.',
  subscription_usage_limit_reached: 'The subscription image usage limit has been reached.',
  image_queue_full: 'The image execution queue is full.',
  image_queue_timeout: 'The image execution queue timed out.',
  request_cancelled: 'The image request was cancelled.',
  upstream_protocol_changed: 'The upstream image protocol could not be recognized.',
  image_generation_failed: 'The upstream image generation failed.',
  image_generation_timeout: 'The upstream image generation timed out.',
};

const DEFAULT_HTTP_STATUS: Record<ImageGenerationErrorCode, number> = {
  invalid_image_request: 400,
  unsupported_model: 400,
  unsupported_capability: 422,
  invalid_api_key: 401,
  upstream_auth_required: 503,
  image_reference_not_found: 404,
  image_reference_expired: 410,
  image_too_large: 413,
  unsupported_image_type: 415,
  moderation_blocked: 422,
  upstream_rate_limited: 429,
  subscription_usage_limit_reached: 429,
  image_queue_full: 429,
  image_queue_timeout: 504,
  request_cancelled: 499,
  upstream_protocol_changed: 502,
  image_generation_failed: 502,
  image_generation_timeout: 504,
};

export interface ImageGenerationErrorOptions {
  readonly diagnostic?: ImageGenerationDiagnostic;
  readonly param?: string;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;
  readonly retrySafety?: ImageRetrySafety;
  readonly moderationDetails?: ImageModerationDetails;
  readonly cause?: unknown;
}

function safeParam(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/i.test(value) ? value : undefined;
}

function safeDiagnostic(value: unknown): ImageGenerationDiagnostic | undefined {
  if (!value || typeof value !== 'object' || !('phase' in value) || !('reason' in value)) return undefined;
  const phase = IMAGE_DIAGNOSTIC_PHASES.find(item => item === value.phase);
  const reason = IMAGE_DIAGNOSTIC_REASONS.find(item => item === value.reason);
  if (!phase || !reason) return undefined;
  const upstreamStatus = 'upstreamStatus' in value && typeof value.upstreamStatus === 'number' && Number.isInteger(value.upstreamStatus) && value.upstreamStatus >= 100 && value.upstreamStatus <= 599 ? value.upstreamStatus : undefined;
  const observedBytes = 'observedBytes' in value && typeof value.observedBytes === 'number' && Number.isSafeInteger(value.observedBytes) && value.observedBytes >= 0 ? value.observedBytes : undefined;
  return { phase, reason, ...(upstreamStatus !== undefined ? { upstreamStatus } : {}), ...(observedBytes !== undefined ? { observedBytes } : {}) };
}

function safeModerationDetails(value: ImageModerationDetails | undefined): ImageModerationDetails | undefined {
  if (!value) return undefined;
  const stage = value.stage === 'input' || value.stage === 'output' ? value.stage : undefined;
  const categories = value.categories
    ?.filter((item) => /^[a-z][a-z0-9_.-]{0,63}$/i.test(item))
    .slice(0, 16);
  return stage || categories?.length ? { stage, categories: categories?.length ? categories : undefined } : undefined;
}

export class ImageGenerationError extends Error {
  readonly diagnostic?: ImageGenerationDiagnostic;
  readonly code: ImageGenerationErrorCode;
  readonly param?: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
  readonly retrySafety?: ImageRetrySafety;
  readonly moderationDetails?: ImageModerationDetails;

  constructor(code: ImageGenerationErrorCode, options: ImageGenerationErrorOptions = {}) {
    super(DEFAULT_MESSAGES[code]);
    this.name = 'ImageGenerationError';
    this.code = code;
    this.diagnostic = safeDiagnostic(options.diagnostic);
    this.param = safeParam(options.param);
    this.httpStatus = Number.isInteger(options.httpStatus)
      ? Math.min(599, Math.max(400, options.httpStatus!))
      : DEFAULT_HTTP_STATUS[code];
    this.retryAfterSeconds =
      typeof options.retryAfterSeconds === 'number' &&
      Number.isFinite(options.retryAfterSeconds) &&
      options.retryAfterSeconds >= 0
        ? Math.min(604_800, Math.floor(options.retryAfterSeconds))
        : undefined;
    this.retrySafety = options.retrySafety;
    this.moderationDetails = safeModerationDetails(options.moderationDetails);
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  }

  toJSON(): ImageGenerationPublicError {
    return serializeImageGenerationError(this);
  }
}

export function isImageGenerationError(error: unknown): error is ImageGenerationError {
  return error instanceof ImageGenerationError;
}

export function serializeImageGenerationError(error: ImageGenerationError): ImageGenerationPublicError {
  return {
    type: error.code === 'moderation_blocked' ? 'image_generation_user_error' : 'image_generation_error',
    code: error.code,
    ...(error.diagnostic !== undefined ? { diagnostic: safeDiagnostic(error.diagnostic) } : {}),
    message: DEFAULT_MESSAGES[error.code],
    httpStatus: error.httpStatus,
    ...(error.param !== undefined ? { param: error.param } : {}),
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.retrySafety !== undefined ? { retrySafety: error.retrySafety } : {}),
    ...(error.moderationDetails !== undefined ? { moderationDetails: error.moderationDetails } : {}),
  };
}

export function normalizeImageGenerationError(
  error: unknown,
  fallbackCode: ImageGenerationErrorCode = 'image_generation_failed',
  options: Omit<ImageGenerationErrorOptions, 'cause'> = {},
): ImageGenerationError {
  if (isImageGenerationError(error)) return error;
  return new ImageGenerationError(fallbackCode, { ...options, cause: error });
}

/** Rebuild an untrusted provider error through the allow-list and canonical messages. */
export function imageGenerationErrorFromPublic(value: unknown): ImageGenerationError {
  if (!value || typeof value !== 'object') return new ImageGenerationError('image_generation_failed');
  const record = value as Record<string, unknown>;
  const code = IMAGE_GENERATION_ERROR_CODES.includes(record.code as ImageGenerationErrorCode)
    ? (record.code as ImageGenerationErrorCode)
    : 'image_generation_failed';
  return new ImageGenerationError(code, {
    diagnostic: safeDiagnostic(record.diagnostic),
    param: safeParam(record.param),
    httpStatus: typeof record.httpStatus === 'number' ? record.httpStatus : undefined,
    retryAfterSeconds:
      typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds : undefined,
    retrySafety:
      record.retrySafety === 'before_acceptance' ||
      record.retrySafety === 'after_acceptance' ||
      record.retrySafety === 'unknown'
        ? record.retrySafety
        : undefined,
    moderationDetails:
      record.moderationDetails && typeof record.moderationDetails === 'object'
        ? (record.moderationDetails as ImageModerationDetails)
        : undefined,
  });
}
