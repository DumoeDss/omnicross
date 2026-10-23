import type { ImageUsage } from '@omnicross/contracts/image-generation-types';

import { buildGeminiModelActionUrl } from '../../completion/url-builder';
import { ImageGenerationError } from '../errors';
import type { ImageProviderRequest } from '../ImageProvider';
import { readImageAssetBytes, type ImageAsset } from '../ports';

import { apiUrl, object } from './transport';
import type { ApiImageProviderOptions, ImageApiCredentials, ImageApiProtocol } from './types';

export interface ApiImageRequest {
  readonly url: string;
  readonly init: RequestInit;
}

export interface ApiImageOutput {
  readonly base64?: string;
  readonly url?: string;
  readonly revisedPrompt?: string;
}

export interface ApiImageResponse {
  readonly images: readonly ApiImageOutput[];
  readonly message?: string;
  readonly usage?: ImageUsage;
}

/** Wire-verified WaveSpeed route facts; every entry is sourced from the upstream model docs. */
export interface WaveSpeedModelProfile {
  readonly dimensions: 'aspect-resolution' | 'pixels' | 'none';
  /** Upstream route used for edit requests; omitted when the route has no edit endpoint. */
  readonly editRoute?: string;
  readonly editField: 'image' | 'images';
  readonly maxEditImages: number;
  readonly aspectRatios?: readonly string[];
  /** Lowercase wire values; capabilities advertise the uppercased forms. */
  readonly resolutions?: readonly string[];
  /** Non-auto quality tiers accepted upstream. */
  readonly quality?: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  readonly outputFormats?: readonly ('png' | 'jpeg' | 'webp')[];
}

const WAVE_RATIOS_10 = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
const WAVE_RATIOS_15 = [...WAVE_RATIOS_10, '1:2', '2:1', '1:3', '3:1', '9:21'] as const;
const WAVE_RATIOS_14 = [...WAVE_RATIOS_10, '1:4', '4:1', '1:8', '8:1'] as const;

const WAVE_SPEED_PROFILES: Readonly<Record<string, WaveSpeedModelProfile>> = {
  'openai/gpt-image-2.5-flare/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'openai/gpt-image-2.5-flare/edit',
    editField: 'images', maxEditImages: 16,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '2k', '4k'],
    quality: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'openai/gpt-image-2.5-sunburst/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'openai/gpt-image-2.5-sunburst/edit',
    editField: 'images', maxEditImages: 16,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '2k', '4k'],
    quality: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'openai/gpt-image-2/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'openai/gpt-image-2/edit',
    editField: 'images', maxEditImages: 16,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '2k', '4k'],
    quality: ['low', 'medium', 'high'],
  },
  'openai/gpt-image-1.5/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'google/nano-banana-2.1/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'google/nano-banana-2.1/edit',
    editField: 'images', maxEditImages: 14,
    aspectRatios: WAVE_RATIOS_14, resolutions: ['1k', '2k', '4k'],
    outputFormats: ['png', 'jpeg'],
  },
  'google/nano-banana-2/text-to-image': {
    dimensions: 'aspect-resolution', editField: 'images', maxEditImages: 14,
    aspectRatios: WAVE_RATIOS_14, resolutions: ['0.5k', '1k', '2k', '4k'],
    outputFormats: ['png', 'jpeg'],
  },
  'google/nano-banana-pro/text-to-image': {
    dimensions: 'aspect-resolution', editField: 'images', maxEditImages: 14,
    aspectRatios: WAVE_RATIOS_10, resolutions: ['1k', '2k', '4k'],
    outputFormats: ['png', 'jpeg'],
  },
  'google/gemini-3-pro-image/text-to-image': {
    dimensions: 'aspect-resolution', editField: 'images', maxEditImages: 14,
    aspectRatios: WAVE_RATIOS_10, resolutions: ['1k', '2k', '4k'],
    outputFormats: ['png', 'jpeg'],
  },
  'bytedance/seedream-v5.0-pro': {
    dimensions: 'aspect-resolution', editRoute: 'bytedance/seedream-v5.0-pro/edit',
    editField: 'images', maxEditImages: 10,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '1.5k', '2k'],
  },
  'bytedance/seedream-v5.0-flash': {
    dimensions: 'aspect-resolution', editRoute: 'bytedance/seedream-v5.0-flash/edit',
    editField: 'images', maxEditImages: 10,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '1.5k', '2k'],
  },
  'bytedance/seedream-v4.5': {
    dimensions: 'pixels', editRoute: 'bytedance/seedream-v4.5/edit',
    editField: 'images', maxEditImages: 10,
  },
  'wavespeed-ai/flux-3-klein-image-base/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'wavespeed-ai/flux-3-klein-image-base/edit',
    editField: 'images', maxEditImages: 3,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '2k'],
  },
  'wavespeed-ai/flux-2-klein-9b/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'wavespeed-ai/qwen-image-2.0/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'wavespeed-ai/qwen-image/text-to-image-2512': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'alibaba/qwen-image-3.0/text-to-image': {
    dimensions: 'aspect-resolution', editRoute: 'alibaba/qwen-image-3.0/edit',
    editField: 'images', maxEditImages: 3,
    aspectRatios: WAVE_RATIOS_15, resolutions: ['1k', '2k'],
  },
  'alibaba/wan-2.7/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'alibaba/wan-2.6/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'alibaba/wan-2.5/text-to-image': { dimensions: 'pixels', editField: 'image', maxEditImages: 1 },
  'wavespeed-ai/z-image/turbo': {
    dimensions: 'pixels', editRoute: 'wavespeed-ai/z-image/turbo',
    editField: 'image', maxEditImages: 1,
    outputFormats: ['jpeg', 'png', 'webp'],
  },
};

