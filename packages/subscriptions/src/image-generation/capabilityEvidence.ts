import type {
  ImageCapabilityEvidenceLayer,
  ImageCapabilityValues,
} from '@omnicross/contracts/image-generation-types';

/** Safe evidence request; accountId is trusted-process input and must not be logged. */
export interface CodexImageCapabilityEvidenceRequest {
  readonly accountId: string;
  readonly signal: AbortSignal;
}

export interface CodexImageCapabilityEvidence {
  readonly account: ImageCapabilityEvidenceLayer;
  readonly upstream: ImageCapabilityEvidenceLayer;
  /** Enable only when these response fields have separate verified provenance. */
  readonly verifiedResponseFields?: {
    readonly usage?: boolean;
    readonly revisedPrompt?: boolean;
  };
}

export interface CodexImageCapabilityEvidenceSource {
  resolve(request: CodexImageCapabilityEvidenceRequest): Promise<CodexImageCapabilityEvidence>;
}

/**
 * Local adapter implementation limits. These are not entitlement/protocol
 * claims; the account and observed-upstream layers must independently agree.
 */
export const CODEX_IMAGE_ADAPTER_VALUES: ImageCapabilityValues = {
  available: true,
  models: ['gpt-image-2'],
  generate: true,
  edit: false,
  maskEdit: false,
  maxInputImages: 0,
  maxOutputImages: 1,
  streaming: false,
  maxPartialImages: 0,
  transparentBackground: false,
  flexibleSizes: true,
  outputFormats: ['png', 'jpeg', 'webp'],
  responsesTool: false,
  multiTurnEdit: false,
  supportsFileId: false,
  supportsImageUrl: false,
};

export function createCodexImageAdapterEvidence(now = Date.now()): ImageCapabilityEvidenceLayer {
  return {
    kind: 'adapter',
    source: 'codex-image-adapter-declaration',
    verifiedAt: now,
    values: CODEX_IMAGE_ADAPTER_VALUES,
  };
}

/** Production-safe default: no model name, config toggle, or text success upgrades it. */
export class UnknownCodexImageCapabilityEvidenceSource
  implements CodexImageCapabilityEvidenceSource
{
  async resolve(_request: CodexImageCapabilityEvidenceRequest): Promise<CodexImageCapabilityEvidence> {
    return {
      account: { kind: 'account', source: 'codex-image-entitlement-unknown' },
      upstream: { kind: 'upstream', source: 'codex-image-protocol-unverified' },
    };
  }
}
