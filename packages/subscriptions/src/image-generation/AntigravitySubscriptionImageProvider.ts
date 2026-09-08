/**
 * AntigravitySubscriptionImageProvider — the antigravity NanoBanana image
 * adapter (multi-provider-image-generation design D4/D5). Mirrors the codex
 * provider's lease/lifecycle skeleton (account-bound, fail-closed, queued,
 * single retry after a 401 refresh) but speaks the antigravity CCA image wire:
 * a plain non-stream `generateContent` whose first `inlineData` part is the
 * image (see `antigravityImageWire`). Capability is fail-closed with the same
 * bootstrap-eligible semantics as codex: unknown entitlement + unverified
 * protocol allows ONE real upstream attempt, and no text-route success or
 * configuration toggle ever upgrades image capability.
 */

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
import { getAntigravityProjectResolver } from '@omnicross/core/auth/GeminiCodeAssistProjectResolver';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import type { AuthStrategy } from '../auth';
import {
  antigravityAspectRatioFor,
  ANTIGRAVITY_IMAGE_URL,
  buildAntigravityImageRequest,
  parseAntigravityImageResponse,
  readAntigravityImageResponseBody,
} from './antigravityImageWire';
import { mapCandidateCodexImageFailure } from './privateWireErrors';
import {
  createAntigravityImageAdapterEvidence,
  ANTIGRAVITY_IMAGE_ADAPTER_VALUES,
  type AntigravityImageCapabilityEvidence,
  type AntigravityImageCapabilityEvidenceSource,
  UnknownAntigravityImageCapabilityEvidenceSource,
} from './antigravityImageEvidence';
import type {
  ImageExecutionScheduler,
  ImageExecutionSchedulerGrant,
} from './ImageExecutionScheduler';

export interface AntigravitySubscriptionImageProviderOptions {
  readonly authStrategy: AuthStrategy;
  readonly evidenceSource?: AntigravityImageCapabilityEvidenceSource;
  readonly executionScheduler?: ImageExecutionScheduler;
  readonly generationTimeoutMs?: number;
  readonly now?: () => number;
}

const PROVIDER_ID = 'antigravity-subscription';

/**
 * The model id account selection resolves against in `acquire` — the lease is
 * minted before the request model is known (same limitation as the codex
 * carrier-model constant). A gemini image model routes account-allowance
 * gating to the correct (google) counter family.
 */
const SELECTION_MODEL = 'gemini-2.5-flash-image';

function traceAccountFingerprint(accountId: string): string {
  return `sha256:${createHash('sha256').update(accountId, 'utf8').digest('hex')}`;
}

function failed(error: ImageGenerationError): ImageProviderFailedEvent {
  return { type: 'failed', error: serializeImageGenerationError(error) };
}

