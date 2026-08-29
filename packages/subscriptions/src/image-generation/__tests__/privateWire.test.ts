import { describe, expect, it } from 'vitest';

import { ImageGenerationError } from '@omnicross/core/image-generation';

import { mapCandidateCodexImageFailure, parseRetryAfter } from '../privateWireErrors';
import {
  parseCandidateCodexImageResponse,
  selectVerifiedCandidateResponseMetadata,
} from '../privateWireResponse';

const VALID_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVR4nGP4z8DQAMIADv0C/528KS0AAAAASUVORK5CYII=';
const VALID_JPEG = '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z';
const VALID_VP8 = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
const VALID_VP8L = 'UklGRhwAAABXRUJQVlA4TA8AAAAvAQAAAAcQ/Y/+ByKi/wEA';

function responseBody(result: string): string {
  return JSON.stringify({ output: [{ type: 'image_generation_call', status: 'completed', result }] });
}

describe('private candidate wire parsers', () => {
  it.each([
    ['HTML', '<html>SECRET_PROMPT_SENTINEL</html>'],
    ['invalid JSON', '{"output": SECRET_BASE64_SENTINEL'],
    ['empty output', JSON.stringify({ output: [] })],
    ['empty Base64', JSON.stringify({ output: [{ type: 'image_generation_call', status: 'completed', result: '' }] })],
    ['invalid Base64', JSON.stringify({ output: [{ type: 'image_generation_call', status: 'completed', result: '%%%SECRET_BASE64%%%' }] })],
    ['unknown terminal', JSON.stringify({ output: [{ type: 'image_generation_call', status: 'mystery', result: 'AAAA' }] })],
  ])('maps %s without embedding body excerpts', async (_name, body) => {
    let thrown: unknown;
    try {
      await parseCandidateCodexImageResponse(body, 1, 'png');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImageGenerationError);
    expect(thrown).toMatchObject({ code: 'upstream_protocol_changed' });
    expect(JSON.stringify(thrown)).not.toContain('SENTINEL');
  });

  it.each([
    ['PNG', VALID_PNG, 'png'],
    ['JPEG', VALID_JPEG, 'jpeg'],
    ['WebP VP8', VALID_VP8, 'webp'],
    ['WebP VP8L', VALID_VP8L, 'webp'],
  ] as const)('fully decodes a valid %s fixture before creating an asset', async (_name, fixture, format) => {
    const parsed = await parseCandidateCodexImageResponse(responseBody(fixture), 1, format);
    expect(parsed.images[0]).toMatchObject({
      mimeType: `image/${format}`,
      width: 2,
      height: 1,
      independentlyDecodable: true,
    });
  });

  it.each([
    ['truncated PNG', VALID_PNG, 'png'],
    ['truncated JPEG', VALID_JPEG, 'jpeg'],
    ['truncated WebP VP8', VALID_VP8, 'webp'],
    ['truncated WebP VP8L', VALID_VP8L, 'webp'],
  ] as const)('rejects a %s fixture before completion', async (_name, fixture, format) => {
    const truncated = fixture.slice(0, -4);
    await expect(parseCandidateCodexImageResponse(responseBody(truncated), 1, format))
      .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
  });

  it('omits candidate usage/revised prompt without separate verification', () => {
    const parsed = {
      images: [],
      revisedPrompt: 'SECRET_REVISED_PROMPT_SENTINEL',
      usage: { totalTokens: 123 },
    };
    expect(selectVerifiedCandidateResponseMetadata(parsed, undefined)).toEqual({});
    expect(selectVerifiedCandidateResponseMetadata(parsed, { usage: true })).toEqual({
      usage: { totalTokens: 123 },
    });
  });

  it('validates Retry-After and maps stable failures without body excerpts', async () => {
    expect(parseRetryAfter(new Headers({ 'Retry-After': '12' }))).toBe(12);
    expect(parseRetryAfter(new Headers({ 'Retry-After': '-1' }))).toBeUndefined();
    const response = new Response('unused', {
      status: 429,
      headers: { 'Retry-After': '30' },
    });
    const error = mapCandidateCodexImageFailure(
      response,
      '{"error":{"code":"subscription_usage_limit_reached","message":"SECRET_BODY_SENTINEL"}}',
    );
    expect(error).toMatchObject({
      code: 'subscription_usage_limit_reached',
      retryAfterSeconds: 30,
      retrySafety: 'unknown',
    });
    expect(JSON.stringify(error)).not.toContain('SENTINEL');
  });
});
