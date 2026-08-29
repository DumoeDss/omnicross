import { createHash } from 'node:crypto';

import type {
  ImageProviderCompletedEvent,
  ImageProviderFailedEvent,
} from '@omnicross/contracts/image-generation-types';
import {
  ImageGenerationError,
  type ImageAsset,
  type ImageJob,
  type ImageProvider,
  type ImageProviderContext,
  type ImageProviderLease,
  type ImageProviderRequest,
  normalizeImageGenerationError,
  resolveImageCapabilities,
  serializeImageGenerationError,
} from '@omnicross/core/image-generation';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import type { AuthStrategy } from '../auth';
import {
  createCodexImageAdapterEvidence,
  type CodexImageCapabilityEvidenceSource,
  UnknownCodexImageCapabilityEvidenceSource,
} from './capabilityEvidence';
import { mapCandidateCodexImageFailure } from './privateWireErrors';
import {
  buildCandidateCodexImageRequest,
  CANDIDATE_CODEX_IMAGE_URL,
} from './privateWireRequest';
import {
  parseCandidateCodexImageResponse,
  readCandidateCodexImageResponseBody,
  selectVerifiedCandidateResponseMetadata,
} from './privateWireResponse';

export interface CodexSubscriptionImageProviderOptions {
  readonly authStrategy: AuthStrategy;
  readonly evidenceSource?: CodexImageCapabilityEvidenceSource;
  readonly generationTimeoutMs?: number;
  readonly now?: () => number;
}

const PROVIDER_ID = 'codex-subscription';

function traceAccountFingerprint(accountId: string): string {
  return `sha256:${createHash('sha256').update(accountId, 'utf8').digest('hex')}`;
}

function failed(error: ImageGenerationError): ImageProviderFailedEvent {
  return { type: 'failed', error: serializeImageGenerationError(error) };
}