const WAVE_PIXELS_FALLBACK = /^(?:bytedance\/seedream-|wavespeed-ai\/(?:qwen-image|flux-2-klein-|z-image\/)|alibaba\/wan-)/u;

export function waveSpeedModelProfile(model: string): WaveSpeedModelProfile {
  return WAVE_SPEED_PROFILES[model] ?? {
    dimensions: WAVE_PIXELS_FALLBACK.test(model) ? 'pixels' : 'none',
    editField: 'image', maxEditImages: 1,
  };
}

export function waveSpeedDimensionMode(model: string): 'aspect-resolution' | 'pixels' | 'none' {
  return waveSpeedModelProfile(model).dimensions;
}

async function inline(asset: ImageAsset, signal: AbortSignal): Promise<{ data: string; mimeType: string }> {
  const bytes = await readImageAssetBytes(asset, 50 * 1024 * 1024, signal);
  return { data: Buffer.from(bytes).toString('base64'), mimeType: asset.mimeType };
}

async function dataUrl(asset: ImageAsset, signal: AbortSignal): Promise<string> {
  const value = await inline(asset, signal);
  return `data:${value.mimeType};base64,${value.data}`;
}

function headers(credentials: ImageApiCredentials, protocol: ImageApiProtocol): Record<string, string> {
  const output: Record<string, string> = { ...credentials.headers, 'Content-Type': 'application/json' };
  // Auth comes only from the selected image provider, never from client headers.
  for (const key of Object.keys(output)) {
    if (['authorization', 'x-goog-api-key', 'content-type', 'host', 'content-length'].includes(key.toLowerCase())) delete output[key];
  }
  output['Content-Type'] = 'application/json';
  const googleKey = credentials.apiKey.startsWith('AIza') || new URL(credentials.baseUrl).hostname === 'generativelanguage.googleapis.com';
  if (((protocol === 'gemini' || protocol === 'gemini-interactions') && googleKey) || (protocol === 'vertex' && credentials.apiKey.startsWith('AIza'))) {
    output['x-goog-api-key'] = credentials.apiKey;
  } else output.Authorization = `Bearer ${credentials.apiKey}`;
  return output;
}

