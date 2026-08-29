import { afterEach, describe, expect, it } from 'vitest';

import { createImageContractHarness, type ImageContractHarness } from './contractHarness';

type OpenAIAPIError = import('openai').APIError;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
  throw new Error(
    `The official OpenAI JavaScript SDK contract requires Node.js 22 or newer; current runtime is ${process.version}.`,
  );
}
const { default: OpenAI, APIError, toFile } = await import('openai');

const harnesses: ImageContractHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function setup(options: Parameters<typeof createImageContractHarness>[0] = {}) {
  const harness = await createImageContractHarness(options);
  harnesses.push(harness);
  return {
    harness,
    client: new OpenAI({ apiKey: harness.token, baseURL: harness.baseURL, maxRetries: 0 }),
  };
}

describe('OpenAI JavaScript SDK 7.8.0 Images contract', () => {
  it('generates exact non-stream Base64 outputs with optional verified usage', async () => {
    const { client, harness } = await setup({ usage: true });
    const result = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'draw a safe test square',
      n: 2,
      output_format: 'png',
      quality: 'high',
      size: '1024x1024',
    });
    expect(result.data).toHaveLength(2);
    for (const item of result.data) {
      expect(Buffer.from(item.b64_json!, 'base64')).toEqual(harness.outputBytes.png);
      expect(item.revised_prompt).toMatch(/^safe revision/);
    }
    expect((result as unknown as { usage: { total_tokens: number } }).usage.total_tokens).toBe(7);
    expect(harness.capture.starts).toBe(1);
    expect(harness.capture.requests[0]).toMatchObject({
      action: 'generate',
      model: 'gpt-image-1',
      n: 2,
      outputFormat: 'png',
    });
    expect(harness.capture.contexts[0]?.tenantId).toBe(harness.tenantId);
    expect(harness.capture.contexts[0]?.tenantId).not.toBe(harness.token);
  });

  it('supports official multipart single/multi-image edit and alpha mask ordering', async () => {
    const { client, harness } = await setup();
    const single = await client.images.edit({
      model: 'gpt-image-1',
      prompt: 'edit one',
      image: await toFile(harness.inputPng, 'caller-controlled.png', { type: 'text/plain' }),
      output_format: 'png',
    });
    expect(Buffer.from(single.data[0]!.b64_json!, 'base64')).toEqual(harness.outputBytes.png);

    const multiple = await client.images.edit({
      model: 'gpt-image-1',
      prompt: 'edit references with a mask',
      image: [
        await toFile(harness.inputPng, '../primary.bin', { type: 'application/octet-stream' }),
        await toFile(harness.inputJpeg, 'reference.png', { type: 'image/png' }),
      ],
      mask: await toFile(harness.maskPng, 'mask.png', { type: 'image/png' }),
      output_format: 'png',
    });
    expect(Buffer.from(multiple.data[0]!.b64_json!, 'base64')).toEqual(harness.outputBytes.png);
    expect(harness.capture.requests[1]).toMatchObject({ action: 'edit' });
    const request = harness.capture.requests[1];
    if (request?.action !== 'edit') throw new Error('expected captured edit');
    expect(request.images.map((image) => image.mimeType)).toEqual(['image/png', 'image/jpeg']);
    expect(request.mask).toMatchObject({ mimeType: 'image/png', hasAlpha: true });
  });

  it.each([
    ['png', 'transparent'],
    ['webp', 'transparent'],
  ] as const)('preserves %s transparent generation options', async (outputFormat, background) => {
    const { client, harness } = await setup();
    const result = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'transparent test',
      background,
      output_format: outputFormat,
    });
    expect(Buffer.from(result.data[0]!.b64_json!, 'base64')).toEqual(harness.outputBytes[outputFormat]);
    expect(harness.capture.requests[0]).toMatchObject({ background, outputFormat });
  });

  it('parses partial/completed SSE events with independent bytes and indexes', async () => {
    const { client, harness } = await setup({ usage: true });
    const stream = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'stream the test',
      n: 2,
      stream: true,
      partial_images: 2,
      output_format: 'webp',
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'image_generation.partial_image',
      'image_generation.partial_image',
      'image_generation.partial_image',
      'image_generation.partial_image',
      'image_generation.completed',
      'image_generation.completed',
    ]);
    expect(events.slice(0, 4).map((event) => [event.output_index, event.partial_image_index])).toEqual([
      [0, 0], [1, 0], [0, 1], [1, 1],
    ]);
    for (const event of events.slice(0, 4)) {
      expect(Buffer.from(event.b64_json as string, 'base64')).not.toEqual(harness.outputBytes.webp);
    }
    for (const event of events.slice(4)) {
      expect(Buffer.from(event.b64_json as string, 'base64')).toEqual(harness.outputBytes.webp);
    }
    expect(events.at(-1)?.usage).toMatchObject({ total_tokens: 7 });
  });

  it('parses official multipart edit streaming events', async () => {
    const { client, harness } = await setup();
    const stream = await client.images.edit({
      model: 'gpt-image-1',
      prompt: 'stream an edit',
      image: await toFile(harness.inputPng, 'primary.png', { type: 'image/png' }),
      mask: await toFile(harness.maskPng, 'mask.png', { type: 'image/png' }),
      stream: true,
      partial_images: 1,
      output_format: 'png',
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) events.push(event as unknown as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'image_edit.partial_image',
      'image_edit.completed',
    ]);
    expect(Buffer.from(events[1]!.b64_json as string, 'base64')).toEqual(harness.outputBytes.png);
  });

  it('returns stable representative errors before provider start', async () => {
    const { client, harness } = await setup();
    const error = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'invalid combination',
      background: 'transparent',
      output_format: 'jpeg',
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as OpenAIAPIError).status).toBe(400);
    expect((error as OpenAIAPIError).code).toBe('invalid_image_request');
    expect(harness.capture.starts).toBe(0);
  });

  it('keeps unregistered Images operations at 501', async () => {
    const { client, harness } = await setup({ register: false });
    const error = await client.images.generate({ prompt: 'never read' }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APIError);
    expect((error as OpenAIAPIError).status).toBe(501);
    expect((error as OpenAIAPIError).code).toBe('unsupported_capability');
    expect(harness.capture.starts).toBe(0);
  });

  it('cancels the provider when the streaming client disconnects', async () => {
    const { client, harness } = await setup({
      onAccepted: () => new Promise((resolve) => setTimeout(resolve, 150)),
    });
    const controller = new AbortController();
    const stream = await client.images.generate({
      model: 'gpt-image-1',
      prompt: 'cancel me',
      stream: true,
      partial_images: 0,
    }, { signal: controller.signal });
    controller.abort();
    await (async () => {
      for await (const _event of stream) { /* no terminal expected */ }
    })();
    await harness.waitForIdle();
    expect(harness.capture.cancels).toBe(1);
  });
});
