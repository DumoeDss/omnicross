import {
  ImageGenerationError,
  readImageAssetBytes,
  type ImageAsset,
  type ImageProviderRequest,
} from '@omnicross/core/image-generation';
import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  fillMissingHeaders,
} from '@omnicross/core/provider-proxy/identity/codexCliHeaders';

/** Codex subscription endpoint used by the image-generation bridge. */
export const CANDIDATE_CODEX_IMAGE_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const CANDIDATE_CODEX_IMAGE_EDIT_URL = 'https://chatgpt.com/backend-api/codex/images/edits';
export const CANDIDATE_CODEX_IMAGE_CARRIER_MODEL = 'gpt-5.6-luna';
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;

/** Private Codex image wire envelope. Never exported from the subscriptions package. */
interface CandidateCodexImageRequest {
  readonly instructions: '';
  readonly model: string;
  readonly input: readonly [{
    readonly type: 'message';
    readonly role: 'user';
    readonly content: readonly [{ readonly type: 'input_text'; readonly text: string }];
  }];
  readonly tools: readonly [Record<string, unknown>];
  readonly tool_choice: { readonly type: 'image_generation' };
  readonly reasoning: { readonly effort: 'medium'; readonly summary: 'auto' };
  readonly parallel_tool_calls: true;
  readonly include: readonly ['reasoning.encrypted_content'];
  readonly stream: true;
  readonly store: false;
}

/** Fill stable Codex CLI markers required by the image bridge without replacing auth. */
export function applyCandidateCodexImageHeaders(headers: Record<string, string>): void {
  fillMissingHeaders(headers, DEFAULT_CODEX_CLI_HEADERS);
  fillMissingHeaders(headers, {
    accept: codexAcceptHeader(true),
    'content-type': 'application/json',
  });
}

export function candidateCodexImageUrl(action: ImageProviderRequest['action']): string {
  return action === 'edit' ? CANDIDATE_CODEX_IMAGE_EDIT_URL : CANDIDATE_CODEX_IMAGE_URL;
}

export function applyCandidateCodexImageActionHeaders(
  headers: Record<string, string>,
  action: ImageProviderRequest['action'],
): void {
  headers.accept = action === 'edit' ? 'application/json' : codexAcceptHeader(true);
}

async function encodeInputImage(asset: ImageAsset, signal?: AbortSignal): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) {
    throw new ImageGenerationError('unsupported_image_type', { param: 'image' });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readImageAssetBytes(asset, MAX_INPUT_IMAGE_BYTES, signal);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    if (cause instanceof RangeError) {
      throw new ImageGenerationError('image_too_large', { param: 'image', cause });
    }
    throw cause;
  }
  try {
    const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    return `data:${asset.mimeType};base64,${base64}`;
  } finally {
    bytes.fill(0);
  }
}

export async function buildCandidateCodexImageRequest(
  request: ImageProviderRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (request.action === 'edit') {
    if (request.mask || request.images.length !== 1) {
      throw new ImageGenerationError('unsupported_capability', { param: request.mask ? 'mask' : 'images' });
    }
    return JSON.stringify({
      images: [{ image_url: await encodeInputImage(request.images[0]!, signal) }],
      prompt: request.prompt,
      background: request.background,
      model: request.model,
      quality: request.quality,
      size: request.size.kind === 'pixels'
        ? `${request.size.width}x${request.size.height}`
        : 'auto',
    });
  }
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: request.action,
    model: request.model,
    quality: request.quality,
    background: request.background,
    output_format: request.outputFormat,
  };
  if (request.size.kind === 'pixels') tool.size = `${request.size.width}x${request.size.height}`;
  if (request.outputCompression !== undefined) tool.output_compression = request.outputCompression;
  if (request.moderation !== 'auto') tool.moderation = request.moderation;

  const body: CandidateCodexImageRequest = {
    instructions: '',
    model: CANDIDATE_CODEX_IMAGE_CARRIER_MODEL,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: request.prompt }],
    }],
    tools: [tool],
    tool_choice: { type: 'image_generation' },
    reasoning: { effort: 'medium', summary: 'auto' },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    stream: true,
    store: false,
  };
  return JSON.stringify(body);
}
