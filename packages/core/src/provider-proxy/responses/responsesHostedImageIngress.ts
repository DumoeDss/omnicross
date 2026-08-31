import type {
  ResponsesHostedToolSelection,
  ResponsesImageAdmission,
  ResponsesImageInspectionInput,
  ResponsesImageRequestScope,
} from '../../image-generation/responses';

import type { ResponsesAffinityHostedImageState } from './responsesAffinity';
import type { ResponsesProfile } from './responsesProfile';

export interface ResponsesHostedImageOpenRequestInput {
  readonly admission: ResponsesImageAdmission;
  readonly tenantId: string;
  readonly requestId: string;
  readonly sessionKey: string;
  readonly signal: AbortSignal;
  readonly authorizedPreviousResponseId?: string;
  /** Derived only from the authorized affinity record, never from request input. */
  readonly authorizedPreviousResponseKnownEmpty?: boolean;
  readonly mainProviderId: string;
  readonly selectedMainAccountId?: string;
}

/** Structural app-session port implemented by the daemon's pinned image generation. */
export interface ResponsesHostedImageRuntimeLease {
  readonly generationId: string;
  inspectRequest(input: ResponsesImageInspectionInput): ResponsesImageAdmission;
  validateSelection(
    admission: ResponsesImageAdmission,
    selection: ResponsesHostedToolSelection,
  ): void;
  openRequest(input: ResponsesHostedImageOpenRequestInput): Promise<ResponsesImageRequestScope>;
  release(): Promise<void>;
}

/** Dormant until an admitted Responses request explicitly acquires it. */
export interface ResponsesHostedImageRuntimeFactory {
  acquire(): Promise<ResponsesHostedImageRuntimeLease>;
}

export interface ResponsesHostedImagePrepareInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly profile: ResponsesProfile;
  readonly operation: 'create' | 'compact';
  readonly hostedImageGenerationAllowed: boolean;
  readonly tenantId?: string;
  readonly sessionKey: string;
  readonly authorizedPreviousResponseId?: string;
  readonly previousHostedImageState?: ResponsesAffinityHostedImageState;
  readonly mainProviderId: string;
  readonly signal: AbortSignal;
}

export interface ResponsesHostedImageWrapInput {
  readonly response: Response;
  readonly rawStatus: number | null;
  readonly selectedMainAccountId?: string;
  readonly onTerminalSuccess: (
    responseId: string,
    state: ResponsesAffinityHostedImageState,
  ) => void | Promise<void>;
}

export interface ResponsesHostedImageRequestLease {
  readonly upstreamBody: Record<string, unknown>;
  wrapUpstreamResponse(input: ResponsesHostedImageWrapInput): Promise<Response>;
  dispose(): Promise<void>;
}

/** Deep Native Responses mediator; ingress owns only prepare/wrap/dispose composition. */
export interface ResponsesHostedImageIngress {
  prepare(
    input: ResponsesHostedImagePrepareInput,
  ): Promise<ResponsesHostedImageRequestLease | null>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Cheap ownership predicate; full validation stays inside the injected mediator. */
export function hasResponsesHostedImageWork(
  body: Readonly<Record<string, unknown>>,
  previousState?: ResponsesAffinityHostedImageState,
): boolean {
  if (previousState?.hasImageContext || previousState?.pendingReceipts.length) return true;
  if (
    Array.isArray(body.tools) &&
    body.tools.some((tool) => record(tool) && tool.type === 'image_generation')
  ) {
    return true;
  }
  if (record(body.tool_choice) && body.tool_choice.type === 'image_generation') return true;
  return Array.isArray(body.input) && body.input.some(
    (item) => record(item) && item.type === 'image_generation_call',
  );
}
