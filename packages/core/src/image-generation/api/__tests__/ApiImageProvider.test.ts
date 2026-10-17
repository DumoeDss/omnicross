import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import { ImageOrchestrator } from '../../ImageOrchestrator';
import type { ImageProviderRequest } from '../../ImageProvider';
import { ImageProviderRegistry } from '../../ImageProviderRegistry';
import { InMemoryImageAsset } from '../../ports';
import { apiImageCapabilities, createApiImageProvider } from '../ApiImageProvider';
import { buildApiImageRequest } from '../protocols';
import { createApiImageAsset } from '../transport';
import type { ApiImageProviderOptions } from '../types';

const request: ImageProviderRequest = {
  action: 'generate', model: 'public-image', prompt: 'A small landscape', n: 1,
  quality: 'auto', size: { kind: 'auto' }, background: 'auto', outputFormat: 'png',
  moderation: 'auto', stream: false, partialImages: 0,
};
const credentials = { baseUrl: 'https://images.example/v1', apiKey: 'IMAGE_KEY', headers: { authorization: 'TEXT_KEY' } };
async function png() { return sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } }).png().toBuffer(); }
async function collect(options: ApiImageProviderOptions, value = request, signal = new AbortController().signal) {
  const provider = createApiImageProvider(options);
  const orchestrator = new ImageOrchestrator({ registry: new ImageProviderRegistry([provider]) });
  const events = [];
  for await (const event of orchestrator.run(value, { requestId: 'test', tenantId: 'tenant', signal }, { providerId: provider.id })) events.push(event);
  return events;
}
function options(fetch: typeof globalThis.fetch, protocol: ApiImageProviderOptions['protocol'] = 'openai-images'): ApiImageProviderOptions {
  return { id: 'image-api', protocol, models: { 'public-image': 'gpt-image-2.5-sunburst' }, resolveCredentials: async () => credentials, fetch };
}

