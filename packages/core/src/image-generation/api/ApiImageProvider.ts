import type { ImageCapabilities, ImageProviderEvent, ImageProviderOutput } from '@omnicross/contracts/image-generation-types';

import { ImageGenerationError, serializeImageGenerationError } from '../errors';
import type { ImageProvider, ImageProviderContext, ImageProviderRequest } from '../ImageProvider';
import type { ImageAsset } from '../ports';

import { buildApiImageRequest, parseApiImageResponse, waveSpeedModelProfile } from './protocols';
import { abortableDelay, apiUrl, createApiImageAsset, decodeImageBase64, downloadApiImage, object, responseJson } from './transport';
import type { ApiImageProviderOptions, ImageApiCredentials } from './types';

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function apiImageCapabilities(options: ApiImageProviderOptions, available: boolean, model?: string): ImageCapabilities {
  const nativeGoogle = ['gemini', 'gemini-interactions', 'vertex'].includes(options.protocol);
  const upstream = model ? options.models[model] ?? model : Object.values(options.models)[0] ?? '';
  const catalogModel = options.protocol === 'openrouter' ? upstream.replace(/^google\//u, '') : upstream;
  const imagen = nativeGoogle && upstream.startsWith('imagen-');
  const openai = options.protocol === 'openai-images';
  const profile = options.protocol === 'wavespeed' ? waveSpeedModelProfile(upstream) : undefined;
  const waveEdit = Boolean(profile?.editRoute && options.publishInput);
  const edit = !imagen && (openai || nativeGoogle || options.protocol === 'openrouter' || waveEdit);
  return {
    available, ...(!available ? { reason: 'account_unverified' as const } : {}),
    models: Object.keys(options.models), generate: true, edit, maskEdit: openai,
    maxInputImages: edit ? (openai ? 16 : profile?.maxEditImages ?? 14) : 0,
    maxOutputImages: imagen ? 4 : 10,
    // The job emits accepted/final events; no partial preview is advertised.
    streaming: true, maxPartialImages: 0,
    transparentBackground: openai,
    flexibleSizes: openai || profile?.dimensions === 'pixels',
    ...(!openai && (profile === undefined || profile.dimensions === 'aspect-resolution') ? { aspectRatios: options.protocol === 'xai'
      ? ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2']
      : imagen ? ['1:1', '3:4', '4:3', '9:16', '16:9']
      : catalogModel === 'gemini-nano-banana-2.1' || catalogModel === 'gemini-3.1-flash-image'
        ? [...RATIOS, '1:4', '4:1', '1:8', '8:1']
      : profile?.aspectRatios ? [...profile.aspectRatios] : RATIOS } : {}),
    ...(!imagen && (nativeGoogle || options.protocol === 'openrouter' || profile?.dimensions === 'aspect-resolution')
      ? { resolutions: catalogModel.startsWith('gemini-2.5') || catalogModel === 'gemini-3.1-flash-lite-image' ? ['1K']
        : catalogModel === 'gemini-3.1-flash-image' ? ['512', '1K', '2K', '4K']
      : profile?.resolutions ? profile.resolutions.map((value) => value === '0.5k' ? '512' : value.toUpperCase()) : ['1K', '2K', '4K'] } : {}),
    outputFormats: profile?.outputFormats ? [...profile.outputFormats] : ['png', 'jpeg', 'webp'],
    qualityLevels: openai ? /^gpt-image-2\.5-(?:flare|sunburst)$/u.test(upstream)
      ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high']
      : profile?.quality ? ['auto', ...profile.quality] : ['auto'],
    moderationModes: openai ? ['auto', 'low'] : ['auto'],
    outputCompression: openai ? { supported: true, formats: ['jpeg', 'webp'], min: 0, max: 100 } : { supported: false },
    responsesTool: true, multiTurnEdit: edit, supportsFileId: false, supportsImageUrl: false,
    resolvedAt: Date.now(), ...options.capabilityOverrides,
  };
}

/** One configured API instance; the caller's text provider never participates. */
export function createApiImageProvider(options: ApiImageProviderOptions): ImageProvider {
  const maxBytes = options.maxOutputBytes ?? 50 * 1024 * 1024;
  const maxTotal = options.maxTotalOutputBytes ?? 100 * 1024 * 1024;
  const maxPixels = options.maxPixels ?? 16_777_216;
  if (!options.id || !Object.keys(options.models).length ||
    [maxBytes, maxTotal, maxPixels, options.timeoutMs ?? 180_000, options.pollIntervalMs ?? 3_000]
      .some((value) => !Number.isSafeInteger(value) || value <= 0) || maxTotal < maxBytes) {
    throw new TypeError('Invalid API image provider configuration');
  }
  const fetchImage = options.fetch ?? globalThis.fetch;
  return {
    id: options.id,
    async acquire(context: ImageProviderContext) {
      context.signal.throwIfAborted();
      const credentials = await options.resolveCredentials(context.signal);
      const valid = Boolean(credentials?.baseUrl && credentials.apiKey);
      const controller = new AbortController();
      let started = false;
      return {
        providerId: options.id,
        capabilities: apiImageCapabilities(options, valid, context.model),
        start(request: ImageProviderRequest) {
          if (started) throw new ImageGenerationError('invalid_image_request');
          started = true;
          if (!credentials || !valid) throw new ImageGenerationError('upstream_auth_required');
          if (!Object.hasOwn(options.models, request.model)) throw new ImageGenerationError('unsupported_model', { param: 'model' });
          if ((request.history?.length ?? 0) > 100 || (request.history ?? []).reduce((total, turn) =>
            total + (turn.text?.length ?? 0) + (turn.images ?? []).reduce((bytes, image) => bytes + image.byteLength, 0), 0) > 64 * 1024 * 1024) {
            throw new ImageGenerationError('image_too_large', { param: 'history' });
          }
          const supportsHistory = options.protocol === 'openrouter' || options.protocol === 'gemini-interactions' ||
            ((options.protocol === 'gemini' || options.protocol === 'vertex') && !options.models[request.model]!.startsWith('imagen-'));
          if (request.history?.length && !supportsHistory) {
            throw new ImageGenerationError('unsupported_capability', { param: 'history' });
          }
          const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
          const signal = AbortSignal.any([context.signal, controller.signal, timeout]);
          return {
            events: run(request, credentials, signal, timeout, context),
            async cancel() { controller.abort(); },
          };
        },
        async release() { controller.abort(); },
      };
    },
  };

  async function* run(
    request: ImageProviderRequest, credentials: ImageApiCredentials,
    signal: AbortSignal, timeout: AbortSignal, context: ImageProviderContext,
  ): AsyncIterable<ImageProviderEvent<ImageAsset>> {
    let accepted = false;
    let grant: Awaited<ReturnType<NonNullable<ApiImageProviderOptions['acquireExecution']>>> | undefined;
    try {
      signal.throwIfAborted();
      grant = await options.acquireExecution?.(context, signal);
      if (grant?.signal) signal = AbortSignal.any([signal, grant.signal]);
      signal.throwIfAborted();
      const model = options.models[request.model]!;
      const batch = options.protocol === 'openai-images' || options.protocol === 'xai' || model.startsWith('imagen-');
      const iterations = batch ? 1 : request.n;
      const outputs: ImageProviderOutput<ImageAsset>[] = [];
      let usedBytes = 0;
      let message: string | undefined;
      let usage: ReturnType<typeof parseApiImageResponse>['usage'];
      for (let index = 0; index < iterations; index++) {
        const invocation = await buildApiImageRequest(options.protocol, credentials, model,
          batch ? request : { ...request, n: 1 }, signal, options.publishInput);
        let payload = await responseJson(await fetchImage(invocation.url, invocation.init), Math.ceil(maxTotal * 4 / 3) + 1024 * 1024, signal);
        if (options.protocol === 'wavespeed') {
          const data = object(payload.data ?? payload);
          if ((payload.code !== undefined && payload.code !== 200) || typeof data.id !== 'string' || !data.id || data.id.length > 256) {
            throw new ImageGenerationError('upstream_protocol_changed');
          }
          if (!accepted) { accepted = true; yield { type: 'accepted', acceptedAt: Date.now() }; }
          const jobId = data.id;
          const pollUrl = apiUrl(credentials.baseUrl.replace(/\/api\/v3\/?$/u, ''), `predictions/${encodeURIComponent(jobId)}/result`, 'api/v3');
          let current = data;
          while (!['completed', 'succeeded', 'success', 'succeed'].includes(String(current.status).toLowerCase())) {
            if (['failed', 'error', 'expired', 'cancelled', 'canceled'].includes(String(current.status).toLowerCase())) {
              throw new ImageGenerationError('image_generation_failed', { retrySafety: 'after_acceptance' });
            }
            await abortableDelay(options.pollIntervalMs ?? 3_000, signal);
            // Poll only the configured origin. Upstream URLs never receive credentials.
            const polled = await fetchImage(pollUrl, { method: 'GET', headers: { Authorization: `Bearer ${credentials.apiKey}` }, signal, redirect: 'error' });
            if (polled.status >= 500 || polled.status === 429) { await polled.body?.cancel(); continue; }
            payload = await responseJson(polled, 1024 * 1024, signal);
            current = object(payload.data ?? payload);
            if (current.id !== undefined && current.id !== jobId) throw new ImageGenerationError('upstream_protocol_changed');
          }
          payload = { data: current };
        }
        if (!accepted) { accepted = true; yield { type: 'accepted', acceptedAt: Date.now() }; }
        const parsed = parseApiImageResponse(options.protocol, payload);
        if (parsed.images.length !== (batch ? request.n : 1)) throw new ImageGenerationError('upstream_protocol_changed');
        if (parsed.message && !message) message = parsed.message;
        if (parsed.usage) {
          const total: Record<string, number> = { ...usage };
          for (const [key, value] of Object.entries(parsed.usage)) if (value !== undefined) total[key] = (total[key] ?? 0) + value;
          usage = total;
        }
        for (const output of parsed.images) {
          signal.throwIfAborted();
          const bytes = output.base64 !== undefined ? decodeImageBase64(output.base64, maxBytes)
            : output.url ? await (options.downloadOutput ?? downloadApiImage)(output.url, signal, maxBytes)
              : undefined;
          if (!bytes) throw new ImageGenerationError('upstream_protocol_changed');
          const artifact = await createApiImageAsset(bytes, { maxBytes, maxPixels }, request.outputFormat);
          usedBytes += artifact.byteLength;
          if (usedBytes > maxTotal) throw new ImageGenerationError('image_too_large');
          outputs.push({ artifact, ...(output.revisedPrompt ? { revisedPrompt: output.revisedPrompt.slice(0, 32_000) } : {}) });
        }
      }
      signal.throwIfAborted();
      yield { type: 'completed', images: outputs, ...(usage ? { usage } : {}), ...(message ? { providerMessage: message } : {}) };
    } catch (error) {
      const stable = timeout.aborted && !context.signal.aborted ? new ImageGenerationError('image_generation_timeout', { retrySafety: accepted ? 'after_acceptance' : 'unknown' })
        : signal.aborted ? new ImageGenerationError('request_cancelled')
          : error instanceof ImageGenerationError ? error
            : new ImageGenerationError('image_generation_failed', { retrySafety: accepted ? 'after_acceptance' : 'unknown' });
      yield { type: 'failed', error: serializeImageGenerationError(stable) };
    } finally {
      await grant?.release();
    }
  }
}
