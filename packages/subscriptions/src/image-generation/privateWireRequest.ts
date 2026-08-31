import type { ImageProviderRequest } from '@omnicross/core/image-generation';
import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  fillMissingHeaders,
} from '@omnicross/core/provider-proxy/identity/codexCliHeaders';

/** Codex subscription endpoint used by the image-generation bridge. */
export const CANDIDATE_CODEX_IMAGE_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const CANDIDATE_CODEX_IMAGE_CARRIER_MODEL = 'gpt-5.6-luna';

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

export function buildCandidateCodexImageRequest(request: ImageProviderRequest): string {
  if (request.action !== 'generate') {
    throw new TypeError('The candidate Codex image wire supports generate only.');
  }
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'generate',
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
