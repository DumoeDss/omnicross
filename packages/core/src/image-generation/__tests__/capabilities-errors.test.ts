import { describe, expect, it } from 'vitest';

import type {
  ImageCapabilityEvidenceLayer,
  ImageCapabilityValues,
} from '@omnicross/contracts/image-generation-types';

import { resolveImageCapabilities } from '../capabilities';
import {
  ImageGenerationError,
  normalizeImageGenerationError,
  serializeImageGenerationError,
} from '../errors';

const allCapabilities: ImageCapabilityValues = {
  available: true,
  models: ['image-a', 'gpt-image-2'],
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
  responsesTool: true,
  multiTurnEdit: true,
  supportsFileId: true,
  supportsImageUrl: true,
};

function layer(
  kind: ImageCapabilityEvidenceLayer['kind'],
  values: Partial<ImageCapabilityValues> = allCapabilities,
): ImageCapabilityEvidenceLayer {
  return { kind, source: `${kind}-test`, verifiedAt: 900, expiresAt: 2_000, values };
}

function compression(value: unknown): ImageCapabilityValues['outputCompression'] {
  return value as ImageCapabilityValues['outputCompression'];
}

function resolveCompression(
  account: unknown,
  adapter: unknown = allCapabilities.outputCompression,
  upstream: unknown = allCapabilities.outputCompression,
) {
  return resolveImageCapabilities({
    adapter: layer('adapter', { ...allCapabilities, outputCompression: compression(adapter) }),
    account: layer('account', { ...allCapabilities, outputCompression: compression(account) }),
    upstream: layer('upstream', { ...allCapabilities, outputCompression: compression(upstream) }),
  }, 1_000).outputCompression;
}

describe('resolveImageCapabilities', () => {
  it('intersects sets, takes numeric minima, and requires affirmative booleans', () => {
    const result = resolveImageCapabilities(
      {
        adapter: layer('adapter'),
        account: layer('account', {
          ...allCapabilities,
          models: ['gpt-image-2', 'account-only'],
          outputFormats: ['png', 'webp'],
          maxInputImages: 4,
          maxOutputImages: 2,
        }),
        upstream: layer('upstream', {
          ...allCapabilities,
          models: ['gpt-image-2', 'upstream-only'],
          outputFormats: ['png'],
          maxInputImages: 8,
          maxOutputImages: 1,
          transparentBackground: false,
        }),
      },
      1_000,
    );

    expect(result.available).toBe(true);
    expect(result.models).toEqual(['gpt-image-2']);
    expect(result.outputFormats).toEqual(['png']);
    expect(result.qualityLevels).toEqual(['auto', 'high', 'low', 'medium']);
    expect(result.moderationModes).toEqual(['auto', 'low']);
    expect(result.outputCompression).toEqual({
      supported: true,
      formats: ['jpeg', 'webp'],
      min: 0,
      max: 100,
    });
    expect(result.maxInputImages).toBe(4);
    expect(result.maxOutputImages).toBe(1);
    expect(result.transparentBackground).toBe(false);
  });

  it('fails closed for unknown, stale, and contradictory availability evidence', () => {
    const unknown = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: { kind: 'account', source: 'unknown' },
      upstream: layer('upstream'),
    }, 1_000);
    expect(unknown).toMatchObject({ available: false, reason: 'account_unverified' });

    const stale = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: { ...layer('account'), expiresAt: 999 },
      upstream: layer('upstream'),
    }, 1_000);
    expect(stale).toMatchObject({ available: false, reason: 'stale_evidence' });

    const contradictory = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: layer('account', { ...allCapabilities, available: false }),
      upstream: layer('upstream'),
    }, 1_000);
    expect(contradictory).toMatchObject({ available: false, reason: 'contradictory_evidence' });
  });

  it('never infers features from a model name', () => {
    const result = resolveImageCapabilities({
      adapter: layer('adapter', { ...allCapabilities, transparentBackground: false }),
      account: layer('account', { ...allCapabilities, transparentBackground: false }),
      upstream: layer('upstream', { ...allCapabilities, transparentBackground: false }),
    }, 1_000);
    expect(result.models).toContain('gpt-image-2');
    expect(result.transparentBackground).toBe(false);
  });

  it.each([
    ['quality', { qualityLevels: [] }, 'no_common_quality_levels'],
    ['moderation', { moderationModes: [] }, 'no_common_moderation_modes'],
  ])('fails closed for empty %s evidence', async (_name, override, reason) => {
    const result = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: layer('account', { ...allCapabilities, ...override }),
      upstream: layer('upstream'),
    }, 1_000);
    expect(result).toMatchObject({ available: false, reason });
  });

  it('fails output compression closed for unknown or empty semantics', () => {
    const unknown = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: layer('account', { ...allCapabilities, outputCompression: undefined }),
      upstream: layer('upstream'),
    }, 1_000);
    expect(unknown.outputCompression).toEqual({ supported: false });

    const empty = resolveImageCapabilities({
      adapter: layer('adapter'),
      account: layer('account', {
        ...allCapabilities,
        outputCompression: { supported: true, formats: [], min: 0, max: 100 },
      }),
      upstream: layer('upstream'),
    }, 1_000);
    expect(empty.outputCompression).toEqual({ supported: false });
  });

  it.each([
    ['unsupported format', { supported: true, formats: ['jpeg', 'gif'], min: 0, max: 100 }],
    ['duplicate formats', { supported: true, formats: ['jpeg', 'jpeg'], min: 0, max: 100 }],
    ['negative minimum', { supported: true, formats: ['jpeg'], min: -1, max: 100 }],
    ['over-limit maximum', { supported: true, formats: ['jpeg'], min: 0, max: 101 }],
    ['reversed range', { supported: true, formats: ['jpeg'], min: 80, max: 20 }],
    ['non-integer bound', { supported: true, formats: ['jpeg'], min: 0.5, max: 100 }],
    ['malformed affirmative shape', { supported: true }],
  ])('fails output compression closed for an affirmative layer with %s', (_name, invalid) => {
    expect(resolveCompression(invalid)).toEqual({ supported: false });
  });

  it('fails output compression closed for valid disjoint formats or ranges', () => {
    expect(resolveCompression(
      { supported: true, formats: ['jpeg'], min: 0, max: 100 },
      { supported: true, formats: ['webp'], min: 0, max: 100 },
    )).toEqual({ supported: false });
    expect(resolveCompression(
      { supported: true, formats: ['jpeg'], min: 60, max: 100 },
      { supported: true, formats: ['jpeg'], min: 0, max: 40 },
    )).toEqual({ supported: false });
  });

  it('intersects valid output compression layers only after validating each layer', () => {
    expect(resolveCompression(
      { supported: true, formats: ['jpeg', 'webp'], min: 25, max: 90 },
      { supported: true, formats: ['png', 'jpeg', 'webp'], min: 0, max: 100 },
      { supported: true, formats: ['jpeg'], min: 40, max: 80 },
    )).toEqual({ supported: true, formats: ['jpeg'], min: 40, max: 80 });
  });
});