describe('API image providers', () => {
  it('uses Google image capabilities without changing OpenRouter model IDs', () => {
    const opts = { ...options(vi.fn(), 'openrouter'), models: { banana: 'google/gemini-nano-banana-2.1', lite: 'google/gemini-3.1-flash-lite-image' } };
    expect(apiImageCapabilities(opts, true, 'banana').aspectRatios).toContain('1:8');
    expect(apiImageCapabilities(opts, true, 'banana').resolutions).toEqual(['1K', '2K', '4K']);
    expect(apiImageCapabilities(opts, true, 'lite').resolutions).toEqual(['1K']);
    expect(opts.models.banana).toBe('google/gemini-nano-banana-2.1');
  });
  it.each(['xhigh', 'max'] as const)('supports %s quality only for GPT Image 2.5 routes', async (quality) => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: (await png()).toString('base64') }] }));
    expect((await collect(options(fetch), { ...request, quality })).at(-1)?.type).toBe('completed');
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).quality).toBe(quality);
    const old = { ...options(fetch), models: { 'public-image': 'gpt-image-2' } };
    await expect(collect(old, { ...request, quality })).rejects.toMatchObject({ code: 'unsupported_capability', param: 'quality' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves the mapped image model and isolates credentials from text authorization', async () => {
    const bytes = await png();
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: bytes.toString('base64') }] }));
    const events = await collect(options(fetch));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://images.example/v1/images/generations');
    expect(JSON.parse(String(init.body)).model).toBe('gpt-image-2.5-sunburst');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer IMAGE_KEY');
    expect(JSON.stringify(init)).not.toContain('TEXT_KEY');
    expect(events.map((event) => event.type)).toEqual(['accepted', 'completed']);
    expect(events[1]).toMatchObject({ images: [{ artifact: { width: 16, height: 16, mimeType: 'image/png' } }] });
  });

  it('uploads edits and masks as multipart rather than sending data URLs to Images', async () => {
    const bytes = await png();
    const image = await createApiImageAsset(bytes, { maxBytes: 1024 * 1024, maxPixels: 1024 });
    const invocation = await buildApiImageRequest('openai-images', credentials, 'gpt-image-2.5-flare',
      { ...request, action: 'edit', images: [image], mask: image }, new AbortController().signal);
    const form = invocation.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-flare');
    expect(form.get('image')).toBeInstanceOf(Blob);
    expect(form.get('mask')).toBeInstanceOf(Blob);
    expect(new Headers(invocation.init.headers).has('content-type')).toBe(false);
  });

  it('uses the Interactions object response format for Nano Banana 2.1', async () => {
    const bytes = await png();
    const fetch = vi.fn(async () => Response.json({ steps: [
      { type: 'thought', summary: [{ type: 'image', data: 'not-an-output' }] },
      { type: 'model_output', content: [{ type: 'image', data: bytes.toString('base64') }, { type: 'text', text: 'Generated.' }] },
    ] }));
    const opts = { ...options(fetch, 'gemini'), models: { 'public-image': 'gemini-nano-banana-2.1' },
      resolveCredentials: async () => ({ ...credentials, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models' }) };
    const events = await collect(opts, { ...request, resolution: '4K', aspectRatio: '1:8' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gemini-nano-banana-2.1', response_format: { type: 'image', image_size: '4K', aspect_ratio: '1:8' } });
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('IMAGE_KEY');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'completed', providerMessage: 'Generated.' });
    expect(apiImageCapabilities(opts, true, 'public-image').resolutions).not.toContain('512');
  });

  it('never repeats a paid WaveSpeed submission while retrying result polling', async () => {
    const bytes = await png();
    let polls = 0;
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ code: 200, data: { id: 'job-1', status: 'processing', urls: { get: 'https://untrusted.example/steal' } } });
      polls++;
      return polls === 1 ? new Response('', { status: 503 }) : Response.json({ data: { id: 'job-1', status: 'completed', outputs: ['https://cdn.example/image.png'] } });
    });
    const events = await collect({ ...options(fetch, 'wavespeed'), models: { 'public-image': 'wavespeed-ai/z-image/turbo' },
      pollIntervalMs: 1, downloadOutput: async () => bytes });
    expect(events.at(-1)?.type).toBe('completed');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith('https://images.example/'))).toBe(true);
    expect(polls).toBe(2);
  });

  it('routes WaveSpeed GPT Image 2.5 edits to the dedicated edit endpoint with an image array', async () => {
    const bytes = await png();
    const fetch = vi.fn(async () => Response.json({ data: { id: 'job-e', status: 'completed', outputs: ['https://cdn.example/e.png'] } }));
    const image = await createApiImageAsset(bytes, { maxBytes: 1024 * 1024, maxPixels: 1024 });
    const second = await createApiImageAsset(bytes, { maxBytes: 1024 * 1024, maxPixels: 1024 });
    const invocation = await buildApiImageRequest('wavespeed', credentials, 'openai/gpt-image-2.5-sunburst/text-to-image',
      { ...request, action: 'edit', images: [image, second], aspectRatio: '16:9', resolution: '2K', quality: 'xhigh' },
      new AbortController().signal, async (asset) => asset === image ? 'https://pub.example/a.png' : 'https://pub.example/b.png');
    expect(invocation.url).toBe('https://images.example/v1/api/v3/openai/gpt-image-2.5-sunburst/edit');
    const body = JSON.parse(String(invocation.init.body));
    expect(body.images).toEqual(['https://pub.example/a.png', 'https://pub.example/b.png']);
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.resolution).toBe('2k');
    expect(body.quality).toBe('xhigh');
  });

  it('advertises per-model WaveSpeed capabilities for Nano Banana 2.1', () => {
    const opts = { ...options(vi.fn(), 'wavespeed'), models: { 'public-nb21': 'google/nano-banana-2.1/text-to-image' },
      publishInput: async () => 'https://pub.example/x.png' };
    const caps = apiImageCapabilities(opts, true, 'public-nb21');
    expect(caps.edit).toBe(true);
    expect(caps.maxInputImages).toBe(14);
    expect(caps.aspectRatios).toContain('8:1');
    expect(caps.resolutions).toEqual(['1K', '2K', '4K']);
    expect(caps.qualityLevels).toEqual(['auto']);
    expect(caps.outputFormats).toEqual(['png', 'jpeg']);
  });

  it('keeps single-image WaveSpeed edits on the z-image body shape', async () => {
    const bytes = await png();
    const image = await createApiImageAsset(bytes, { maxBytes: 1024 * 1024, maxPixels: 1024 });
    const invocation = await buildApiImageRequest('wavespeed', credentials, 'wavespeed-ai/z-image/turbo',
      { ...request, action: 'edit', images: [image], size: { kind: 'pixels', width: 1024, height: 1024 } },
      new AbortController().signal, async () => 'https://pub.example/z.png');
    expect(invocation.url).toBe('https://images.example/v1/api/v3/wavespeed-ai/z-image/turbo');
    const body = JSON.parse(String(invocation.init.body));
    expect(body.image).toBe('https://pub.example/z.png');
    expect(body.images).toBeUndefined();
  });

  it('rejects invalid raster output and masks upstream error bodies', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
    expect((await collect(options(fetch))).at(-1)).toMatchObject({ type: 'failed', error: { code: 'unsupported_image_type' } });
    const denied = await collect(options(async () => new Response('SECRET_UPSTREAM_BODY', { status: 401 })));
    expect(denied.at(-1)).toMatchObject({ type: 'failed', error: { code: 'upstream_auth_required' } });
    expect(JSON.stringify(denied)).not.toContain('SECRET_UPSTREAM_BODY');
  });

  it('propagates cancellation to polling without another submission', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); return Response.json({ data: { id: 'job-1', status: 'processing' } }); });
    await expect(collect({ ...options(fetch, 'wavespeed'), models: { 'public-image': 'wavespeed-ai/z-image/turbo' } }, request, controller.signal))
      .rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized declared history before contacting the API', async () => {
    const fetch = vi.fn();
    const image = new InMemoryImageAsset(new Uint8Array([1]), { mimeType: 'image/png', width: 1, height: 1 });
    const history = Array.from({ length: 101 }, () => ({ role: 'user' as const, images: [image] }));
    await expect(collect(options(fetch), { ...request, history })).rejects.toMatchObject({ code: 'image_too_large' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
