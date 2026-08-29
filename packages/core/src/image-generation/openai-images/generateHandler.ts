import type { NormalizedImageGenerateRequest } from '@omnicross/contracts/image-generation-types';

import type { OpenAIOperationHandler } from '../../openai-operation';
import { ImageGenerationError } from '../errors';
import { createImageRequestResourceScope } from './TemporaryImageAsset';
import { writeImageApiError, imageApiErrorFromUnknown, safeImageRequestId } from './imageApiErrors';
import { writeImageApiResponse } from './imageApiResponse';
import { writeImageApiSse } from './imageApiSse';
import { normalizeGenerateRequest } from './normalizeOptions';
import { readJsonBody } from './readJsonBody';
import { assertFiniteImageApiLimits, type ImageApiContributionsDeps, type ImageApiRuntime } from './types';

function validateRuntime(runtime: ImageApiRuntime): void {
  if (
    typeof runtime.tenantId !== 'string' || !runtime.tenantId || runtime.tenantId.length > 256 ||
    typeof runtime.providerId !== 'string' || !runtime.providerId || runtime.providerId.length > 128 ||
    typeof runtime.defaultModel !== 'string' || !runtime.defaultModel || runtime.defaultModel.length > 128 ||
    !runtime.modelAliases || typeof runtime.modelAliases.get !== 'function'
  ) {
    throw new ImageGenerationError('invalid_api_key');
  }
  assertFiniteImageApiLimits(runtime.limits);
}

async function bestEffortAudit(
  deps: ImageApiContributionsDeps,
  record: Parameters<NonNullable<ImageApiContributionsDeps['audit']>>[0],
): Promise<void> {
  try {
    await deps.audit?.(record);
  } catch {
    // Audit failure must not affect an Images response.
  }
}

export function createImageGenerateHandler(deps: ImageApiContributionsDeps): OpenAIOperationHandler {
  return async (context) => {
    const requestId = safeImageRequestId(deps.createRequestId?.());
    const createdAt = (deps.now ?? Date.now)();
    let runtime: ImageApiRuntime | undefined;
    let request: NormalizedImageGenerateRequest | undefined;
    let scope: Awaited<ReturnType<typeof createImageRequestResourceScope>> | undefined;
    let terminal: 'completed' | 'failed' | 'cancelled' = 'failed';
    let terminalCode: string | undefined;
    try {
      runtime = await deps.resolveRuntime(context);
      validateRuntime(runtime);
      scope = deps.createResourceScope
        ? await deps.createResourceScope(runtime.limits, context.signal)
        : await createImageRequestResourceScope(runtime.limits, context.signal);
      const body = await readJsonBody(context.request, {
        maxBytes: runtime.limits.maxJsonBytes,
        signal: context.signal,
      });
      request = normalizeGenerateRequest(body, runtime);
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
          action: 'generation',
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
        operationId: 'images.generate',
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
            }
          : {}),
        terminal,
        ...(terminalCode ? { errorCode: terminalCode } : {}),
      });
    }
  };
}

export { bestEffortAudit, validateRuntime };
