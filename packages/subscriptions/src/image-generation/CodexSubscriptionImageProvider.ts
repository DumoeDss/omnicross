import { createHash } from 'node:crypto';

import type {
  ImageCapabilities,
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
  CODEX_IMAGE_ADAPTER_VALUES,
  type CodexImageCapabilityEvidence,
  type CodexImageCapabilityEvidenceSource,
  UnknownCodexImageCapabilityEvidenceSource,
} from './capabilityEvidence';
import { mapCandidateCodexImageFailure } from './privateWireErrors';
import {
  applyCandidateCodexImageActionHeaders,
  applyCandidateCodexImageHeaders,
  buildCandidateCodexImageRequest,
  candidateCodexImageUrl,
  CANDIDATE_CODEX_IMAGE_CARRIER_MODEL,
  CANDIDATE_CODEX_IMAGE_URL,
} from './privateWireRequest';
import {
  parseCandidateCodexImageResponse,
  readCandidateCodexImageResponseBody,
  selectVerifiedCandidateResponseMetadata,
} from './privateWireResponse';
import type {
  ImageExecutionScheduler,
  ImageExecutionSchedulerGrant,
} from './ImageExecutionScheduler';

export interface CodexSubscriptionImageProviderOptions {
  readonly authStrategy: AuthStrategy;
  readonly evidenceSource?: CodexImageCapabilityEvidenceSource;
  readonly executionScheduler?: ImageExecutionScheduler;
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
  readonly #executionScheduler?: ImageExecutionScheduler;
  readonly #generationTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: CodexSubscriptionImageProviderOptions) {
    this.#auth = options.authStrategy;
    this.#evidence = options.evidenceSource ?? new UnknownCodexImageCapabilityEvidenceSource();
    this.#executionScheduler = options.executionScheduler;
    this.#generationTimeoutMs = options.generationTimeoutMs ?? 180_000;
    this.#now = options.now ?? Date.now;
  }

  async acquire(context: ImageProviderContext): Promise<ImageProviderLease> {
    if (context.signal.aborted) throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    if (this.#auth.providerId !== 'codex') throw new ImageGenerationError('upstream_auth_required');

    let selectedAccountId: string | undefined;
    const headers: Record<string, string> = {};
    applyCandidateCodexImageHeaders(headers);
    try {
      await this.#auth.applyHeaders(headers, {
        upstreamUrl: CANDIDATE_CODEX_IMAGE_URL,
        resolvedModel: CANDIDATE_CODEX_IMAGE_CARRIER_MODEL,
        sessionKey: context.sessionKey,
        preferredAccountId: context.preferredAccountId,
        preferredAccountGroup: context.preferredAccountGroup,
        boundAccountFallbackPolicy: context.boundAccountFallbackPolicy,
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

    let evidence: CodexImageCapabilityEvidence;
    try {
      evidence = await this.#evidence.resolve({
        accountId: selectedAccountId,
        signal: context.signal,
      });
    } catch (cause) {
      if (context.signal.aborted) {
        headers.Authorization = '';
        selectedAccountId = undefined;
        throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
      }
      evidence = {
        account: { kind: 'account', source: 'codex-image-evidence-source-failed' },
        upstream: { kind: 'upstream', source: 'codex-image-evidence-source-failed' },
      };
    }
    if (context.signal.aborted) {
      headers.Authorization = '';
      selectedAccountId = undefined;
      throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    }
    const resolvedCapabilities = resolveImageCapabilities({
      adapter: createCodexImageAdapterEvidence(this.#now()),
      account: evidence.account,
      upstream: evidence.upstream,
    }, this.#now());
    // The image bridge is a known local protocol. Unknown persisted entitlement
    // means "try the real account", not "reject before contacting upstream".
    // A real upstream denial is still surfaced by the stable 4xx mapping.
    const bootstrapEligible =
      evidence.account.source === 'codex-image-entitlement-unknown' &&
      evidence.upstream.source === 'codex-image-protocol-unverified';
    const capabilities: ImageCapabilities = resolvedCapabilities.available
      ? resolvedCapabilities
      : bootstrapEligible ? Object.freeze({
          ...CODEX_IMAGE_ADAPTER_VALUES,
          resolvedAt: this.#now(),
        }) : resolvedCapabilities;

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
        const unsupportedAction = request.action === 'generate'
          ? !capabilities.generate
          : !capabilities.edit || request.images.length === 0 ||
            request.images.length > capabilities.maxInputImages ||
            (request.mask !== undefined && !capabilities.maskEdit);
        if (
          unsupportedAction || request.stream || request.partialImages > 0 ||
          request.n !== 1 || !capabilities.models.includes(request.model) ||
          !capabilities.outputFormats.includes(request.outputFormat) ||
          (request.quality !== 'auto' && !capabilities.qualityLevels.includes(request.quality)) ||
          !capabilities.moderationModes.includes(request.moderation) ||
          (request.outputCompression !== undefined && (
            !Number.isInteger(request.outputCompression) ||
            capabilities.outputCompression.supported !== true ||
            !capabilities.outputCompression.formats.includes(request.outputFormat) ||
            request.outputCompression < capabilities.outputCompression.min ||
            request.outputCompression > capabilities.outputCompression.max
          ))
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
    let queueWaitMs: number | undefined;
    let generationStartedAt: number | undefined;
    let retryCount = 0;
    let authRefreshCount = 0;
    const onCallerAbort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', onCallerAbort, { once: true });
    const cancel = async (): Promise<void> => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(new Error('request_cancelled'));
    };

    const events = (async function* (self: CodexSubscriptionImageProvider) {
      let schedulerGrant: ImageExecutionSchedulerGrant | undefined;
      let schedulerGrantReleased = false;
      let schedulerGrantSignal: AbortSignal | undefined;
      let onSchedulerAbort: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let accepted = false;
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (self.#executionScheduler) {
          const queueStartedAt = self.#now();
          try {
            const accountKey = self.#executionScheduler.deriveAccountKey(accountId);
            schedulerGrant = await self.#executionScheduler.acquire({
              tenantId: context.tenantId,
              accountKey,
              signal: controller.signal,
            });
          } finally {
            queueWaitMs = Math.max(0, self.#now() - queueStartedAt);
          }
          schedulerGrantSignal = schedulerGrant.signal;
          if (schedulerGrantSignal) {
            onSchedulerAbort = () => controller.abort(schedulerGrantSignal?.reason);
            if (schedulerGrantSignal.aborted) onSchedulerAbort();
            else schedulerGrantSignal.addEventListener('abort', onSchedulerAbort, { once: true });
          }
        }
        if (controller.signal.aborted) throw controller.signal.reason;

        generationStartedAt = self.#now();
        timeout = setTimeout(
          () => controller.abort(new ImageGenerationError('image_generation_timeout')),
          self.#generationTimeoutMs,
        );
        const body = await buildCandidateCodexImageRequest(request, controller.signal);
        const upstreamUrl = candidateCodexImageUrl(request.action);
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (attempt > 0) retryCount += 1;
          const requestHeaders = { ...leaseHeaders };
          applyCandidateCodexImageActionHeaders(requestHeaders, request.action);
          response = await fetchUpstream(
            upstreamUrl,
            {
              method: 'POST',
              headers: requestHeaders,
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
          authRefreshCount += 1;
          let refreshedAccount: string | undefined;
          const refreshedHeaders: Record<string, string> = {};
          applyCandidateCodexImageHeaders(refreshedHeaders);
          await self.#auth.applyHeaders(refreshedHeaders, {
            upstreamUrl,
            resolvedModel: CANDIDATE_CODEX_IMAGE_CARRIER_MODEL,
            sessionKey: context.sessionKey,
            preferredAccountId: accountId,
            boundAccountFallbackPolicy: context.boundAccountFallbackPolicy,
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
        if (timeout !== undefined) clearTimeout(timeout);
        if (schedulerGrantSignal && onSchedulerAbort) {
          schedulerGrantSignal.removeEventListener('abort', onSchedulerAbort);
        }
        if (schedulerGrant && !schedulerGrantReleased) {
          schedulerGrantReleased = true;
          await schedulerGrant.release();
        }
        context.signal.removeEventListener('abort', onCallerAbort);
      }
    })(this);

    return {
      events,
      cancel,
      observability: {
        snapshot: () => ({
          queueWaitMs,
          generationStartedAt,
          retryCount,
          authRefreshCount,
        }),
      },
    };
  }
}

/** Create the dormant, account-bound Codex subscription image provider. */
export function createCodexSubscriptionImageProvider(
  options: CodexSubscriptionImageProviderOptions,
): ImageProvider {
  return new CodexSubscriptionImageProvider(options);
}
