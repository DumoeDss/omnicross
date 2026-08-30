import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  IMAGE_GENERATION_ERROR_CODES,
  type ImageArtifactMetadata,
  type ImageGenerationPublicError,
  type NormalizedImageEditRequest,
  type NormalizedImageGenerateRequest,
  type NormalizedImageRequest,
} from '../image-generation-types';

const artifact: ImageArtifactMetadata = {
  artifactId: 'artifact-test' as ImageArtifactMetadata['artifactId'],
  mimeType: 'image/png',
  byteLength: 8,
  width: 1,
  height: 1,
  hasAlpha: true,
  independentlyDecodable: true,
};

const common = {
  model: 'test-image-model',
  prompt: 'content stays outside diagnostics',
  n: 1,
  quality: 'auto' as const,
  size: { kind: 'auto' as const },
  background: 'auto' as const,
  outputFormat: 'png' as const,
  moderation: 'auto' as const,
  stream: false,
  partialImages: 0,
};

describe('provider-neutral image contracts', () => {
  it('narrows the normalized generate/edit union without raw carriers', () => {
    const generate: NormalizedImageGenerateRequest = { action: 'generate', ...common };
    const edit: NormalizedImageEditRequest<ImageArtifactMetadata> = {
      action: 'edit',
      ...common,
      images: [artifact],
    };
    const requests: NormalizedImageRequest<ImageArtifactMetadata>[] = [generate, edit];

    expect(requests.map((request) => request.action)).toEqual(['generate', 'edit']);
    if (requests[1]?.action === 'edit') {
      expectTypeOf(requests[1].images[0]).toMatchTypeOf<ImageArtifactMetadata>();
      expect(requests[1].images[0]).not.toHaveProperty('url');
      expect(requests[1].images[0]).not.toHaveProperty('dataUrl');
      expect(requests[1].images[0]).not.toHaveProperty('fileId');
    }
  });

  it('does not synthesize usage on completed output', () => {
    const completed = { type: 'completed' as const, images: [{ artifact }] };
    expect(completed).not.toHaveProperty('usage');
  });

  it('keeps the public error shape serializable and allow-listed', () => {
    const error: ImageGenerationPublicError = {
      type: 'image_generation_error',
      code: 'upstream_protocol_changed',
      message: 'The upstream image protocol could not be recognized.',
      httpStatus: 502,
      retrySafety: 'after_acceptance',
    };
    expect(IMAGE_GENERATION_ERROR_CODES).toContain(error.code);
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
    expect(Object.keys(error).sort()).toEqual(
      ['code', 'httpStatus', 'message', 'retrySafety', 'type'].sort(),
    );
    expect(IMAGE_GENERATION_ERROR_CODES).toEqual(expect.arrayContaining([
      'image_queue_full',
      'image_queue_timeout',
    ]));
  });

  it('contains no private Codex/ChatGPT wire fields', () => {
    const serialized = JSON.stringify({ artifact, common, codes: IMAGE_GENERATION_ERROR_CODES });
    expect(serialized).not.toMatch(/chatgpt|backend-api|authorization|cookie|access_token/i);
  });
});
