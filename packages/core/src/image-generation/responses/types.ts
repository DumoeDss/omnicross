import type {
  ImageBackground,
  ImageGenerationPublicError,
  ImageOutputFormat,
  ImageQuality,
  ImageReferenceId,
  ImageSize,
} from '@omnicross/contracts/image-generation-types';

import type { ImageOrchestrator } from '../ImageOrchestrator';
import type { ImageReferenceStore } from '../ports';
import type { ResponsesImageStateStore } from './ResponsesImageStateStore';

export type ResponsesImageAction = 'auto' | 'generate' | 'edit';
export type ResponsesImageCallId = `ig_${string}`;

export interface ResponsesImageInspectionInput {
  readonly tools?: unknown;
  readonly tool_choice?: unknown;
  readonly stream?: unknown;
  readonly previous_response_id?: unknown;
  readonly input?: unknown;
}

export interface ResponsesImageNormalizedOptions {
  readonly action: ResponsesImageAction;
  readonly quality: ImageQuality;
  readonly size: ImageSize;
  readonly background: ImageBackground;
  readonly outputFormat: ImageOutputFormat;
  readonly outputCompression?: number;
  readonly partialImages: number;
}

export type ResponsesImageSelectionPolicy =
  | { readonly kind: 'auto' }
  | { readonly kind: 'required' }
  | { readonly kind: 'none' }
  | { readonly kind: 'forced_image' }
  | {
      readonly kind: 'forced_other';
      readonly toolType: string;
      readonly toolName?: string;
    };

/**
 * Closed identity for one non-image declaration. The declaration index is the
 * trust anchor: selected plans cannot invent a type/name or select one
 * declaration more than once.
 */
export interface ResponsesHostedToolIdentity {
  readonly declarationIndex: number;
  readonly type: string;
  readonly name?: string;
}

export interface ResponsesImageAdmission {
  readonly declared: boolean;
  readonly imageToolIndex?: number;
  readonly otherToolCount: number;
  readonly otherTools: readonly ResponsesHostedToolIdentity[];
  readonly stream: boolean;
  readonly previousResponseId?: string;
  readonly explicitCallIds: readonly ResponsesImageCallId[];
  readonly selectionPolicy: ResponsesImageSelectionPolicy;
  readonly options?: ResponsesImageNormalizedOptions;
}

export interface ResponsesSelectedImageCall {
  readonly prompt: string;
}

export interface ResponsesHostedToolSelection {
  readonly imageCalls: readonly ResponsesSelectedImageCall[];
  readonly otherToolCount: number;
  readonly otherTools: readonly ResponsesHostedToolIdentity[];
}

export interface ResponsesImageEventAllocator {
  reserveOutputIndex(): number;
  nextSequenceNumber(): number;
}

export interface ResponsesImageCallBinding {
  readonly callId: ResponsesImageCallId;
  readonly referenceId: ImageReferenceId;
  readonly expiresAt: number;
}

export interface ResponsesImageGenerationCallItem {
  readonly id: ResponsesImageCallId;
  readonly type: 'image_generation_call';
  readonly status: 'completed';
  readonly result: string;
  readonly revised_prompt?: string;
}

export interface ResponsesImagePartialEvent {
  readonly type: 'response.image_generation_call.partial_image';
  readonly output_index: number;
  readonly item_id: ResponsesImageCallId;
  readonly sequence_number: number;
  readonly partial_image_index: number;
  readonly partial_image_b64: string;
}

/** Internal terminal record; the integrator owns official terminal SSE events. */
export interface ResponsesImageCompletedRecord {
  readonly kind: 'completed';
  readonly outputIndex: number;
  readonly item: ResponsesImageGenerationCallItem;
}

/** Internal failure record for the integrator's normal Responses error path. */
export interface ResponsesImageFailedRecord {
  readonly kind: 'failed';
  readonly outputIndex?: number;
  readonly callId?: ResponsesImageCallId;
  readonly error: ImageGenerationPublicError;
}

export type ResponsesImageExecutionEvent =
  | ResponsesImagePartialEvent
  | ResponsesImageCompletedRecord
  | ResponsesImageFailedRecord;

export interface ResponsesImageTrustedRuntime {
  readonly tenantId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly imageModel: string;
  readonly referenceTtlMs: number;
  readonly maxOutputBytes: number;
  readonly maxTotalOutputBytes: number;
  readonly signal: AbortSignal;
  readonly sessionKey?: string;
  readonly preferredAccountId?: string;
  readonly preferredAccountGroup?: string;
}

export interface ResponsesImageRequestScopeInput {
  readonly admission: ResponsesImageAdmission;
  readonly runtime: ResponsesImageTrustedRuntime;
  /** Must already be authorized by the existing Responses affinity boundary. */
  readonly authorizedPreviousResponseId?: string;
}

export interface ResponsesImageRequestScope {
  executeSelectedCall(
    call: ResponsesSelectedImageCall,
    allocator: ResponsesImageEventAllocator,
  ): AsyncIterable<ResponsesImageExecutionEvent>;
  commit(responseId: string): Promise<void>;
  dispose(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ResponsesImageGenerationContributionDeps {
  readonly orchestrator: ImageOrchestrator;
  readonly stateStore: ResponsesImageStateStore;
  /** Must be the same store injected into the orchestrator. */
  readonly referenceStore: ImageReferenceStore;
  readonly createCallId?: () => ResponsesImageCallId;
  readonly now?: () => number;
}

export interface ResponsesImageGenerationContribution {
  readonly toolType: 'image_generation';
  inspectRequest(input: ResponsesImageInspectionInput): ResponsesImageAdmission;
  validateSelection(
    admission: ResponsesImageAdmission,
    selection: ResponsesHostedToolSelection,
  ): void;
  createRequestScope(input: ResponsesImageRequestScopeInput): Promise<ResponsesImageRequestScope>;
}