describe('ImageGenerationError', () => {
  it.each([
    ['image_queue_full', 429, 'The image execution queue is full.'],
    ['image_queue_timeout', 504, 'The image execution queue timed out.'],
  ] as const)('maps %s to its stable status and message', (code, httpStatus, message) => {
    expect(new ImageGenerationError(code).toJSON()).toMatchObject({
      code,
      httpStatus,
      message,
    });
  });

  it('never serializes causes, body excerpts, credentials, prompts, Base64, or account IDs', () => {
    const secrets = [
      'Bearer token-secret-sentinel',
      'Cookie=session-secret-sentinel',
      'full prompt sentinel',
      'data:image/png;base64,BASE64_SENTINEL',
      'account-secret-sentinel',
      '<html>response excerpt sentinel</html>',
    ].join(' | ');
    const error = normalizeImageGenerationError(new Error(secrets), 'upstream_protocol_changed', {
      retrySafety: 'after_acceptance',
    });
    const serialized = JSON.stringify(serializeImageGenerationError(error));
    expect(serialized).not.toContain('sentinel');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('base64');
    expect(serialized).toContain('upstream_protocol_changed');
    expect(Object.prototype.propertyIsEnumerable.call(error, 'cause')).toBe(false);
  });

  it('sanitizes public parameter and retry metadata', () => {
    const error = new ImageGenerationError('upstream_rate_limited', {
      param: 'prompt=secret sentinel',
      retryAfterSeconds: 90.9,
      cause: { privateBody: 'secret' },
    });
    expect(error.toJSON()).toMatchObject({
      code: 'upstream_rate_limited',
      retryAfterSeconds: 90,
    });
    expect(error.toJSON()).not.toHaveProperty('param');
    expect(error.toJSON()).not.toHaveProperty('cause');
  });
});