class AntigravitySubscriptionImageProvider implements ImageProvider {
  readonly id = PROVIDER_ID;
  readonly #auth: AuthStrategy;
  readonly #evidence: AntigravityImageCapabilityEvidenceSource;
  readonly #executionScheduler?: ImageExecutionScheduler;
  readonly #generationTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: AntigravitySubscriptionImageProviderOptions) {
    this.#auth = options.authStrategy;
    this.#evidence = options.evidenceSource ?? new UnknownAntigravityImageCapabilityEvidenceSource();
    this.#executionScheduler = options.executionScheduler;
    this.#generationTimeoutMs = options.generationTimeoutMs ?? 180_000;
    this.#now = options.now ?? Date.now;
  }

  async acquire(context: ImageProviderContext): Promise<ImageProviderLease> {
    if (context.signal.aborted) throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    if (this.#auth.providerId !== 'antigravity') throw new ImageGenerationError('upstream_auth_required');

    let selectedAccountId: string | undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    try {
      await this.#auth.applyHeaders(headers, {
        upstreamUrl: ANTIGRAVITY_IMAGE_URL,
        resolvedModel: SELECTION_MODEL,
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
    const bearer = (headers.Authorization ?? headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!selectedAccountId || !/^Bearer\s+\S+$/i.test(headers.Authorization ?? '')) {
      headers.Authorization = '';
      throw new ImageGenerationError('upstream_auth_required');
    }
    if (context.signal.aborted) {
      headers.Authorization = '';
      selectedAccountId = undefined;
      throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    }

    // The project handshake uses the SAME account's bearer (the resolver's
    // cache is keyed by token, so cross-account reuse cannot occur).
    let project: string | undefined;
    try {
      project = await getAntigravityProjectResolver().resolveProject(bearer);
    } catch {
      project = undefined;
    }

    let evidence: AntigravityImageCapabilityEvidence;
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
        account: { kind: 'account', source: 'antigravity-image-evidence-source-failed' },
        upstream: { kind: 'upstream', source: 'antigravity-image-evidence-source-failed' },
      };
    }
    if (context.signal.aborted) {
      headers.Authorization = '';
      selectedAccountId = undefined;
      throw new ImageGenerationError('request_cancelled', { cause: context.signal.reason });
    }
    const resolvedCapabilities = resolveImageCapabilities({
      adapter: createAntigravityImageAdapterEvidence(this.#now()),
      account: evidence.account,
      upstream: evidence.upstream,
    }, this.#now());
    const bootstrapEligible =
      evidence.account.source === 'antigravity-image-entitlement-unknown' &&
      evidence.upstream.source === 'antigravity-image-protocol-unverified';
    const capabilities: ImageCapabilities = resolvedCapabilities.available
      ? resolvedCapabilities
      : bootstrapEligible ? Object.freeze({
          ...ANTIGRAVITY_IMAGE_ADAPTER_VALUES,
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
          request.outputCompression !== undefined
        ) {
          throw new ImageGenerationError('unsupported_capability');
        }
        return this.#createJob(request, context, headers, project, selectedAccountId!);
      },
      release,
    };
  }

  #createJob(
    request: ImageProviderRequest,
    context: ImageProviderContext,
    leaseHeaders: Record<string, string>,
    project: string | undefined,
    accountId: string,
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

    const events = (async function* (self: AntigravitySubscriptionImageProvider) {
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

        let editImage: { base64: string; mimeType: string } | undefined;
        if (request.action === 'edit') {
          const asset = request.images[0]!;
          const stream = await asset.open({ signal: controller.signal });
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          const MAX_EDIT_BYTES = 50 * 1024 * 1024;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > MAX_EDIT_BYTES) throw new ImageGenerationError('image_too_large', { param: 'image' });
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
            await stream.cancel().catch(() => undefined);
          }
          const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
          editImage = { base64: merged.toString('base64'), mimeType: asset.mimeType };
          merged.fill(0);
        }
        const body = buildAntigravityImageRequest({
          model: request.model,
          prompt: request.prompt,
          project,
          ...(editImage ? { editImage } : {}),
          ...(request.size.kind === 'pixels'
            ? { aspectRatio: antigravityAspectRatioFor(request.size) }
            : {}),
        });

        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (attempt > 0) retryCount += 1;
          response = await fetchUpstream(
            ANTIGRAVITY_IMAGE_URL,
            { method: 'POST', headers: { ...leaseHeaders }, body, signal: controller.signal },
            {
              providerId: 'antigravity',
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
          const refreshedHeaders: Record<string, string> = {
            'content-type': 'application/json',
            accept: 'application/json',
          };
          await self.#auth.applyHeaders(refreshedHeaders, {
            upstreamUrl: ANTIGRAVITY_IMAGE_URL,
            resolvedModel: SELECTION_MODEL,
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
        const responseBody = await readAntigravityImageResponseBody(response);
        if (!response.ok) {
          yield failed(mapCandidateCodexImageFailure(response, responseBody));
          return;
        }
        accepted = true;
        yield { type: 'accepted' as const, acceptedAt: self.#now() };
        const image = await parseAntigravityImageResponse(responseBody);
        const completed: ImageProviderCompletedEvent<ImageAsset> = {
          type: 'completed',
          images: [{ artifact: image }],
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

/** Create the dormant, account-bound antigravity subscription image provider. */
export function createAntigravitySubscriptionImageProvider(
  options: AntigravitySubscriptionImageProviderOptions,
): ImageProvider {
  return new AntigravitySubscriptionImageProvider(options);
}
