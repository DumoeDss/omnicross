/**
 * antigravityImageWire + AntigravitySubscriptionImageProvider tests
 * (multi-provider-image-generation groups 3–4):
 *   - envelope snapshot: the CCA non-stream image shape (responseModalities/
 *     imageConfig/inlineData edit part/requestId/userAgent/requestType),
 *   - size→aspectRatio mapping matrix (exact ratios kept, others omitted),
 *   - response parsing: valid inlineData (full pixel decode), non-PNG mismatch,
 *     text-only no-image failure with a bounded summary, malformed payloads,
 *   - provider: bootstrap-eligible fail-closed evidence, unrouted-format /
 *     multi-image / mask rejection, upstream failure mapping, account binding.
 */

import { InMemoryImageAsset } from '@omnicross/core/image-generation';
import type { AuthStrategy } from '../../auth';
import {
  antigravityAspectRatioFor,
  buildAntigravityImageRequest,
  parseAntigravityImageResponse,
} from '../antigravityImageWire';
import { ANTIGRAVITY_IMAGE_ADAPTER_VALUES } from '../antigravityImageEvidence';
import { createAntigravitySubscriptionImageProvider } from '../AntigravitySubscriptionImageProvider';
import type { ImageProviderContext, ImageProviderRequest } from '@omnicross/core/image-generation';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@omnicross/core/auth/GeminiCodeAssistProjectResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('@omnicross/core/auth/GeminiCodeAssistProjectResolver')>(),
  getAntigravityProjectResolver: () => ({ resolveProject: vi.fn(async () => 'image-project-1') }),
}));