export async function buildApiImageRequest(
  protocol: ImageApiProtocol, credentials: ImageApiCredentials, model: string,
  request: ImageProviderRequest, signal: AbortSignal,
  publishInput?: ApiImageProviderOptions['publishInput'],
): Promise<ApiImageRequest> {
  const auth = headers(credentials, protocol);
  let url: string;
  let body: Record<string, unknown>;
  if (protocol === 'openai-images' || protocol === 'xai') {
    url = apiUrl(credentials.baseUrl, request.action === 'edit' ? 'images/edits' : 'images/generations');
    body = { model, prompt: request.prompt, n: request.n };
    if (protocol === 'xai') {
      body.response_format = 'b64_json';
      if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
    } else {
      body.quality = request.quality;
      body.size = request.size.kind === 'pixels' ? `${request.size.width}x${request.size.height}` : 'auto';
      body.background = request.background;
      body.output_format = request.outputFormat;
      body.moderation = request.moderation;
      if (request.outputCompression !== undefined) body.output_compression = request.outputCompression;
      if (request.userFingerprint) body.user = request.userFingerprint;
    }
    if (request.action === 'edit') {
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) form.append(key, String(value));
      for (let index = 0; index < request.images.length; index++) {
        const asset = request.images[index]!;
        const bytes = await readImageAssetBytes(asset, 50 * 1024 * 1024, signal);
        form.append(request.images.length === 1 ? 'image' : 'image[]', new Blob([new Uint8Array(bytes)], { type: asset.mimeType }), `image-${index}`);
      }
      if (request.mask) {
        const bytes = await readImageAssetBytes(request.mask, 50 * 1024 * 1024, signal);
        form.append('mask', new Blob([new Uint8Array(bytes)], { type: request.mask.mimeType }), 'mask.png');
      }
      delete auth['Content-Type'];
      return { url, init: { method: 'POST', headers: auth, body: form, signal, redirect: 'error' } };
    }
  } else if (protocol === 'openrouter') {
    url = apiUrl(credentials.baseUrl.replace(/\/api\/v1\/?$/u, '/api/v1'), 'chat/completions');
    const content: unknown[] = [{ type: 'text', text: request.prompt }];
    if (request.action === 'edit') for (const image of request.images) content.push({ type: 'image_url', image_url: { url: await dataUrl(image, signal) } });
    const messages: unknown[] = [];
    for (const turn of request.history ?? []) {
      const parts: unknown[] = turn.text ? [{ type: 'text', text: turn.text }] : [];
      for (const image of turn.images ?? []) parts.push({ type: 'image_url', image_url: { url: await dataUrl(image, signal) } });
      messages.push({ role: turn.role, content: parts });
    }
    messages.push({ role: 'user', content });
    body = { model, messages, modalities: request.onlyImage ? ['image'] : ['image', 'text'] };
    if (request.aspectRatio || request.resolution) body.image_config = {
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.resolution ? { image_size: request.resolution } : {}),
    };
  } else if (protocol === 'gemini-interactions' || (protocol === 'gemini' && model === 'gemini-nano-banana-2.1')) {
    url = apiUrl(credentials.baseUrl.replace(/\/(?:v1beta|v1)(?:\/models)?\/?$/u, ''), 'interactions', 'v1beta');
    const input: unknown[] = [{ type: 'text', text: request.prompt }];
    if (request.action === 'edit') for (const image of request.images) {
      const value = await inline(image, signal);
      input.push({ type: 'image', data: value.data, mime_type: value.mimeType });
    }
    // Replaying bounded conversation turns works without server-side interaction storage.
    const turns: unknown[] = [];
    for (const turn of request.history ?? []) {
      const content: unknown[] = turn.text ? [{ type: 'text', text: turn.text }] : [];
      for (const image of turn.images ?? []) {
        const value = await inline(image, signal);
        content.push({ type: 'image', data: value.data, mime_type: value.mimeType });
      }
      turns.push({ role: turn.role === 'assistant' ? 'model' : 'user', content });
    }
    body = { model, input: turns.length ? [...turns, { role: 'user', content: input }] : input };
    body.response_format = { type: 'image', mime_type: `image/${request.outputFormat}`,
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.resolution ? { image_size: request.resolution } : {}),
    };
  } else if (protocol === 'gemini' || protocol === 'vertex') {
    const imagen = model.startsWith('imagen-');
    url = protocol === 'vertex'
      ? `${credentials.baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:${imagen ? 'predict' : 'generateContent'}`
      : buildGeminiModelActionUrl(credentials.baseUrl, model, imagen ? 'predict' : 'generateContent');
    if (imagen) {
      body = { instances: [{ prompt: request.prompt }], parameters: { sampleCount: request.n,
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      } };
    } else {
      const contents: unknown[] = [];
      for (const turn of request.history ?? []) {
        const parts: unknown[] = turn.text ? [{ text: turn.text }] : [];
        for (const image of turn.images ?? []) parts.push({ inlineData: await inline(image, signal) });
        contents.push({ role: turn.role === 'assistant' ? 'model' : 'user', parts });
      }
      const parts: unknown[] = [{ text: request.prompt }];
      if (request.action === 'edit') for (const image of request.images) parts.push({ inlineData: await inline(image, signal) });
      contents.push({ role: 'user', parts });
      body = { contents, generationConfig: {
        candidateCount: 1, responseModalities: request.onlyImage ? ['IMAGE'] : ['TEXT', 'IMAGE'],
        ...((request.aspectRatio || request.resolution) ? { imageConfig: {
          ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
          ...(request.resolution ? { imageSize: request.resolution } : {}),
        } } : {}),
      } };
    }
  } else {
    const profile = waveSpeedModelProfile(model);
    const route = request.action === 'edit' ? profile.editRoute ?? model : model;
    url = apiUrl(credentials.baseUrl.replace(/\/api\/v3\/?$/u, ''), route.split('/').map(encodeURIComponent).join('/'), 'api/v3');
    body = { prompt: request.prompt };
    if (profile.dimensions === 'aspect-resolution') {
      if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
      if (request.resolution) body.resolution = request.resolution === '512' ? '0.5k' : request.resolution.toLowerCase();
      if (request.quality !== 'auto' && profile.quality?.includes(request.quality)) body.quality = request.quality;
    } else if (profile.dimensions === 'pixels' && request.size.kind === 'pixels') body.size = `${request.size.width}x${request.size.height}`;
    if (request.action === 'edit') {
      if (!publishInput) throw new ImageGenerationError('unsupported_capability', { param: 'images' });
      const published: string[] = [];
      for (const image of request.images) {
        const value = await publishInput(image, signal);
        published.push(value);
      }
      if (profile.editField === 'image') {
        if (published.length !== 1) throw new ImageGenerationError('unsupported_capability', { param: 'images' });
        body.image = published[0];
      } else body.images = published;
    }
  }
  return { url, init: { method: 'POST', headers: auth, body: JSON.stringify(body), signal, redirect: 'error' } };
}

