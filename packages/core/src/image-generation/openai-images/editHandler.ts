import type { NormalizedImageEditRequest } from '@omnicross/contracts/image-generation-types';

import type { OpenAIOperationHandler } from '../../openai-operation';
import { ImageGenerationError } from '../errors';
import type { ImageAsset } from '../ports';
import { createImageRequestResourceScope } from './TemporaryImageAsset';
import { bestEffortAudit, validateRuntime } from './generateHandler';
import { writeImageApiError, imageApiErrorFromUnknown, safeImageRequestId } from './imageApiErrors';
import { writeImageApiResponse } from './imageApiResponse';
import { writeImageApiSse } from './imageApiSse';
import { normalizeImageOptions } from './normalizeOptions';
import { readJsonBody } from './readJsonBody';
import { readMultipartEdit } from './readMultipartEdit';
import { parseImageInputList, resolveImageInput } from './resolveImageInput';
import type { ImageApiContributionsDeps, ImageApiRuntime } from './types';
import { assertCompatibleMask } from './validateRaster';

function mediaType(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

export function createImageEditHandler(deps: ImageApiContributionsDeps): OpenAIOperationHandler {
  return async (context) => {
    const requestId = safeImageRequestId(deps.createRequestId?.());
    const createdAt = (deps.now ?? Date.now)();
    let runtime: ImageApiRuntime | undefined;
    let request: NormalizedImageEditRequest<ImageAsset> | undefined;
    let scope: Awaited<ReturnType<typeof createImageRequestResourceScope>> | undefined;
    let terminal: 'completed' | 'failed' | 'cancelled' = 'failed';
    let terminalCode: string | undefined;
    try {
      runtime = await deps.resolveRuntime(context);
      validateRuntime(runtime);
      scope = deps.createResourceScope
        ? await deps.createResourceScope(runtime.limits, context.signal)
        : await createImageRequestResourceScope(runtime.limits, context.signal);
      const type = mediaType(context.request.headers['content-type']);
      if (type === 'application/json') {
        const value = await readJsonBody(context.request, {
          maxBytes: runtime.limits.maxJsonBytes,
          signal: context.signal,
        });
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ImageGenerationError('invalid_image_request');
        }
        const record = value as Record<string, unknown>;
        if (record.image !== undefined && record.images !== undefined) {
          throw new ImageGenerationError('invalid_image_request', { param: 'image' });
        }
        const options = normalizeImageOptions(record, runtime, {
          action: 'edit',
          extraKeys: ['image', 'images', 'mask'],
        });
        const inputs = parseImageInputList(
          record.images ?? record.image,
          runtime.limits.maxRemoteUrlBytes,
        );
        const images: ImageAsset[] = [];
        for (const input of inputs) images.push(await resolveImageInput(input, runtime, scope, context.signal));
        const mask = record.mask === undefined
          ? undefined
          : await resolveImageInput(record.mask, runtime, scope, context.signal);
        if (mask) assertCompatibleMask(images[0]!, mask);
        request = { action: 'edit', ...options, images, ...(mask ? { mask } : {}) };
      } else {
        const multipart = await readMultipartEdit(context.request, scope, runtime.limits, context.signal);
        const options = normalizeImageOptions(multipart.fields, runtime, {
          action: 'edit',
          multipart: true,
        });
        request = {
          action: 'edit',
          ...options,
          images: multipart.images,
          ...(multipart.mask ? { mask: multipart.mask } : {}),
        };
      }
      const events = deps.orchestrator.run(
        request,
        {
          requestId,
          tenantId: runtime.tenantId,
          signal: context.signal,
          ...(context.route.sessionId ? { sessionKey: context.route.sessionId } : {}),
          ...(context.route.preferredAccountId ? { preferredAccountId: context.route.preferredAccountId } : {}),
          ...(context.route.preferredAccountGroup ? { preferredAccountGroup: context.route.preferredAccountGroup } : {}),
        },
        { providerId: runtime.providerId, ...(runtime.retention ? { retention: runtime.retention } : {}) },
      );
      if (request.stream) {
        await writeImageApiSse({
          action: 'edit',
          response: context.response,
          events,
          requestedCount: request.n,
          requestId,
          createdAt,
          metadata: {
            background: request.background,
            outputFormat: request.outputFormat,
            quality: request.quality,
            size: request.size.kind === 'auto' ? 'auto' : `${request.size.width}x${request.size.height}`,
          },
          scope,
          limits: runtime.limits,
          signal: context.signal,
        });
      } else {
        await writeImageApiResponse({
          response: context.response,
          events,
          requestedCount: request.n,
          requestId,
          createdAt,
          scope,
          limits: runtime.limits,
          signal: context.signal,
        });
      }
      terminal = 'completed';
    } catch (error) {
      const domainError = imageApiErrorFromUnknown(error);
      terminal = domainError.code === 'request_cancelled' ? 'cancelled' : 'failed';
      terminalCode = domainError.code;
      writeImageApiError(context.response, domainError, requestId);
    } finally {
      await scope?.cleanup().catch(() => undefined);
      await bestEffortAudit(deps, {
        requestId,
        operationId: 'images.edit',
        ...(runtime ? { providerId: runtime.providerId } : {}),
        ...(request
          ? {
              model: request.model,
              options: {
                n: request.n,
                quality: request.quality,
                background: request.background,
                outputFormat: request.outputFormat,
                stream: request.stream,
                partialImages: request.partialImages,
              },
              inputCount: request.images.length,
              inputBytes: request.images.reduce((sum, asset) => sum + asset.byteLength, 0),
            }
          : {}),
        terminal,
        ...(terminalCode ? { errorCode: terminalCode } : {}),
      });
    }
  };
}