/** A real 1×1 PNG (base64) that survives the full sharp decode. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('buildAntigravityImageRequest', () => {
  it('generates the CCA non-stream image envelope', () => {
    const body = JSON.parse(buildAntigravityImageRequest({
      model: 'gemini-3-pro-image-preview',
      prompt: 'a red square',
      project: 'proj-1',
      aspectRatio: '1:1',
    })) as Record<string, unknown>;
    expect(body.project).toBe('proj-1');
    expect(body.model).toBe('gemini-3-pro-image-preview');
    expect(body.userAgent).toBe('antigravity');
    expect(body.requestType).toBe('agent');
    expect(String(body.requestId)).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/1$/);
    const request = body.request as Record<string, unknown>;
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'a red square' }] }]);
    expect(request.generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    });
    expect(String(request.sessionId)).toMatch(/^-?\d+$/);
  });

  it('carries the edit reference image as an inlineData part before the prompt', () => {
    const body = JSON.parse(buildAntigravityImageRequest({
      model: 'gemini-2.5-flash-image',
      prompt: 'make it blue',
      editImage: { base64: 'QUJD', mimeType: 'image/png' },
    })) as { request: { contents: Array<{ parts: Array<Record<string, unknown>> }> } };
    const parts = body.request.contents[0]!.parts;
    expect(parts[0]).toEqual({ inlineData: { mime_type: 'image/png', data: 'QUJD' } });
    expect(parts[1]).toEqual({ text: 'make it blue' });
    expect((body.request as Record<string, unknown>).generationConfig).toEqual({
      responseModalities: ['TEXT', 'IMAGE'],
    });
  });
});

describe('antigravityAspectRatioFor', () => {
  it('maps exact reduced fractions and omits everything else', () => {
    expect(antigravityAspectRatioFor({ kind: 'pixels', width: 1024, height: 1024 })).toBe('1:1');
    expect(antigravityAspectRatioFor({ kind: 'pixels', width: 1536, height: 1024 })).toBe('3:2');
    expect(antigravityAspectRatioFor({ kind: 'pixels', width: 1024, height: 1536 })).toBe('2:3');
    expect(antigravityAspectRatioFor({ kind: 'pixels', width: 1920, height: 1080 })).toBe('16:9');
    expect(antigravityAspectRatioFor({ kind: 'pixels', width: 1000, height: 777 })).toBeUndefined();
    expect(antigravityAspectRatioFor({ kind: 'auto' })).toBeUndefined();
  });
});

describe('parseAntigravityImageResponse', () => {
  const envelope = (parts: unknown[]) => JSON.stringify({
    response: { candidates: [{ content: { parts } }] },
  });

  it('decodes a valid inlineData PNG through the full pixel decode', async () => {
    const asset = await parseAntigravityImageResponse(envelope([
      { text: 'here you go' },
      { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } },
    ]));
    expect(asset.mimeType).toBe('image/png');
    expect(asset.independentlyDecodable).toBe(true);
    expect([asset.width, asset.height]).toEqual([1, 1]);
    asset.dispose();
  });

  it('rejects a non-PNG actual format as an honest protocol mismatch', async () => {
    await expect(parseAntigravityImageResponse(envelope([
      { inlineData: { mimeType: 'image/jpeg', data: TINY_PNG_BASE64 } },
    ]))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
  });

  it('fails with a bounded text summary when no image part exists', async () => {
    const failure = await parseAntigravityImageResponse(envelope([
      { text: 'safety policy prohibits this request' },
    ])).catch((error: unknown) => error as { code?: string; cause?: Error });
    expect(failure).toMatchObject({ code: 'image_generation_failed' });
    expect(failure.cause?.message).toContain('safety policy');
    await expect(parseAntigravityImageResponse(envelope([])))
      .rejects.toMatchObject({ code: 'image_generation_failed' });
  });

  it('rejects malformed payloads', async () => {
    await expect(parseAntigravityImageResponse('<html>')).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    await expect(parseAntigravityImageResponse('not json')).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    await expect(parseAntigravityImageResponse('{}')).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    await expect(parseAntigravityImageResponse(envelope([
      { inlineData: { mimeType: 'image/png', data: '!!!not-base64!!!' } },
    ]))).rejects.toMatchObject({ code: 'upstream_protocol_changed' });
  });
});

function antigravityStrategy() {
  const applyHeaders = vi.fn(async (
    headers: Record<string, string>,
    hints?: Parameters<AuthStrategy['applyHeaders']>[1],
  ) => {
    headers.Authorization = 'Bearer AG_SENTINEL';
    hints?.reportSelection?.('ag-account-1', true);
  });
  return {
    applyHeaders,
    strategy: {
      kind: 'oauth-bearer',
      providerId: 'antigravity',
      applyHeaders,
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'antigravity', ok: true }; },
    } as AuthStrategy,
  };
}

function context(): ImageProviderContext {
  return { requestId: 'req-1', tenantId: 'tenant-1', signal: new AbortController().signal };
}

function generateRequest(overrides: Partial<ImageProviderRequest> = {}): ImageProviderRequest {
  return {
    action: 'generate',
    prompt: 'a safe test square',
    images: [],
    n: 1,
    quality: 'auto',
    size: { kind: 'pixels', width: 1024, height: 1024 },
    background: 'auto',
    outputFormat: 'png',
    moderation: 'auto',
    partialImages: 0,
    stream: false,
    model: 'gemini-3-pro-image-preview',
    ...overrides,
  } as ImageProviderRequest;
}

describe('AntigravitySubscriptionImageProvider', () => {
  it('bootstrap-eligible: unknown evidence still exposes adapter capability for one attempt', async () => {
    const { strategy } = antigravityStrategy();
    const provider = createAntigravitySubscriptionImageProvider({ authStrategy: strategy });
    const lease = await provider.acquire(context());
    expect(lease.providerId).toBe('antigravity-subscription');
    expect(lease.capabilities.models).toEqual(ANTIGRAVITY_IMAGE_ADAPTER_VALUES.models);
    expect(lease.capabilities.outputFormats).toEqual(['png']);
    await lease.release();
  });

  it('rejects non-auto quality, jpeg output, compression, mask, and multi-image at start', async () => {
    const { strategy } = antigravityStrategy();
    const provider = createAntigravitySubscriptionImageProvider({ authStrategy: strategy });
    const lease = await provider.acquire(context());
    const png = new InMemoryImageAsset(Buffer.from('x', 'utf8'), {
      mimeType: 'image/png', width: 1, height: 1,
    });
    for (const override of [
      generateRequest({ quality: 'high' }),
      generateRequest({ outputFormat: 'jpeg' as never }),
      generateRequest({ outputCompression: 50 } as never),
      generateRequest({ action: 'edit', images: [png, png], mask: png }),
      generateRequest({ model: 'gpt-image-2' }),
    ]) {
      // One attempt per lease: `start` is single-shot by contract.
      const attempt = await provider.acquire(context());
      let code: string | undefined;
      try { attempt.start(override); } catch (error) { code = (error as { code?: string }).code; }
      await attempt.release();
      expect(code).toBe('unsupported_capability');
    }
    await lease.release();
    png.dispose();
  });

  it('maps upstream failures and completes a valid generation end to end', async () => {
    const { applyHeaders, strategy } = antigravityStrategy();
    const calls: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      const respond = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      return respond(200, {
        response: { candidates: [{ content: { parts: [
          { text: 'done' },
          { inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } },
        ] } }] },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = createAntigravitySubscriptionImageProvider({ authStrategy: strategy });
      const lease = await provider.acquire(context());
      const job = await lease.start(generateRequest());
      const events = [];
      for await (const event of job.events) events.push(event);
      await lease.release();
      expect(events.map((event) => event.type)).toEqual(['accepted', 'completed']);
      expect(calls[0]?.url).toContain('daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
      expect(applyHeaders).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resolvedModel: 'gemini-2.5-flash-image' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps an upstream 429 to a stable rate-limit failure', async () => {
    const { strategy } = antigravityStrategy();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'quota' } }), {
        status: 429, headers: { 'Content-Type': 'application/json' },
      })));
    try {
      const provider = createAntigravitySubscriptionImageProvider({ authStrategy: strategy });
      const lease = await provider.acquire(context());
      const job = await lease.start(generateRequest());
      const events = [];
      for await (const event of job.events) events.push(event);
      await lease.release();
      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        error: expect.objectContaining({ code: 'upstream_rate_limited' }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires the antigravity strategy — a codex strategy never serves antigravity leases', async () => {
    const codexStrategy = {
      kind: 'oauth-bearer',
      providerId: 'codex',
      applyHeaders: async () => {},
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', ok: true }; },
    } as AuthStrategy;
    const provider = createAntigravitySubscriptionImageProvider({ authStrategy: codexStrategy });
    await expect(provider.acquire(context())).rejects.toMatchObject({ code: 'upstream_auth_required' });
  });
});
