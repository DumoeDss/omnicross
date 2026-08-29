import type { ImageProviderRequest } from '@omnicross/core/image-generation';

/** Candidate endpoint: verified for text Responses only, not subscription images. */
export const CANDIDATE_CODEX_IMAGE_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Private candidate envelope. Never exported from the subscriptions package. */
interface CandidateCodexImageRequest {
  readonly model: string;
  readonly input: string;
  readonly tools: readonly [Record<string, unknown>];
  readonly tool_choice: { readonly type: 'image_generation' };
  readonly stream: false;
  readonly store: false;
}

export function buildCandidateCodexImageRequest(request: ImageProviderRequest): string {
  if (request.action !== 'generate') {
    throw new TypeError('The candidate Codex image wire supports generate only.');
  }
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    quality: request.quality,
    background: request.background,
    output_format: request.outputFormat,
  };
  if (request.size.kind === 'pixels') tool.size = `${request.size.width}x${request.size.height}`;
  if (request.outputCompression !== undefined) tool.output_compression = request.outputCompression;
  if (request.moderation !== 'auto') tool.moderation = request.moderation;

  const body: CandidateCodexImageRequest = {
    model: request.model,
    input: request.prompt,
    tools: [tool],
    tool_choice: { type: 'image_generation' },
    stream: false,
    store: false,
  };
  return JSON.stringify(body);
}
