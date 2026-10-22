import { describe, expect, it, vi } from 'vitest';

import type { NormalizedImageGenerateRequest } from '@omnicross/contracts/image-generation-types';
import { ImageGenerationError } from '@omnicross/core/image-generation';

import { applyCodexImageModelOverrideEvidence, createCodexImageAdapterEvidence } from '../capabilityEvidence';
import {
  buildCandidateCodexImageRequest,
  CANDIDATE_CODEX_IMAGE_CARRIER_MODEL,
} from '../privateWireRequest';
import { mapCandidateCodexImageFailure, parseRetryAfter } from '../privateWireErrors';
import {
  decodeCandidateBase64ForTests,
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
  it('accepts the exact 50 MiB decoded Base64 limit without stack-sensitive validation', () => {
    const decodedBytes = 50 * 1024 * 1024;
    const encoded = `${'A'.repeat(Math.ceil(decodedBytes / 3) * 4 - 1)}=`;
    const result = decodeCandidateBase64ForTests(encoded);
    expect(result.byteLength).toBe(decodedBytes);
  });

  it('rejects limit-plus-one before Buffer allocation or alphabet scanning', () => {
    const decodedBytes = 50 * 1024 * 1024 + 1;
    const encoded = 'A'.repeat(Math.ceil(decodedBytes / 3) * 4);
    const from = vi.spyOn(Buffer, 'from');
    expect(() => decodeCandidateBase64ForTests(encoded)).toThrow(
      expect.objectContaining({ code: 'upstream_protocol_changed' }),
    );
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it.each(['A===', '=AAA', 'AA=A', 'AAAA====', 'AAAA\nAA=='])('rejects malformed padding/alphabet %j', (encoded) => {
    expect(() => decodeCandidateBase64ForTests(encoded)).toThrow(
      expect.objectContaining({ code: 'upstream_protocol_changed' }),
    );
  });

  it('scans a very large malformed alphabet linearly without leaking a raw RangeError', () => {
    const encoded = `${'A'.repeat(8 * 1024 * 1024 - 2)}*=`;
    let thrown: unknown;
    try {
      decodeCandidateBase64ForTests(encoded);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ImageGenerationError);
    expect(thrown).toMatchObject({ code: 'upstream_protocol_changed' });
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

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

  it('never promotes a decodable partial preview to a completed image', async () => {
    const body = [
      `data: ${JSON.stringify({ type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: VALID_PNG })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    await expect(parseCandidateCodexImageResponse(body, 1, 'png'))
      .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
  });

  it('uses the final result rather than a larger preview from the same output', async () => {
    const body = [
      `data: ${JSON.stringify({ type: 'response.image_generation_call.partial_image', partial_image_index: 0, partial_image_b64: VALID_PNG })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: {
        status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: VALID_VP8L }],
      } })}`,
      '',
    ].join('\n');
    const parsed = await parseCandidateCodexImageResponse(body, 1, 'webp');
    expect(parsed.images[0]).toMatchObject({ mimeType: 'image/webp', width: 2, height: 1 });
  });

  it.each(['response.failed', 'response.incomplete', 'response.cancelled', 'error'])(
    'does not return success after a %s terminal event', async (type) => {
      const body = [
        `data: ${JSON.stringify({ type: 'response.output_item.done', item: {
          type: 'image_generation_call', status: 'completed', result: VALID_PNG,
        } })}`,
        `data: ${JSON.stringify({ type })}`,
        '',
      ].join('\n');
      await expect(parseCandidateCodexImageResponse(body, 1, 'png'))
        .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    },
  );

  it('rejects an incomplete JSON response even when its image tool completed', async () => {
    const body = JSON.stringify({ status: 'incomplete',
      output: [{ type: 'image_generation_call', status: 'completed', result: VALID_PNG }] });
    await expect(parseCandidateCodexImageResponse(body, 1, 'png'))
      .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
  });

  it('accepts the current Codex SSE variant with the final result in response.completed', async () => {
    const body = [
      'event: response.completed',
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          output: [{
            type: 'image_generation_call',
            status: 'completed',
            result: VALID_PNG,
          }],
        },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const parsed = await parseCandidateCodexImageResponse(body, 1, 'png');
    expect(parsed.images[0]).toMatchObject({
      mimeType: 'image/png',
      width: 2,
      height: 1,
      independentlyDecodable: true,
    });
  });

  it('accepts the live Codex result carried by response.output_item.done', async () => {
    const body = [
      'event: response.output_item.done',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'image_generation_call',
          status: 'completed',
          result: VALID_PNG,
        },
      })}`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const parsed = await parseCandidateCodexImageResponse(body, 1, 'png');
    expect(parsed.images[0]).toMatchObject({
      mimeType: 'image/png',
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

// ---------------------------------------------------------------------------
// Wire options (task 3.3): configurable carrier/tool models — defaults pin the
// shipped constants; `images.codex.{carrierModel,imageModel}` overrides ride the
// same builder; explicit Image 2.5 variants retain their requested model.
// ---------------------------------------------------------------------------

const generateRequest: NormalizedImageGenerateRequest = {
  action: 'generate', model: 'gpt-image-2', prompt: 'wire-options-probe', n: 1,
  quality: 'auto', size: { kind: 'auto' }, background: 'auto', outputFormat: 'png',
  moderation: 'auto', stream: false, partialImages: 0,
};

describe('candidate codex image wire options', () => {
  it('only advertises the base-model override when its actual target is evidenced', () => {
    const layer = {
      kind: 'account' as const, source: 'verified-test', values: { models: ['gpt-image-2'] },
    };
    expect(applyCodexImageModelOverrideEvidence(layer, 'gpt-image-2.5-flare').values?.models)
      .toEqual([]);
    const verifiedVariant = { ...layer, values: { models: ['gpt-image-2.5-flare'] } };
    expect(applyCodexImageModelOverrideEvidence(verifiedVariant, 'gpt-image-2.5-flare').values?.models)
      .toEqual(['gpt-image-2', 'gpt-image-2.5-flare']);
    expect(layer.values.models).toEqual(['gpt-image-2']);
  });

  it('defaults pin the shipped carrier and tool models (byte-level)', async () => {
    const body = JSON.parse(await buildCandidateCodexImageRequest(generateRequest)) as {
      model: string;
      tools: Array<{ model: string }>;
    };
    expect(body.model).toBe(CANDIDATE_CODEX_IMAGE_CARRIER_MODEL);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.tools[0].model).toBe('gpt-image-2');
  });

  it('custom carrierModel and imageModel reach the wire verbatim', async () => {
    const body = JSON.parse(
      await buildCandidateCodexImageRequest(generateRequest, undefined, {
        carrierModel: 'gpt-6-orion',
        imageModel: 'gpt-image-2.5-flare',
      }),
    ) as {
      model: string;
      tools: Array<{ model: string }>;
    };
    expect(body.model).toBe('gpt-6-orion');
    expect(body.tools[0].model).toBe('gpt-image-2.5-flare');
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    'preserves explicit %s despite the configured base-model override', async (model) => {
      const body = JSON.parse(await buildCandidateCodexImageRequest(
        { ...generateRequest, model }, undefined, { imageModel: 'gpt-image-2' },
      ));
      expect(body.tools[0].model).toBe(model);
    },
  );

  it('evidence model dimension follows the configured imageModel', () => {
    const pinned = createCodexImageAdapterEvidence(1_000);
    expect(pinned.source).toBe('codex-image-adapter-declaration');
    expect(pinned.verifiedAt).toBe(1_000);
    const models = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
    expect(pinned.values.models).toEqual(models);

    const configured = createCodexImageAdapterEvidence(1_000, 'custom-image-model');
    // The configured model is advertised; the pinned default stays reachable.
    expect(configured.values.models).toEqual(['custom-image-model', ...models]);

    // Re-declaring the default model must not duplicate the entry.
    const same = createCodexImageAdapterEvidence(1_000, 'gpt-image-2');
    expect(same.values.models).toEqual(models);
    expect(createCodexImageAdapterEvidence(1_000, 'gpt-image-2.5-flare').values.models)
      .toEqual(models);
  });
});
