import {
  ImageGenerationError,
  type ImageGenerationErrorOptions,
} from '@omnicross/core/image-generation';

export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(604_800, Number(value));
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return Math.min(604_800, Math.ceil((at - now) / 1_000));
}

function privateErrorCode(body: string): string | undefined {
  if (!body.trim() || body.length > 1_000_000 || /^\s*</.test(body)) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const error = (value as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && code.length <= 80 ? code : undefined;
  } catch {
    return undefined;
  }
}

export function mapCandidateCodexImageFailure(response: Response, body: string): ImageGenerationError {
  const retryAfterSeconds = parseRetryAfter(response.headers);
  const code = privateErrorCode(body);
  const uncertain: ImageGenerationErrorOptions = { retryAfterSeconds, retrySafety: 'unknown' };
  if (response.status === 401 || response.status === 403) {
    return new ImageGenerationError('upstream_auth_required', {
      retryAfterSeconds,
      retrySafety: 'before_acceptance',
    });
  }
  if (code === 'subscription_usage_limit_reached' || code === 'usage_limit_reached') {
    return new ImageGenerationError('subscription_usage_limit_reached', uncertain);
  }
  if (code === 'moderation_blocked') {
    return new ImageGenerationError('moderation_blocked', uncertain);
  }
  if (response.status === 429) return new ImageGenerationError('upstream_rate_limited', uncertain);
  if (response.status === 408 || response.status === 504) {
    return new ImageGenerationError('image_generation_timeout', uncertain);
  }
  if (response.status >= 500) return new ImageGenerationError('image_generation_failed', uncertain);
  return new ImageGenerationError('upstream_protocol_changed', uncertain);
}
