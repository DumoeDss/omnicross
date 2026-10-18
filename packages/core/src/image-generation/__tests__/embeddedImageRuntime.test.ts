import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { createApiImageProvider } from '../api/ApiImageProvider';
import { BoundedMemoryImageReferenceStore } from '../BoundedMemoryImageReferenceStore';
import { createEmbeddedImageRuntime } from '../createEmbeddedImageRuntime';
import { imageRouteTenantId, routeAllowsHostedImages } from '../imageRouteIdentity';
import { InMemoryImageAsset } from '../ports';
import type { RouteContext } from '../../provider-proxy/types';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const runtimes: ReturnType<typeof createEmbeddedImageRuntime>[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });

describe('embedded image runtime', () => {
  it.each([
    ['wavespeed', 'openai/gpt-image-2.5-sunburst/text-to-image'],
    ['wavespeed', 'google/nano-banana-2.1/text-to-image'],
    ['gemini', 'gemini-nano-banana-2.1'],
  ] as const)('keeps a Codex image tool opaque to a DeepSeek text route using %s / %s', async (protocol, upstreamModel) => {
    const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const fetch = vi.fn(async () => Response.json(protocol === 'wavespeed'
      ? { data: { id: 'job', status: 'completed', outputs: ['https://cdn.example/result.png'] } }
      : { steps: [{ type: 'model_output', content: [{ type: 'image', data: image.toString('base64') }] }] }));
    const routes = { 'gpt-image-2': 'image-api', 'gpt-image-2.5-sunburst': 'image-api' };
    const provider = createApiImageProvider({ id: 'image-api', protocol,
      models: Object.fromEntries(Object.keys(routes).map((model) => [model, upstreamModel])),
      resolveCredentials: async () => ({ baseUrl: 'https://image-api.example', apiKey: 'IMAGE_ONLY_KEY' }),
      downloadOutput: async () => image, fetch,
    });
    const runtime = createEmbeddedImageRuntime({ providers: [provider], modelRoutes: routes, defaultModel: 'gpt-image-2.5-sunburst' });
    runtimes.push(runtime);
    const lease = await runtime.hostedFactory.acquire();
    try {
      const admission = lease.inspectRequest({ model: 'deepseek-chat', tools: [{ type: 'image_generation', model: 'gpt-image-2' }] });
      const scope = await lease.openRequest({ admission, tenantId: 'tenant', requestId: 'request', sessionKey: 'session',
        mainProviderId: 'deepseek', signal: new AbortController().signal });
      const events = [];
      for await (const event of scope.executeSelectedCall({ prompt: 'draw a dot' }, { reserveOutputIndex: () => 0, nextSequenceNumber: () => 0 })) events.push(event);
      expect(events.at(-1)).toMatchObject({ kind: 'completed', item: { type: 'image_generation_call' } });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      if (protocol === 'wavespeed') expect(url).toBe(`https://image-api.example/api/v3/${upstreamModel}`);
      else expect(JSON.parse(String(init.body)).model).toBe(upstreamModel);
      expect(JSON.stringify(events)).not.toContain(upstreamModel);
      expect(JSON.stringify(events)).not.toContain('IMAGE_ONLY_KEY');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await lease.release(); }
  });

  it('routes tools[].model aliases independently of the text/default image model', async () => {
    const fetchDefault = vi.fn();
    const image = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer();
    const fetchSelected = vi.fn(async () => Response.json({ data: [{ b64_json: image.toString('base64') }] }));
    const make = (id: string, model: string, fetch: typeof globalThis.fetch) => createApiImageProvider({ id,
      protocol: 'openai-images', models: { [model]: model }, fetch,
      resolveCredentials: async () => ({ baseUrl: `https://${id}.example/v1`, apiKey: id }),
    });
    const runtime = createEmbeddedImageRuntime({ providers: [make('default', 'gpt-image-2', fetchDefault), make('external', 'gpt-image-2.5-flare', fetchSelected)],
      modelRoutes: { 'gpt-image-2': 'default', 'gpt-image-2.5-flare': 'external' }, defaultModel: 'gpt-image-2',
      aliases: { 'my-image': 'gpt-image-2.5-flare' },
    });
    runtimes.push(runtime);
    const lease = await runtime.hostedFactory.acquire();
    const admission = lease.inspectRequest({ model: 'a-text-model', tools: [{ type: 'image_generation', model: 'my-image' }] });
    const scope = await lease.openRequest({ admission, tenantId: 'tenant', requestId: 'request', sessionKey: 'session',
      mainProviderId: 'text-provider', signal: new AbortController().signal });
    const events = [];
    for await (const event of scope.executeSelectedCall({ prompt: 'draw a red dot' }, { reserveOutputIndex: () => 0, nextSequenceNumber: () => 0 })) events.push(event);
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ kind: 'completed', item: { type: 'image_generation_call' } });
    expect(fetchDefault).not.toHaveBeenCalled();
    expect(fetchSelected).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchSelected.mock.calls[0]?.[1]?.body)).model).toBe('gpt-image-2.5-flare');
    await lease.release();
    runtime.dispose();
    await expect(runtime.hostedFactory.acquire()).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('uses host route authority and never derives a tenant from client headers', () => {
    const route = { imageSession: { tenantId: 'host-session', allowed: true } } as RouteContext;
    expect(imageRouteTenantId(route)).toBe('host-session');
    expect(routeAllowsHostedImages(route)).toBe(true);
    expect(imageRouteTenantId({ imageSession: { tenantId: 'forbidden', allowed: false } } as RouteContext)).toBeUndefined();
    expect(imageRouteTenantId({ headers: { 'x-image-tenant': 'attacker' } } as unknown as RouteContext)).toBeUndefined();
  });
});

describe('bounded embedded retention', () => {
  it('isolates tenants and keeps a deleted/expired pinned lease charged until release', async () => {
    let now = 1;
    const store = new BoundedMemoryImageReferenceStore({ maxBytes: bytes.length, maxEntries: 1, now: () => now });
    const artifact = new InMemoryImageAsset(bytes, { mimeType: 'image/png', width: 1, height: 1 });
    const input = { tenantId: 'one', artifact, ttlMs: 10,
      metadata: { mimeType: 'image/png' as const, width: 1, height: 1, byteLength: bytes.length } };
    const saved = await store.save(input);
    expect(await store.resolve('two', saved.referenceId)).toEqual({ status: 'not_found' });
    const pinned = await store.resolve('one', saved.referenceId);
    if (pinned.status !== 'found') throw new Error('expected lease');
    now = 12;
    await store.cleanup();
    await expect(store.save(input)).rejects.toMatchObject({ code: 'image_too_large' });
    store.clear();
    expect(await store.resolve('one', saved.referenceId)).toEqual({ status: 'not_found' });
    await pinned.lease.release();
    await pinned.lease.release();
    await expect(store.save(input)).resolves.toMatchObject({ byteLength: bytes.length });
  });
});
