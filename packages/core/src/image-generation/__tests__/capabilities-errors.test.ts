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
});

describe('ImageGenerationError', () => {
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