export function parseApiImageResponse(protocol: ImageApiProtocol, payload: Record<string, unknown>): ApiImageResponse {
  const images: ApiImageOutput[] = [];
  const messages: string[] = [];
  const add = (value: unknown): void => {
    const item = object(value);
    const base64 = item.b64_json ?? item.bytesBase64Encoded ?? item.data;
    const url = item.url ?? object(item.image_url).url;
    if (typeof base64 === 'string') images.push({ base64, ...(typeof item.revised_prompt === 'string' ? { revisedPrompt: item.revised_prompt } : {}) });
    else if (typeof url === 'string') images.push(url.startsWith('data:') ? { base64: url } : { url });
  };
  if (protocol === 'openai-images' || protocol === 'xai') {
    if (Array.isArray(payload.data)) payload.data.forEach(add);
  } else if (protocol === 'openrouter') {
    const message = object(object(Array.isArray(payload.choices) ? payload.choices[0] : undefined).message);
    if (Array.isArray(message.images)) message.images.forEach(add);
    if (typeof message.content === 'string') messages.push(message.content);
  } else if (protocol === 'wavespeed') {
    const data = object(payload.data ?? payload);
    if (Array.isArray(data.outputs)) for (const value of data.outputs) add(typeof value === 'string' ? { url: value } : value);
  } else {
    if (Array.isArray(payload.predictions)) payload.predictions.forEach(add);
    for (const candidate of Array.isArray(payload.candidates) ? payload.candidates : []) {
      const content = object(object(candidate).content);
      for (const part of Array.isArray(content.parts) ? content.parts : []) {
        const item = object(part);
        if (item.thought === true) continue;
        if (item.inlineData || item.inline_data) add(item.inlineData ?? item.inline_data);
        if (typeof item.text === 'string') messages.push(item.text);
      }
    }
    const blocks = (Array.isArray(payload.steps) ? payload.steps : []).flatMap((step) => {
      const item = object(step);
      return item.type === 'model_output' && Array.isArray(item.content) ? item.content : [];
    });
    if (!blocks.length && payload.output_image) blocks.push({ ...object(payload.output_image), type: 'image' });
    if (!blocks.length && Array.isArray(payload.outputs)) blocks.push(...payload.outputs);
    for (const output of blocks) {
      const item = object(output);
      if (item.type === 'image') add(item);
      if (item.type === 'text' && typeof item.text === 'string') messages.push(item.text);
    }
  }
  const rawUsage = object(payload.usage ?? payload.usageMetadata);
  const usage: Record<string, number> = {};
  for (const [field, names] of Object.entries({
    totalTokens: ['total_tokens', 'totalTokenCount'], inputTokens: ['input_tokens', 'promptTokenCount'],
    outputTokens: ['output_tokens', 'candidatesTokenCount'],
  })) {
    const value = names.map((name) => rawUsage[name]).find((item) => typeof item === 'number');
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[field] = value;
  }
  return { images, ...(messages.length ? { message: messages.join('\n').slice(0, 32_000) } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}
