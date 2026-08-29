import { createImageEditHandler } from './editHandler';
import { createImageGenerateHandler } from './generateHandler';
import type { ImageApiContributions, ImageApiContributionsDeps } from './types';

export function createImageApiContributions(
  deps: ImageApiContributionsDeps,
): ImageApiContributions {
  if (!deps || typeof deps !== 'object' || !deps.orchestrator || typeof deps.resolveRuntime !== 'function') {
    throw new TypeError('Image API contributions require an orchestrator and runtime resolver.');
  }
  const generate = Object.freeze({
    operationId: 'images.generate' as const,
    handler: createImageGenerateHandler(deps),
  });
  const edit = Object.freeze({
    operationId: 'images.edit' as const,
    handler: createImageEditHandler(deps),
  });
  return Object.freeze({ generate, edit, all: Object.freeze([generate, edit]) });
}
