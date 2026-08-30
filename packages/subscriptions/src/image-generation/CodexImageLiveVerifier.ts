import { createHash } from 'node:crypto';

import type {
  ImageBackground,
  ImageModeration,
  ImageOutputFormat,
  ImageQuality,
  NormalizedImageGenerateRequest,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  normalizeImageGenerationError,
} from '@omnicross/core/image-generation';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import type { AuthStrategy } from '../auth';
import { mapCandidateCodexImageFailure } from './privateWireErrors';
import {
  buildCandidateCodexImageRequest,
  CANDIDATE_CODEX_IMAGE_URL,
} from './privateWireRequest';
import {
  disposeCandidateCodexImageResponse,
  parseCandidateCodexImageResponse,
  type ParsedCandidateCodexImageResponse,
  readCandidateCodexImageResponseBody,
} from './privateWireResponse';

const VERIFICATION_PROMPT = 'A single solid black square.';

export interface CodexImageCapabilityTestedRequest {
  readonly action: 'generate';
  readonly n: 1;
  readonly quality: ImageQuality;
  readonly size: string;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly moderation: ImageModeration;
  readonly stream: false;
  readonly partialImages: 0;
  readonly outputCompression?: number;
}

export interface CodexImageCapabilityObservedResponseFields {
  readonly usage?: true;
  readonly revisedPrompt?: true;
}

export interface CodexImageCapabilityObservation {
  /** Sensitive transient identity. Persist only after a local keyed HMAC. */
  readonly accountId: string;
  readonly model: 'gpt-image-2';
  readonly request: CodexImageCapabilityTestedRequest;
  readonly responseFields?: CodexImageCapabilityObservedResponseFields;
}

export interface CodexImageLiveVerificationRequest {
  readonly signal: AbortSignal;
  readonly sessionKey?: string;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
  readonly boundAccountFallbackPolicy?: 'strict' | 'pool';
}

export interface CodexImageLiveVerifierOptions {
  readonly authStrategy: AuthStrategy;
  readonly generationTimeoutMs?: number;
}

export interface CodexImageLiveVerifier {
  verify(request: CodexImageLiveVerificationRequest): Promise<CodexImageCapabilityObservation>;
}

const TESTED_REQUEST: NormalizedImageGenerateRequest = Object.freeze({
  action: 'generate',
  model: 'gpt-image-2',
  prompt: VERIFICATION_PROMPT,
  n: 1,
  quality: 'low',
  size: { kind: 'auto' as const },
  background: 'opaque',
  outputFormat: 'png',
  moderation: 'auto',
  stream: false,
  partialImages: 0,
});

function traceAccountFingerprint(accountId: string): string {
  return `sha256:${createHash('sha256').update(accountId, 'utf8').digest('hex')}`;
}

function observation(
  accountId: string,
  parsed: ParsedCandidateCodexImageResponse,
): CodexImageCapabilityObservation {
  const responseFields: CodexImageCapabilityObservedResponseFields = {
    ...(parsed.usage ? { usage: true } : {}),
    ...(parsed.revisedPrompt ? { revisedPrompt: true } : {}),
  };
  return Object.freeze({
    accountId,
    model: 'gpt-image-2',
    request: Object.freeze({
      action: 'generate',
      n: 1,
      quality: 'low',
      size: 'auto',
      background: 'opaque',
      outputFormat: 'png',
      moderation: 'auto',
      stream: false,
      partialImages: 0,
    }),
    ...(Object.keys(responseFields).length > 0
      ? { responseFields: Object.freeze(responseFields) }
      : {}),
  });
}

class DefaultCodexImageLiveVerifier implements CodexImageLiveVerifier {
  readonly #auth: AuthStrategy;
  readonly #generationTimeoutMs: number;

  constructor(options: CodexImageLiveVerifierOptions) {
    if (!Number.isSafeInteger(options.generationTimeoutMs ?? 180_000) ||
      (options.generationTimeoutMs ?? 180_000) <= 0) {
      throw new TypeError('Codex image live verification timeout must be positive');
    }
    this.#auth = options.authStrategy;
    this.#generationTimeoutMs = options.generationTimeoutMs ?? 180_000;
  }

  async verify(request: CodexImageLiveVerificationRequest): Promise<CodexImageCapabilityObservation> {
    if (request.signal.aborted) {
      throw new ImageGenerationError('request_cancelled', { cause: request.signal.reason });
    }
    if (this.#auth.providerId !== 'codex') {
      throw new ImageGenerationError('upstream_auth_required');
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(new ImageGenerationError('image_generation_timeout'));
    }, this.#generationTimeoutMs);
    timeout.unref();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    let accountId: string | undefined;
    let parsed: ParsedCandidateCodexImageResponse | undefined;
    try {
      await this.#auth.applyHeaders(headers, {
        upstreamUrl: CANDIDATE_CODEX_IMAGE_URL,
        resolvedModel: TESTED_REQUEST.model,
        sessionKey: request.sessionKey,
        preferredAccountId: request.preferredAccountId,
        preferredAccountGroup: request.preferredAccountGroup,
        boundAccountFallbackPolicy: request.boundAccountFallbackPolicy,
        reportSelection: (selectedAccountId) => { accountId = selectedAccountId; },
      });
      if (!accountId || !/^Bearer\s+\S+$/iu.test(headers.Authorization ?? '')) {
        throw new ImageGenerationError('upstream_auth_required');
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetchUpstream(
        CANDIDATE_CODEX_IMAGE_URL,
        {
          method: 'POST',
          headers: { ...headers },
          body: buildCandidateCodexImageRequest(TESTED_REQUEST),
          signal: controller.signal,
        },
        {
          providerId: 'codex',
          accountId,
          traceAccountFingerprint: traceAccountFingerprint(accountId),
          redactBodies: true,
        },
      );
      const responseBody = await readCandidateCodexImageResponseBody(response);
      if (!response.ok) throw mapCandidateCodexImageFailure(response, responseBody);
      parsed = await parseCandidateCodexImageResponse(responseBody, 1, 'png');
      if (controller.signal.aborted) throw controller.signal.reason;
      return observation(accountId, parsed);
    } catch (cause) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof ImageGenerationError
          ? controller.signal.reason
          : new ImageGenerationError('request_cancelled', { cause: controller.signal.reason });
      }
      throw normalizeImageGenerationError(cause, 'image_generation_failed', {
        retrySafety: 'before_acceptance',
      });
    } finally {
      disposeCandidateCodexImageResponse(parsed);
      headers.Authorization = '';
      accountId = undefined;
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

export function createCodexImageLiveVerifier(
  options: CodexImageLiveVerifierOptions,
): CodexImageLiveVerifier {
  return new DefaultCodexImageLiveVerifier(options);
}