class CodexSubscriptionImageProvider implements ImageProvider {
  readonly id = PROVIDER_ID;
  readonly #auth: AuthStrategy;
  readonly #evidence: CodexImageCapabilityEvidenceSource;
  readonly #generationTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: CodexSubscriptionImageProviderOptions) {
    this.#auth = options.authStrategy;
    this.#evidence = options.evidenceSource ?? new UnknownCodexImageCapabilityEvidenceSource();
    this.#generationTimeoutMs = options.generationTimeoutMs ?? 180_000;
    this.#now = options.now ?? Date.now;
  }

  async acquire(context: ImageProviderContext): Promise<ImageProviderLease> {
    if (context.signal.aborted) throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    if (this.#auth.providerId !== 'codex') throw new ImageGenerationError('upstream_auth_required');

    let selectedAccountId: string | undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    try {
      await this.#auth.applyHeaders(headers, {
        upstreamUrl: CANDIDATE_CODEX_IMAGE_URL,
        resolvedModel: 'gpt-image-2',
        sessionKey: context.sessionKey,
        preferredAccountId: context.preferredAccountId,
        preferredAccountGroup: context.preferredAccountGroup,
        reportSelection: (accountId) => {
          selectedAccountId = accountId;
        },
      });
    } catch (cause) {
      throw new ImageGenerationError('upstream_auth_required', { cause });
    }
    if (!selectedAccountId || !/^Bearer\s+\S+$/i.test(headers.Authorization ?? '')) {
      headers.Authorization = '';
      throw new ImageGenerationError('upstream_auth_required');
    }
    if (context.signal.aborted) {
      headers.Authorization = '';
      throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    }

    const evidence = await this.#evidence.resolve({ accountId: selectedAccountId, signal: context.signal });
    const capabilities = resolveImageCapabilities({
      adapter: createCodexImageAdapterEvidence(this.#now()),
      account: evidence.account,
      upstream: evidence.upstream,
    }, this.#now());

    let released = false;
    let started = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      headers.Authorization = '';
      selectedAccountId = undefined;
    };

    return {
      providerId: PROVIDER_ID,
      capabilities,
      start: (request) => {
        if (released) throw new ImageGenerationError('upstream_auth_required');
        if (started) throw new ImageGenerationError('invalid_image_request');
        started = true;
        if (!capabilities.available) throw new ImageGenerationError('unsupported_capability');
        if (
          request.action !== 'generate' || request.stream || request.partialImages > 0 ||
          request.n !== 1 || !capabilities.models.includes(request.model) ||
          !capabilities.outputFormats.includes(request.outputFormat)
        ) {
          throw new ImageGenerationError('unsupported_capability');
        }
        return this.#createJob(
          request,
          context,
          headers,
          selectedAccountId!,
          evidence.verifiedResponseFields,
        );
      },
      release,
    };
  }

  #createJob(
    request: ImageProviderRequest,
    context: ImageProviderContext,
    leaseHeaders: Record<string, string>,
    accountId: string,
    verifiedFields: { readonly usage?: boolean; readonly revisedPrompt?: boolean } | undefined,
  ): ImageJob {
    const controller = new AbortController();
    let cancelled = false;
    const onCallerAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', onCallerAbort, { once: true });
    const cancel = async (): Promise<void> => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(new Error('request_cancelled'));
    };

    const events = (async function* (self: CodexSubscriptionImageProvider) {
      const timeout = setTimeout(
        () => controller.abort(new ImageGenerationError('image_generation_timeout')),
        self.#generationTimeoutMs,
      );
      let accepted = false;
      try {
        const body = buildCandidateCodexImageRequest(request);
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (controller.signal.aborted) throw controller.signal.reason;
          response = await fetchUpstream(
            CANDIDATE_CODEX_IMAGE_URL,
            {
              method: 'POST',
              headers: { ...leaseHeaders },
              body,
              signal: controller.signal,
            },
            {
              providerId: 'codex',
              accountId,
              traceAccountFingerprint: traceAccountFingerprint(accountId),
              redactBodies: true,
            },
          );
          if (response.status !== 401 || attempt === 1) break;
          const refreshed = await self.#auth.onUnauthorized(context.sessionKey);
          if (!refreshed) break;
          let refreshedAccount: string | undefined;
          const refreshedHeaders: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          };
          await self.#auth.applyHeaders(refreshedHeaders, {
            upstreamUrl: CANDIDATE_CODEX_IMAGE_URL,
            resolvedModel: request.model,
            sessionKey: context.sessionKey,
            preferredAccountId: accountId,
            reportSelection: (id) => { refreshedAccount = id; },
          });
          if (refreshedAccount !== accountId || !/^Bearer\s+\S+$/i.test(refreshedHeaders.Authorization ?? '')) {
            throw new ImageGenerationError('upstream_auth_required');
          }
          Object.assign(leaseHeaders, refreshedHeaders);
        }
        if (!response) throw new ImageGenerationError('image_generation_failed', { retrySafety: 'unknown' });
        const responseBody = await readCandidateCodexImageResponseBody(response);
        if (!response.ok) {
          yield failed(mapCandidateCodexImageFailure(response, responseBody));
          return;
        }
        accepted = true;
        yield { type: 'accepted' as const, acceptedAt: self.#now() };
        const parsed = await parseCandidateCodexImageResponse(responseBody, request.n, request.outputFormat);
        const verified = selectVerifiedCandidateResponseMetadata(parsed, verifiedFields);
        const completed: ImageProviderCompletedEvent<ImageAsset> = {
          type: 'completed',
          images: parsed.images.map((artifact, index) => ({
            artifact,
            ...(index === 0 && verified.revisedPrompt
              ? { revisedPrompt: verified.revisedPrompt }
              : {}),
          })),
          ...(verified.usage ? { usage: verified.usage } : {}),
        };
        yield completed;
      } catch (cause) {
        const normalized = controller.signal.aborted
          ? controller.signal.reason instanceof ImageGenerationError
            ? controller.signal.reason
            : new ImageGenerationError('request_cancelled', { cause: controller.signal.reason })
          : normalizeImageGenerationError(cause, 'image_generation_failed', {
              retrySafety: accepted ? 'after_acceptance' : 'unknown',
            });
        yield failed(normalized);
      } finally {
        clearTimeout(timeout);
        context.signal.removeEventListener('abort', onCallerAbort);
      }
    })(this);

    return { events, cancel };
  }
}

/** Create the dormant, account-bound Codex subscription image provider. */
export function createCodexSubscriptionImageProvider(
  options: CodexSubscriptionImageProviderOptions,
): ImageProvider {
  return new CodexSubscriptionImageProvider(options);
}
