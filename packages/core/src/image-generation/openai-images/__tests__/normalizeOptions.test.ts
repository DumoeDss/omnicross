import { describe, expect, it } from 'vitest';

import type { ImageApiRuntime } from '../types';
import { DEFAULT_IMAGE_API_LIMITS } from '../types';
import { normalizeGenerateRequest } from '../normalizeOptions';

const runtime: ImageApiRuntime = {
  tenantId: 'tenant-safe',
  providerId: 'fake',
  defaultModel: 'gpt-image-2',
  modelAliases: new Map([['image-latest', 'gpt-image-2']]),
  limits: DEFAULT_IMAGE_API_LIMITS,
  fingerprintUser: () => 'hmac:user-safe',
};

describe('normalizeGenerateRequest', () => {
  it('normalizes defaults, aliases, dimensions, and only a trusted user fingerprint', () => {
    expect(normalizeGenerateRequest({
      prompt: 'draw',
      model: 'image-latest',
      size: '1024x1024',
      output_format: 'webp',
      background: 'transparent',
      output_compression: 75,
      user: 'RAW_USER_SENTINEL',
    }, runtime)).toMatchObject({
      action: 'generate',
      model: 'gpt-image-2',
      prompt: 'draw',
      n: 1,
      size: { kind: 'pixels', width: 1024, height: 1024 },
      outputFormat: 'webp',
      background: 'transparent',
      outputCompression: 75,
      userFingerprint: 'hmac:user-safe',
    });
  });

  it.each([
    ['blank prompt', { prompt: ' ' }, 'prompt'],
    ['unknown field', { prompt: 'x', secret: true }, 'secret'],
    ['count zero', { prompt: 'x', n: 0 }, 'n'],
    ['count eleven', { prompt: 'x', n: 11 }, 'n'],
    ['non-multiple dimension', { prompt: 'x', size: '1025x1024' }, 'size'],
    ['small dimension', { prompt: 'x', size: '256x256' }, 'size'],
    ['extreme ratio', { prompt: 'x', size: '3072x512' }, 'size'],
    ['transparent jpeg', { prompt: 'x', background: 'transparent', output_format: 'jpeg' }, 'background'],
    ['png compression', { prompt: 'x', output_format: 'png', output_compression: 50 }, 'output_compression'],
    ['partial without stream', { prompt: 'x', partial_images: 1 }, 'partial_images'],
    ['bad moderation', { prompt: 'x', moderation: 'off' }, 'moderation'],
  ])('rejects %s locally', (_name, body, param) => {
    expect(() => normalizeGenerateRequest(body, runtime)).toThrow(
      expect.objectContaining({ code: 'invalid_image_request', param }),
    );
  });

  it('omits a raw user when no keyed fingerprint port is installed', () => {
    const request = normalizeGenerateRequest(
      { prompt: 'draw', user: 'RAW_USER_SENTINEL' },
      { ...runtime, fingerprintUser: undefined },
    );
    expect(request.userFingerprint).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('RAW_USER_SENTINEL');
  });
});
