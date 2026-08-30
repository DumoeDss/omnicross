import type http from 'node:http';
import { randomUUID } from 'node:crypto';

import type { ImageGenerationPublicError } from '@omnicross/contracts/image-generation-types';
import type { ImageGenerationErrorCode } from '@omnicross/contracts/image-generation-types';

import {
  ImageGenerationError,
  imageGenerationErrorFromPublic,
  normalizeImageGenerationError,
  serializeImageGenerationError,
} from '../errors';

export interface ImageApiErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: 'image_generation_error' | 'image_generation_user_error';
    readonly code: string;
    readonly param?: string;
    readonly retry_after_seconds?: number;
    readonly moderation_details?: {
      readonly stage?: 'input' | 'output';
      readonly categories?: readonly string[];
    };
  };
}

const SAFE_STATUS: Readonly<Record<ImageGenerationErrorCode, number>> = {
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

export function safeImageRequestId(value?: string): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function imageApiErrorFromUnknown(error: unknown): ImageGenerationError {
  return error instanceof ImageGenerationError
    ? error
    : normalizeImageGenerationError(error, 'image_generation_failed');
}

export function imageApiErrorFromProvider(value: ImageGenerationPublicError): ImageGenerationError {
  return imageGenerationErrorFromPublic(value);
}

export function serializeImageApiError(error: unknown): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ImageApiErrorBody;
  readonly domainError: ImageGenerationError;
} {
  const domainError = imageApiErrorFromUnknown(error);
  const safe = serializeImageGenerationError(domainError);
  const headers: Record<string, string> = {};
  if (safe.retryAfterSeconds !== undefined) headers['Retry-After'] = String(safe.retryAfterSeconds);
  return {
    status: SAFE_STATUS[safe.code],
    headers,
    domainError,
    body: {
      error: {
        message: safe.message,
        type: safe.type,
        code: safe.code,
        ...(safe.param !== undefined ? { param: safe.param } : {}),
        ...(safe.retryAfterSeconds !== undefined ? { retry_after_seconds: safe.retryAfterSeconds } : {}),
        ...(safe.moderationDetails !== undefined
          ? {
              moderation_details: {
                ...(safe.moderationDetails.stage ? { stage: safe.moderationDetails.stage } : {}),
                ...(safe.moderationDetails.categories?.length
                  ? { categories: safe.moderationDetails.categories }
                  : {}),
              },
            }
          : {}),
      },
    },
  };
}

export function writeImageApiError(
  response: http.ServerResponse,
  error: unknown,
  requestId: string,
): ImageGenerationError {
  const mapped = serializeImageApiError(error);
  if (!response.headersSent && !response.writableEnded && !response.destroyed) {
    response.writeHead(mapped.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'x-request-id': safeImageRequestId(requestId),
      ...mapped.headers,
    });
    response.end(JSON.stringify(mapped.body));
  }
  return mapped.domainError;
}
